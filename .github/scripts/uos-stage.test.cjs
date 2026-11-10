// ABOUTME: 验证 UOS 审核下载只发布当前运行重验的内容，并拒绝 S3 覆盖及 CDN 字节不一致。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { buildUosPublicationManifest, sha256 } = require('./uos-publication-manifest.cjs');
const { buildStagePlan, ensureImmutableObject, verifyCdnObject, publishStage, UosStageError } = require('./uos-stage.cjs');

function tar(entries) {
  const blocks = [];
  for (const [name, value] of entries) {
    const bytes = Buffer.from(value); const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    for (const [offset, length, number] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]]) {
      header.write(`${number.toString(8).padStart(length - 1, '0')}\0`, offset, length);
    }
    header.fill(0x20, 148, 156); header[156] = 0x30;
    header.write('ustar\0', 257); header.write('00', 263);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
function deb(arch) {
  const root = 'opt/apps/com.floatboat.desktop'; const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf); elf.writeUInt16LE(arch === 'amd64' ? 62 : 183, 18);
  const members = [['debian-binary', Buffer.from('2.0\n')],
    ['control.tar.gz', zlib.gzipSync(tar([['control', `Package: com.floatboat.desktop\nVersion: 0.6.3.6\nArchitecture: ${arch}\nDepends: libc6\n`]]))],
    ['data.tar.gz', zlib.gzipSync(tar([
      [`${root}/info`, JSON.stringify({ appid: 'com.floatboat.desktop', version: '0.6.3.6', arch: [arch] })],
      [`${root}/files/resources/uos-app-store.json`, JSON.stringify({ appid: 'com.floatboat.desktop' })],
      [`${root}/entries/applications/com.floatboat.desktop.desktop`, '[Desktop Entry]\nExec=/opt/apps/com.floatboat.desktop/files/floatboat\n'],
      [`${root}/files/floatboat`, elf],
    ]))]];
  const blocks = [Buffer.from('!<arch>\n')];
  for (const [name, bytes] of members) {
    blocks.push(Buffer.from(`${`${name}/`.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(bytes.length).padEnd(10)}\`\n`), bytes);
    if (bytes.length % 2) blocks.push(Buffer.from('\n'));
  }
  return Buffer.concat(blocks);
}
function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uos-stage-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, 'artifacts'); fs.mkdirSync(artifactsDir);
  for (const arch of ['amd64', 'arm64']) {
    fs.writeFileSync(path.join(artifactsDir, `Floatboat-0.6.3-rc.6-${arch}.deb`), deb(arch));
    fs.writeFileSync(path.join(artifactsDir, `Floatboat-0.6.3-rc.6-${arch}-dependency-audit.json`), JSON.stringify({
      appid: 'com.floatboat.desktop', version: '0.6.3.6', arch, neededLibraries: [{ soname: 'libc.so.6' }],
      depends: ['libc6'], systemLibraries: [{ soname: 'libc.so.6', package: 'libc6' }], bundledLibraries: [], optionalLibraries: [],
    }));
  }
  const expected = { repository: 'floatboatai/floatboat-release', sourceSha: 'a'.repeat(40), releaseVersion: '0.6.3-rc.6', currentRunId: '200' };
  const manifest = buildUosPublicationManifest({ artifactsDir, releaseVersion: expected.releaseVersion, sourceSha: expected.sourceSha, runId: '200', runAttempt: 2 });
  const manifestPath = path.join(artifactsDir, 'uos-publication-manifest.json');
  const write = (value) => { fs.writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`); return sha256(fs.readFileSync(manifestPath)); };
  return { root, artifactsDir, expected, manifest, manifestPath, currentRunAttempt: 2, manifestRunAttempt: 2, manifestSha256: write(manifest), write };
}
function remote(object) {
  return { ContentLength: object.size, ChecksumSHA256: Buffer.from(object.sha256, 'hex').toString('base64'), ChecksumType: 'FULL_OBJECT' };
}
function sourceProof() {
  return { repository: 'floatboatai/floatboat-release', runId: '100', sourceValidationAttempt: 2, workflowSha: 'b'.repeat(40),
    manifestArtifactId: '1000', manifestArtifactDigest: `sha256:${'c'.repeat(64)}`, manifestSha256: 'd'.repeat(64),
    packageArtifactIds: { x64: '1001', arm64: '1002' }, packageArtifactDigests: { x64: `sha256:${'e'.repeat(64)}`, arm64: `sha256:${'f'.repeat(64)}` } };
}

test('普通当前运行双包完整重验并使用四段版本、源码SHA和完整内容SHA生成固定下载地址', (context) => {
  const f = fixture(context); const plan = buildStagePlan(f);
  assert.equal(plan.appid, 'com.floatboat.desktop');
  assert.deepEqual(plan.github, { runId: '200', runAttempt: 2 });
  assert.equal(plan.packages.length, 2);
  for (const object of [...plan.packages, plan.manifest]) {
    assert.equal(object.url, `https://release.aoe.chat/uos/review/0.6.3.6/${'a'.repeat(40)}/${object.sha256}/${object.filename}`);
    assert.equal(object.sha256, sha256(fs.readFileSync(object.filePath)));
  }
  assert.throws(() => buildStagePlan({ ...f, manifestSha256: '0'.repeat(64) }), /manifest_digest_mismatch/u);
  assert.throws(() => buildStagePlan({ ...f, expected: { ...f.expected, currentRunId: '201' } }), /manifest_content_mismatch/u);
  assert.throws(() => buildStagePlan({ ...f, expected: { ...f.expected, sourceSha: 'b'.repeat(40) } }), /manifest_content_mismatch/u);
  fs.appendFileSync(plan.packages[0].filePath, 'changed');
  assert.throws(() => buildStagePlan(f));
});

test('复用清单保留来源证明，源run和当前run不能互相替代', (context) => {
  const f = fixture(context); const manifest = { ...f.manifest, buildSource: sourceProof() };
  const input = { ...f, manifestSha256: f.write(manifest), expected: { ...f.expected, runId: '100' } };
  assert.deepEqual(buildStagePlan(input).buildSource, sourceProof());
  assert.throws(() => buildStagePlan({ ...input, expected: { ...input.expected, runId: '101' } }), /source_run_mismatch/u);
  const incorrect = { ...manifest, github: { runId: '100', runAttempt: 2 } };
  assert.throws(() => buildStagePlan({ ...input, manifestSha256: f.write(incorrect) }), /manifest_content_mismatch/u);
});

test('staging 重跑保留清单生成身份并单独记录执行身份，拒绝非可信或未来清单', async (context) => {
  const f = fixture(context);
  const manifest = { ...f.manifest, buildSource: sourceProof() };
  const input = { ...f, manifestSha256: f.write(manifest), currentRunAttempt: 3, expected: { ...f.expected, runId: '100' } };
  const metadataPath = path.join(f.artifactsDir, 'uos-build-source.json');
  fs.writeFileSync(metadataPath, JSON.stringify({ schemaVersion: 1, buildSource: manifest.buildSource,
    releaseVersion: manifest.releaseVersion, packageVersion: manifest.packageVersion,
    sourceSha: manifest.sourceSha, packages: manifest.packages }));
  input.metadataSha256 = sha256(fs.readFileSync(metadataPath));
  const plan = buildStagePlan(input);
  assert.deepEqual(plan.github, { runId: '200', runAttempt: 2 });
  assert.deepEqual(plan.executionGithub, { runId: '200', runAttempt: 3 });
  assert.deepEqual(plan.buildSource, sourceProof());
  const published = await publishStage(plan, { indexPath: path.join(f.root, 'index.json'),
    aws: async (args) => {
      if (args[1] === 'create-invalidation') return {};
      const object = [...plan.packages, plan.manifest].find((item) => item.key === args[args.indexOf('--key') + 1]);
      if (object) return remote(object);
      const bytes = fs.readFileSync(path.join(f.root, 'index.json'));
      return { ContentLength: bytes.length, ChecksumSHA256: Buffer.from(sha256(bytes), 'hex').toString('base64') };
    },
    fetchImpl: async (url) => {
      const object = [...plan.packages, plan.manifest].find((item) => item.url === url);
      return new Response(fs.readFileSync(object?.filePath || path.join(f.root, 'index.json')));
    },
  });
  assert.deepEqual(published.index.executionGithub, { runId: '200', runAttempt: 3 });
  assert.deepEqual(published.index.github, manifest.github);
  for (const change of [
    { manifestRunAttempt: undefined }, { manifestRunAttempt: 1 }, { manifestRunAttempt: 0 },
    { manifestRunAttempt: 2.5 }, { currentRunAttempt: 1 }, { currentRunAttempt: NaN },
  ]) assert.throws(() => buildStagePlan({ ...input, ...change }), /manifest_run_identity_mismatch/);
});

test('staging CLI 从可信上游环境读取生成 attempt，缺失时在 AWS 访问前失败', (context) => {
  const f = fixture(context);
  const env = { ...process.env, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: f.expected.repository, GITHUB_RUN_ID: '200', GITHUB_RUN_ATTEMPT: '3',
    UOS_SOURCE_SHA: f.expected.sourceSha, UOS_RELEASE_VERSION: f.expected.releaseVersion, UOS_REUSE_RUN_ID: '',
    UOS_BUILD_SOURCE_SHA256: '', UOS_STAGE_MANIFEST_SHA256: f.manifestSha256, UOS_PUBLICATION_MANIFEST_RUN_ATTEMPT: '2' };
  const accepted = spawnSync(process.execPath, [require.resolve('./uos-stage.cjs'), 'verify', f.artifactsDir, f.manifestPath],
    { env, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /UOS_STAGE_VERIFIED/);
  const rejected = spawnSync(process.execPath, [require.resolve('./uos-stage.cjs'), 'publish', f.artifactsDir, f.manifestPath,
    path.join(f.root, 'unexpected-index.json')], { env: { ...env, UOS_PUBLICATION_MANIFEST_RUN_ATTEMPT: '' }, encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /manifest_run_identity_mismatch/);
  assert.equal(fs.existsSync(path.join(f.root, 'unexpected-index.json')), false);
});

test('S3同名正确内容复用，不同大小、摘要或多段摘要都拒绝且不覆盖', async (context) => {
  const object = buildStagePlan(fixture(context)).packages[0];
  const calls = [];
  assert.equal(await ensureImmutableObject(object, async (args) => { calls.push(args); return remote(object); }), 'reused');
  assert.equal(calls.length, 1); assert.ok(calls[0].includes('--checksum-mode'));
  for (const wrong of [{ ...remote(object), ContentLength: object.size + 1 }, { ...remote(object), ChecksumSHA256: 'wrong' }, { ContentLength: object.size }, { ...remote(object), ChecksumType: 'COMPOSITE' }]) {
    let count = 0;
    await assert.rejects(ensureImmutableObject(object, async () => { count += 1; return wrong; }), /s3_content_mismatch/u);
    assert.equal(count, 1);
  }
  let callsDenied = 0;
  await assert.rejects(ensureImmutableObject(object, async () => { callsDenied += 1; throw new UosStageError('aws_failed'); }), /aws_failed/u);
  assert.equal(callsDenied, 1);
});

test('S3缺失对象仅条件写入，处理并发获胜者时仍核对完整摘要', async (context) => {
  const object = buildStagePlan(fixture(context)).packages[0];
  for (const conflict of [null, 's3_precondition', 's3_conflict']) {
    const calls = [];
    await ensureImmutableObject(object, async (args) => {
      calls.push(args);
      if (calls.length === 1) throw new UosStageError('s3_not_found');
      if (args[1] === 'put-object') { if (conflict) throw new UosStageError(conflict); return {}; }
      return remote(object);
    });
    const put = calls.find((args) => args[1] === 'put-object');
    assert.equal(put[put.indexOf('--if-none-match') + 1], '*');
    assert.equal(put[put.indexOf('--checksum-sha256') + 1], remote(object).ChecksumSHA256);
    assert.equal(calls.filter((args) => args[1] === 'head-object').length, 2);
  }
});

test('CDN必须GET全部原始字节并验hash，拒绝相同长度篡改、重定向及截断', async (context) => {
  const object = buildStagePlan(fixture(context)).packages[0]; const bytes = fs.readFileSync(object.filePath);
  await verifyCdnObject(object, { fetchImpl: async (url, options) => {
    assert.equal(url, object.url); assert.equal(options.redirect, 'error'); assert.equal(options.headers['accept-encoding'], 'identity');
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  } });
  for (const response of [new Response(Buffer.alloc(bytes.length)), new Response(bytes.subarray(1)), new Response(null, { status: 302 }), new Response(bytes, { headers: { 'content-encoding': 'gzip' } })]) {
    await assert.rejects(verifyCdnObject(object, { fetchImpl: async () => response }), /cdn_/u);
  }
});

test('完整发布生成Desktop固定索引，仅变更审核内容地址且全部CDN验证后返回', async (context) => {
  const f = fixture(context); const plan = buildStagePlan(f); const calls = []; const saved = new Map(); const downloads = [];
  const indexPath = path.join(f.root, 'uos-review-downloads.json');
  const result = await publishStage(plan, { indexPath, wait: async () => {}, aws: async (args) => {
    calls.push(args);
    if (args[0] === 'cloudfront') return { Invalidation: { Id: 'fixture' } };
    const key = args[args.indexOf('--key') + 1];
    if (args[1] === 'put-object') {
      saved.set(key, fs.readFileSync(args[args.indexOf('--body') + 1])); return {};
    }
    if (!saved.has(key)) throw new UosStageError('s3_not_found');
    const bytes = saved.get(key); return { ContentLength: bytes.length, ChecksumSHA256: Buffer.from(sha256(bytes), 'hex').toString('base64'), ChecksumType: 'FULL_OBJECT' };
  }, fetchImpl: async (url) => { downloads.push(url); return new Response(saved.get(new URL(url).pathname.slice(1))); } });
  assert.equal(downloads.length, 4);
  assert.equal(result.index.appid, 'com.floatboat.desktop');
  assert.equal(result.index.manifestUrl, plan.manifest.url);
  assert.equal(result.index.manifestSha256, plan.manifest.sha256);
  assert.deepEqual(result.index.packages.map((item) => item.arch), ['amd64', 'arm64']);
  assert.equal(result.indexSha256, sha256(fs.readFileSync(indexPath)));
  assert.deepEqual(JSON.parse(fs.readFileSync(indexPath)), result.index);
  assert.ok(result.indexUrl.endsWith(`/${result.indexSha256}/uos-review-downloads.json`));
  assert.equal(saved.size, 4);
  for (const key of saved.keys()) assert.match(key, /^uos\/review\/0\.6\.3\.6\/[a-f0-9]{40}\/[a-f0-9]{64}\//u);
  const invalidation = calls.find((args) => args[0] === 'cloudfront');
  assert.ok(invalidation.includes('EOFLQQ0A8KCX1')); assert.equal(invalidation.some((arg) => arg.includes('*')), false);
  assert.equal(JSON.stringify(result.index).includes('filePath'), false);
});
