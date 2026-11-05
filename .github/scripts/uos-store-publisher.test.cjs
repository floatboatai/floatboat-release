#!/usr/bin/env node
// ABOUTME: 验证 UOS 发布状态机的双架构、幂等恢复、冲突和脱敏回执。

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  JsonPublicationJournal,
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
    async getApplicationTemplate(versionId) {
      calls.push('template');
      templateVersionIds.push(versionId);
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
  assert.doesNotMatch(JSON.stringify(receipt), /very-secret|file_save_key|uploaded-amd64/iu);
  assert.doesNotMatch(fs.readFileSync(harness.journalPath, 'utf8'), /fileSaveKey|uploaded-amd64/iu);
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
