#!/usr/bin/env node
// ABOUTME: 验证旧运行制品只有在来源、双包内容与当前发布目标一致时才能重新签入当前运行清单。

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');
const { buildUosPublicationManifest, sha256 } = require('./uos-publication-manifest.cjs');
const { validateSourceRun, selectSourceRun, restoreArtifacts, buildReusedManifest, sanitizeBuildSource } = require('./uos-artifact-reuse.cjs');

const EXPECTED = { repository: 'owner/release', runId: '100', currentRunId: '200', sourceSha: 'a'.repeat(40), releaseVersion: '0.6.3-rc.6' };

function sourceData() {
  const run = { id: 100, workflow_id: 42, path: '.github/workflows/release.yml', event: 'workflow_dispatch', head_branch: 'main',
    status: 'completed', conclusion: 'failure', run_attempt: 2, head_sha: 'b'.repeat(40),
    repository: { id: 7, full_name: EXPECTED.repository }, head_repository: { id: 7, full_name: EXPECTED.repository } };
  return {
    run, workflow: { id: 42, path: '.github/workflows/release.yml' },
    jobs: ['Prepare Release', 'Build Floatboat UOS Linux (x64)', 'Build Floatboat UOS Linux (arm64)', 'Validate UOS Store Publication']
      .map((name) => ({ name, run_id: 100, run_attempt: 2, status: 'completed', conclusion: 'success' })),
    artifacts: ['uos-linux-x64', 'uos-linux-arm64', 'uos-publication-manifest-0.6.3.6-100-2'].map((name, index) => ({
      name, id: 1000 + index, expired: false, size_in_bytes: 100, digest: `sha256:${String(index + 1).repeat(64)}`,
      workflow_run: { id: 100, repository_id: 7, head_repository_id: 7, head_branch: 'main', head_sha: run.head_sha },
    })),
  };
}

function tar(entries) {
  const blocks = [];
  for (const [name, contents] of entries) {
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) {
      header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
    }
    header.fill(0x20, 148, 156); header[156] = 0x30;
    header.write('ustar\0', 257); header.write('00', 263);
    header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function deb(arch) {
  const root = 'opt/apps/com.floatboat.desktop';
  const elf = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf);
  elf.writeUInt16LE(arch === 'amd64' ? 62 : 183, 18);
  const members = [
    ['debian-binary', Buffer.from('2.0\n')],
    ['control.tar.gz', zlib.gzipSync(tar([['control', `Package: com.floatboat.desktop\nVersion: 0.6.3.6\nArchitecture: ${arch}\nDepends: libc6\n`]]))],
    ['data.tar.gz', zlib.gzipSync(tar([
      [`${root}/info`, JSON.stringify({ appid: 'com.floatboat.desktop', version: '0.6.3.6', arch: [arch] })],
      [`${root}/files/resources/uos-app-store.json`, JSON.stringify({ appid: 'com.floatboat.desktop' })],
      [`${root}/entries/applications/com.floatboat.desktop.desktop`, '[Desktop Entry]\nExec=/opt/apps/com.floatboat.desktop/files/floatboat\n'],
      [`${root}/files/floatboat`, elf],
    ]))],
  ];
  const buffers = [Buffer.from('!<arch>\n')];
  for (const [name, data] of members) {
    const header = `${`${name}/`.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(data.length).padEnd(10)}\`\n`;
    buffers.push(Buffer.from(header), data);
    if (data.length % 2) buffers.push(Buffer.from('\n'));
  }
  return Buffer.concat(buffers);
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uos-reuse-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePackagesDir = path.join(root, 'packages');
  for (const [arch, artifactArch] of [['amd64', 'x64'], ['arm64', 'arm64']]) {
    const directory = path.join(sourcePackagesDir, artifactArch);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `Floatboat-${EXPECTED.releaseVersion}-${arch}.deb`), deb(arch));
    const audit = { appid: 'com.floatboat.desktop', version: '0.6.3.6', arch, neededLibraries: [{ soname: 'libc.so.6' }],
      depends: ['libc6'], systemLibraries: [{ soname: 'libc.so.6', package: 'libc6' }], bundledLibraries: [], optionalLibraries: [] };
    fs.writeFileSync(path.join(directory, `Floatboat-${EXPECTED.releaseVersion}-${arch}-dependency-audit.json`), JSON.stringify(audit));
  }
  const manifest = buildUosPublicationManifest({ artifactsDir: sourcePackagesDir, releaseVersion: EXPECTED.releaseVersion,
    sourceSha: EXPECTED.sourceSha, runId: EXPECTED.runId, runAttempt: 2 });
  const sourceManifestPath = path.join(root, 'source-manifest.json');
  fs.writeFileSync(sourceManifestPath, JSON.stringify(manifest));
  return { root, selection: validateSourceRun(sourceData(), EXPECTED), sourceManifestPath, sourcePackagesDir,
    outputDir: path.join(root, 'restored'), expected: EXPECTED, manifest };
}

test('整体发布失败仍可复用成功的双包和最新验证清单，工具SHA与应用SHA分别保留', () => {
  const selection = validateSourceRun(sourceData(), EXPECTED);
  assert.equal(selection.sourceValidationAttempt, 2);
  assert.equal(selection.workflowSha, 'b'.repeat(40));
  assert.equal(selection.sourceSha, 'a'.repeat(40));
  assert.equal(selection.manifest.name, 'uos-publication-manifest-0.6.3.6-100-2');
  assert.deepEqual(selection.packages.map((item) => item.id), ['1000', '1001']);
});

test('来源必须是同仓main手动Release且准备、双构建、验证全部成功', () => {
  for (const mutate of [
    (data) => { data.run.repository.full_name = 'other/repo'; },
    (data) => { data.run.head_repository.full_name = 'other/repo'; },
    (data) => { data.run.event = 'pull_request'; },
    (data) => { data.run.head_branch = 'feature'; },
    (data) => { data.run.status = 'in_progress'; },
    (data) => { data.run.path = '.github/workflows/other.yml'; },
    (data) => { data.run.workflow_id = 41; },
    (data) => { data.jobs[1].conclusion = 'failure'; },
    (data) => { data.jobs[2].run_attempt = 1; },
    (data) => { data.jobs.pop(); },
  ]) {
    const data = sourceData(); mutate(data);
    assert.throws(() => validateSourceRun(data, EXPECTED), /UOS_REUSE_INVALID/u);
  }
  assert.throws(() => validateSourceRun(sourceData(), { ...EXPECTED, currentRunId: '100' }), /UOS_REUSE_INVALID/u);
});

test('制品按唯一名称和不可变ID选择，拒绝过期、跨仓、跨运行和旧attempt清单', () => {
  for (const mutate of [
    (data) => { data.artifacts[0].expired = true; },
    (data) => { data.artifacts.push(data.artifacts[0]); },
    (data) => { data.artifacts[0].workflow_run.id = 101; },
    (data) => { data.artifacts[0].workflow_run.repository_id = 8; },
    (data) => { data.artifacts[0].workflow_run.head_sha = 'c'.repeat(40); },
    (data) => { data.artifacts[2].name = 'uos-publication-manifest-0.6.3.6-100-1'; },
    (data) => { data.artifacts[0].digest = null; },
  ]) {
    const data = sourceData(); mutate(data);
    assert.throws(() => validateSourceRun(data, EXPECTED), /UOS_REUSE_INVALID/u);
  }
});

test('GitHub只读查询使用来源最新attempt，拒绝自动跟随重定向', async () => {
  const data = sourceData();
  const requested = [];
  const result = await selectSourceRun(EXPECTED, { token: 'fixture-token', fetchImpl: async (input, options) => {
    const url = new URL(input); requested.push(url.pathname);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(options.redirect, 'error');
    let payload;
    if (url.pathname.endsWith('/runs/100')) payload = data.run;
    else if (url.pathname.endsWith('/workflows/release.yml')) payload = data.workflow;
    else if (url.pathname.endsWith('/attempts/2/jobs')) payload = { total_count: data.jobs.length, jobs: data.jobs };
    else if (url.pathname.endsWith('/artifacts')) payload = { total_count: data.artifacts.length, artifacts: data.artifacts };
    else assert.fail('未知GitHub请求');
    return new Response(JSON.stringify(payload));
  } });
  assert.equal(result.runId, '100');
  assert.ok(requested.includes('/repos/owner/release/actions/runs/100/attempts/2/jobs'));
});

test('复用双包完整重验后生成当前run清单，保留源清单文件摘要与ZIP摘要各自含义', (context) => {
  const input = fixture(context);
  const restored = restoreArtifacts(input);
  const current = path.join(input.root, 'current-artifacts');
  fs.mkdirSync(current);
  for (const arch of ['x64', 'arm64']) for (const name of fs.readdirSync(path.join(input.outputDir, arch))) {
    fs.copyFileSync(path.join(input.outputDir, arch, name), path.join(current, name));
  }
  const manifest = buildReusedManifest({ artifactsDir: current, expected: EXPECTED, currentRunAttempt: 3, metadataSha256: restored.metadataSha256 });
  assert.deepEqual(manifest.github, { runId: '200', runAttempt: 3 });
  assert.deepEqual(manifest.packages, input.manifest.packages);
  assert.equal(manifest.buildSource.runId, '100');
  assert.equal(manifest.buildSource.sourceValidationAttempt, 2);
  assert.equal(manifest.buildSource.manifestSha256, sha256(fs.readFileSync(input.sourceManifestPath)));
  assert.equal(manifest.buildSource.manifestArtifactDigest, `sha256:${'3'.repeat(64)}`);
  assert.deepEqual(sanitizeBuildSource(manifest.buildSource), manifest.buildSource);
  const manifestPath = path.join(input.root, 'current-manifest.json');
  const outputsPath = path.join(input.root, 'manifest-outputs');
  const result = spawnSync(process.execPath, [require.resolve('./uos-artifact-reuse.cjs'), 'manifest', current, manifestPath], {
    env: { ...process.env, GITHUB_REPOSITORY: EXPECTED.repository, GITHUB_RUN_ID: EXPECTED.currentRunId,
      GITHUB_RUN_ATTEMPT: '3', UOS_REUSE_RUN_ID: EXPECTED.runId, UOS_SOURCE_SHA: EXPECTED.sourceSha,
      UOS_RELEASE_VERSION: EXPECTED.releaseVersion, UOS_BUILD_SOURCE_SHA256: restored.metadataSha256, GITHUB_OUTPUT: outputsPath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const written = fs.readFileSync(manifestPath);
  const outputs = Object.fromEntries(fs.readFileSync(outputsPath, 'utf8').trim().split('\n').map((line) => line.split('=')));
  assert.equal(outputs.manifest_run_attempt, String(JSON.parse(written).github.runAttempt));
  assert.equal(outputs.manifest_sha256, sha256(written));
  assert.deepEqual(JSON.parse(written).buildSource, manifest.buildSource);
  assert.throws(() => buildReusedManifest({ artifactsDir: current, expected: EXPECTED, currentRunAttempt: 3, metadataSha256: '0'.repeat(64) }), /来源记录摘要/u);
  const packagePath = path.join(current, manifest.packages[0].filename);
  fs.appendFileSync(packagePath, 'changed');
  assert.throws(() => buildReusedManifest({ artifactsDir: current, expected: EXPECTED, currentRunAttempt: 3, metadataSha256: restored.metadataSha256 }));
});

test('旧清单源码、版本、run、attempt或包摘要不一致时不能重新贴当前身份', (context) => {
  const input = fixture(context);
  for (const mutate of [
    (manifest) => { manifest.sourceSha = 'c'.repeat(40); },
    (manifest) => { manifest.releaseVersion = '0.6.3-rc.7'; },
    (manifest) => { manifest.packageVersion = '0.6.3.7'; },
    (manifest) => { manifest.github.runId = '99'; },
    (manifest) => { manifest.github.runAttempt = 1; },
    (manifest) => { manifest.packages[0].sha256 = '0'.repeat(64); },
    (manifest) => { manifest.packages[0].size += 1; },
    (manifest) => { manifest.packages[1].dependencyAuditSha256 = '0'.repeat(64); },
  ]) {
    const manifest = structuredClone(input.manifest); mutate(manifest);
    fs.writeFileSync(input.sourceManifestPath, JSON.stringify(manifest));
    assert.throws(() => restoreArtifacts(input), /UOS_REUSE_INVALID/u);
    assert.equal(fs.existsSync(input.outputDir), false);
  }
});

test('下载artifact中的额外脚本和符号链接一律拒绝，不执行任何制品内容', (context) => {
  const input = fixture(context);
  const extra = path.join(input.sourcePackagesDir, 'x64', 'run.sh');
  fs.writeFileSync(extra, '#!/bin/sh\nexit 99\n');
  assert.throws(() => restoreArtifacts(input), /只包含对应安装包和依赖审计/u);
  fs.unlinkSync(extra);
  fs.symlinkSync(input.sourceManifestPath, extra);
  assert.throws(() => restoreArtifacts(input), /符号链接/u);
  assert.equal(fs.existsSync(input.outputDir), false);
});
