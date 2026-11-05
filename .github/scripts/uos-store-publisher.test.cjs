#!/usr/bin/env node
// ABOUTME: 验证 UOS 发布状态机的双架构、幂等恢复、冲突和脱敏回执。

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UosStoreApiClient } = require('./uos-store-api-client.cjs');

const {
  JsonPublicationJournal,
  createReceipt,
  publishUosStore,
  validateRuntimeIdentity,
} = require('./uos-store-publisher.cjs');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createHarness(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uos-publisher-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packages = ['amd64', 'arm64'].map((arch) => {
    const filename = `Floatboat-0.6.3-${arch}.deb`;
    const bytes = Buffer.from(`package-${arch}`);
    fs.writeFileSync(path.join(root, filename), bytes);
    return { arch, filename, sha256: sha256(bytes), size: bytes.length };
  });
  const manifest = {
    schemaVersion: 1,
    appid: 'com.floatboat.desktop',
    releaseVersion: '0.6.3',
    packageVersion: '0.6.3.0',
    sourceSha: 'a'.repeat(40),
    github: { runId: '123', runAttempt: 1 },
    generatedAt: '2026-11-02T00:00:00.000Z',
    packages,
  };
  const calls = [];
  const templateVersionIds = [];
  const templateApplicationIds = [];
  const inspectStates = [...(options.inspectStates || ['absent', 'submitted'])];
  const client = {
    async authenticate() { calls.push('authenticate'); },
    async resolveApplicationRecord() {
      calls.push('resolve-app');
      return { appId: 'stable-app', currentVersionId: 'current-version' };
    },
    async inspectPublication() {
      calls.push('inspect');
      const state = inspectStates.length > 1 ? inspectStates.shift() : inspectStates[0];
      if (state === 'uploaded' || state === 'partial-uploaded') {
        return {
          state,
          versionId: 'target-version',
          packages: packages.slice(0, state === 'partial-uploaded' ? 1 : 2).map((item) => ({
            pkg_arch: item.arch,
            pkg_name: 'com.floatboat.desktop',
            pkg_version: '0.6.3.0',
            sha256: item.sha256,
            file_save_key: `remote-${item.arch}`,
          })),
        };
      }
      return { state };
    },
    async getApplicationTemplate(versionId, appId) {
      calls.push('template');
      templateVersionIds.push(versionId);
      templateApplicationIds.push(appId);
      return { app_info: { app_basic_info: { app_id: 'com.floatboat.desktop' }, app_origin_pkgs: [] } };
    },
    async detectPackage(filePath) {
      const arch = filePath.includes('amd64') ? 'amd64' : 'arm64';
      calls.push(`detect-${arch}`);
      return { pkg_name: 'com.floatboat.desktop', pkg_version: '0.6.3.0', pkg_arch: arch };
    },
    async uploadPackage(filePath) {
      const arch = filePath.includes('amd64') ? 'amd64' : 'arm64';
      calls.push(`upload-${arch}`);
      return { file_save_key: `uploaded-${arch}` };
    },
    prepareSubmission(_template, packageRows) {
      calls.push('prepare');
      return { operate_type: 52, app_info: { app_origin_pkgs: packageRows } };
    },
    async submitApplication() {
      calls.push('submit');
      if (options.submitError) throw options.submitError;
      return { accepted: true };
    },
  };
  return {
    root,
    manifest,
    calls,
    templateVersionIds,
    templateApplicationIds,
    client,
    journalPath: path.join(root, 'private', 'journal.json'),
  };
}

async function runHarness(harness) {
  return publishUosStore({
    manifest: harness.manifest,
    artifactsDir: harness.root,
    credentials: { username: 'internal-user', password: 'very-secret' },
    client: harness.client,
    journalStore: new JsonPublicationJournal(harness.journalPath),
    now: () => '2026-11-02T00:00:00.000Z',
    readbackAttempts: 2,
    wait: async () => {},
  });
}

test('双架构全部上传后只提交一次并回读确认', async (context) => {
  const harness = createHarness(context);
  const receipt = await runHarness(harness);
  assert.equal(receipt.status, 'submitted');
  assert.deepEqual(harness.calls, [
    'authenticate', 'resolve-app', 'inspect', 'template',
    'detect-amd64', 'upload-amd64', 'detect-arm64', 'upload-arm64',
    'prepare', 'submit', 'inspect',
  ]);
  assert.equal(harness.calls.filter((item) => item === 'submit').length, 1);
  assert.deepEqual(harness.templateApplicationIds, ['stable-app']);
  assert.doesNotMatch(JSON.stringify(receipt), /very-secret|file_save_key|uploaded-amd64/iu);
  assert.doesNotMatch(fs.readFileSync(harness.journalPath, 'utf8'), /fileSaveKey|uploaded-amd64/iu);
});

test('实际分片 PUT 被拒绝后发布器不完成上传、不关联也不提交审核', async (context) => {
  const harness = createHarness(context);
  const calls = [];
  const api = new UosStoreApiClient({
    baseUrl: 'https://store.example.test',
    fetchImpl: async (url, options) => {
      calls.push(options.method);
      assert.equal(url, 'https://uploads.example.test/package?signature=private-signature');
      return new Response('private response content', { status: 403 });
    },
  });
  api.requestJson = async (_method, endpoint) => {
    calls.push(endpoint);
    assert.equal(endpoint, '/store-file/upload/begin');
    return { upload_infos: [{ upload_url: 'https://uploads.example.test/package?signature=private-signature' }] };
  };
  harness.client.uploadPackage = api.uploadPackage.bind(api);
  await assert.rejects(runHarness(harness), (error) => {
    assert.equal(error.code, 'UOS_UPLOAD_FAILED');
    assert.equal(error.retryable, false);
    assert.match(error.message, /http_rejected/u);
    assert.match(error.message, /HTTP 403/u);
    assert.doesNotMatch(error.message, /private|https|signature/u);
    return true;
  });
  assert.deepEqual(calls, ['/store-file/upload/begin', 'PUT']);
  assert.deepEqual(harness.calls, ['authenticate', 'resolve-app', 'inspect', 'template', 'detect-amd64']);
});

test('复用成品回执保留源构建证据，当前运行身份不被覆盖', async (context) => {
  const harness = createHarness(context);
  harness.manifest.buildSource = {
    repository: 'floatboatai/floatboat-release', runId: '101', sourceValidationAttempt: 2,
    workflowSha: 'b'.repeat(40), manifestArtifactId: '1000', manifestArtifactDigest: `sha256:${'1'.repeat(64)}`,
    manifestSha256: '2'.repeat(64), packageArtifactIds: { x64: '1001', arm64: '1002' },
    packageArtifactDigests: { x64: `sha256:${'3'.repeat(64)}`, arm64: `sha256:${'4'.repeat(64)}` },
  };
  const receipt = await runHarness(harness);
  assert.deepEqual(receipt.github, { runId: '123', runAttempt: 1 });
  assert.deepEqual(receipt.buildSource, harness.manifest.buildSource);
  harness.manifest.buildSource.privateField = 'private-signature';
  const failedReceipt = createReceipt(harness.manifest, { status: 'failed' });
  assert.equal(failedReceipt.buildSource, undefined);
  assert.doesNotMatch(JSON.stringify(failedReceipt), /privateField|private-signature/u);
});

test('真实模板预检在任何检测、上传和提交之前绑定商店应用身份', async (context) => {
  const harness = createHarness(context);
  const api = new UosStoreApiClient({ baseUrl: 'http://127.0.0.1' });
  api.getVersionDetail = async () => ({
    app_basic_info: { app_id: 'other-app' },
    app_origin_pkgs: [],
  });
  harness.client.getApplicationTemplate = (versionId, appId) => {
    harness.calls.push('template');
    assert.equal(versionId, 'current-version');
    assert.equal(appId, 'stable-app');
    return api.getApplicationTemplate(versionId, appId);
  };
  await assert.rejects(() => runHarness(harness), /UOS_SUBMISSION_TEMPLATE_INVALID/);
  assert.deepEqual(harness.calls, ['authenticate', 'resolve-app', 'inspect', 'template']);
});

test('发布器经真实 client 读取平铺模板、上传双架构、提交并以同版本 SHA 回读确认', async (context) => {
  const harness = createHarness(context);
  const requests = [];
  let submitted = null;
  const template = {
    app_basic_info: { app_id: 1097210, pkgInstallMode: 1, pkg_mode: 0, inAppPayment: 0 },
    app_lan_infos: [{ lan: 'zh_CN', desc_info: '已有介绍', appScreenShotList: [{ screen_shot_key: 'existing-screen' }] }],
    app_fit_info: { arch: [{ code: 4 }, { code: 3 }], system_platform: [{ code: 1 }], futureField: 'keep' },
    app_origin_pkgs: harness.manifest.packages.map((item, index) => ({
      pkg_name: 'com.floatboat.desktop', pkg_arch: index === 0 ? 4 : 3,
      pkg_version: '0.6.2.0', file_save_key: `old-${item.arch}`, supSys: '1', baseline: [{ id: index + 10 }],
    })),
  };
  harness.client = new UosStoreApiClient({
    baseUrl: 'http://127.0.0.1',
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      const route = url.pathname.replace('/devprod-api', '');
      requests.push(`${init.method} ${route}`);
      const reply = (datas) => Response.json({ status: 200, datas });
      if (route === '/store-dev-app/app' && init.method === 'GET') {
        return Response.json({ code: 200, total: 1, rows: [{ app_id: 1097210, id: 'current', pkg_name: 'com.floatboat.desktop' }] });
      }
      if (route.endsWith('/history')) {
        return Response.json({ code: 200, total: 1, rows: [{
          app_id: 1097210, id: submitted ? 'target' : 'current', pkg_version: submitted ? '0.6.3.0' : '0.6.2.0', status: submitted ? 52 : 101,
        }] });
      }
      if (route.endsWith('/detail')) return reply(submitted ? submitted.app_info : template);
      if (route.endsWith('/audit_status')) return reply({});
      if (route.endsWith('/detect-pkg-info')) {
        return reply({ pkg_name: 'com.floatboat.desktop', pkg_version: '0.6.3.0', pkg_arch: url.searchParams.get('fileName').includes('amd64') ? 4 : 3 });
      }
      if (route.endsWith('/upload/begin')) {
        const payload = JSON.parse(init.body);
        const arch = payload.fileName.includes('amd64') ? 'amd64' : 'arm64';
        return reply({ id: arch, upload_id: arch, file_save_key: `new-${arch}`, upload_infos: [{ upload_url: `http://127.0.0.1/upload/${arch}` }] });
      }
      if (init.method === 'PUT') return new Response(null, { status: 200 });
      if (route.endsWith('/upload/end')) return reply({ file_save_key: JSON.parse(init.body).file_save_key });
      if (route === '/store-dev-app/app' && init.method === 'POST') {
        submitted = JSON.parse(init.body);
        return reply({});
      }
      throw new Error(`unexpected ${init.method} ${route}`);
    },
  });
  harness.client.authenticate = async () => {};
  const receipt = await runHarness(harness);
  assert.equal(receipt.status, 'submitted');
  assert.equal(submitted.app_info.app_basic_info.app_id, 1097210);
  assert.deepEqual(submitted.app_info.app_lan_infos, template.app_lan_infos);
  assert.deepEqual(submitted.app_info.app_fit_info, template.app_fit_info);
  for (const [index, row] of submitted.app_info.app_origin_pkgs.entries()) {
    assert.equal(row.sha256, harness.manifest.packages[index].sha256);
    assert.equal(row.pkg_version, '0.6.3.0');
    assert.equal(row.supSys, '1');
    assert.deepEqual(row.baseline, template.app_origin_pkgs[index].baseline);
  }
  assert.equal(requests.filter((item) => item === 'POST /store-dev-app/app').length, 1);
  assert.ok(requests.indexOf('GET /store-dev-app/app/current/detail') < requests.indexOf('POST /store-file/upload/begin'));
  assert.ok(requests.indexOf('GET /store-dev-app/app/target/detail') > requests.indexOf('POST /store-dev-app/app'));
});

test('已提交的精确双架构版本直接幂等成功', async (context) => {
  const harness = createHarness(context, { inspectStates: ['submitted'] });
  const receipt = await runHarness(harness);
  assert.equal(receipt.idempotent, true);
  assert.deepEqual(harness.calls, ['authenticate', 'resolve-app', 'inspect']);
});

test('远端已上传的精确 SHA 被复用而不重复上传', async (context) => {
  const harness = createHarness(context, { inspectStates: ['uploaded', 'submitted'] });
  const receipt = await runHarness(harness);
  assert.equal(receipt.status, 'submitted');
  assert.equal(harness.calls.some((item) => item.startsWith('detect-')), false);
  assert.equal(harness.calls.some((item) => item.startsWith('upload-')), false);
  assert.equal(harness.calls.includes('submit'), true);
});

test('单架构已上传时只补传缺失架构，再提交同一目标版本', async (context) => {
  const harness = createHarness(context, { inspectStates: ['partial-uploaded', 'submitted'] });
  await runHarness(harness);
  assert.equal(harness.calls.includes('detect-amd64'), false);
  assert.equal(harness.calls.includes('upload-amd64'), false);
  assert.equal(harness.calls.includes('detect-arm64'), true);
  assert.equal(harness.calls.includes('upload-arm64'), true);
  assert.equal(harness.calls.filter((item) => item === 'submit').length, 1);
  assert.deepEqual(harness.templateVersionIds, ['target-version']);
});

test('已驳回版本停止自动化，不上传也不再次提交', async (context) => {
  const harness = createHarness(context, { inspectStates: ['manual-action-required'] });
  await assert.rejects(() => runHarness(harness), /UOS_REVIEW_MANUAL_ACTION_REQUIRED/);
  assert.deepEqual(harness.calls, ['authenticate', 'resolve-app', 'inspect']);
});

test('同版本不同内容在任何上传和提交前失败', async (context) => {
  const harness = createHarness(context, { inspectStates: ['conflict'] });
  await assert.rejects(() => runHarness(harness), /UOS_VERSION_CONTENT_CONFLICT/);
  assert.deepEqual(harness.calls, ['authenticate', 'resolve-app', 'inspect']);
});

test('低于商店最高版本的送审包在上传前失败', async (context) => {
  const harness = createHarness(context, { inspectStates: ['version-regression'] });
  await assert.rejects(() => runHarness(harness), /UOS_VERSION_ORDER_INVALID/);
  assert.deepEqual(harness.calls, ['authenticate', 'resolve-app', 'inspect']);
});

test('提交返回任意错误时先回读，已受理则不重复提交', async (context) => {
  const harness = createHarness(context, {
    inspectStates: ['absent', 'submitted', 'submitted'],
    submitError: new Error('malformed response after server accepted'),
  });
  const receipt = await runHarness(harness);
  assert.equal(receipt.status, 'submitted');
  assert.equal(harness.calls.filter((item) => item === 'submit').length, 1);
  assert.equal(harness.calls.filter((item) => item === 'inspect').length, 3);
});

test('manifest 的 run/source identity 必须属于当前 Secret job', () => {
  const manifest = { github: { runId: '123', runAttempt: 2 }, sourceSha: 'b'.repeat(40) };
  assert.doesNotThrow(() => validateRuntimeIdentity(manifest, { runId: '123', runAttempt: '2', sourceSha: 'b'.repeat(40) }));
  assert.throws(
    () => validateRuntimeIdentity(manifest, { runId: '124', runAttempt: '2', sourceSha: 'b'.repeat(40) }),
    /UOS_MANIFEST_RUN_IDENTITY_MISMATCH/,
  );
});
