#!/usr/bin/env node
// ABOUTME: 核验已完成发布运行的 UOS 制品来源，重验双包并保留当前运行的真实送审身份。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildUosPublicationManifest, sha256, toUosVersion } = require('./uos-publication-manifest.cjs');

const WORKFLOW_PATH = '.github/workflows/release.yml';
const SOURCE_METADATA = 'uos-build-source.json';
const ARCHES = Object.freeze({ amd64: 'x64', arm64: 'arm64' });
const REQUIRED_JOBS = ['Prepare Release', 'Build Floatboat UOS Linux (x64)', 'Build Floatboat UOS Linux (arm64)', 'Validate UOS Store Publication'];

function requireValid(condition, message) {
  if (!condition) throw new Error(`UOS_REUSE_INVALID: ${message}`);
}

function positiveId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,15}$/u.test(value) && Number.isSafeInteger(Number(value));
}

function validateExpected(input) {
  requireValid(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository || ''), '来源仓库无效');
  requireValid(positiveId(input.runId) && positiveId(input.currentRunId) && input.runId !== input.currentRunId, '来源运行身份无效');
  requireValid(/^[0-9a-f]{40}$/u.test(input.sourceSha || ''), '应用源码 SHA 无效');
  requireValid(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(input.releaseVersion || ''), '发布版本无效');
  return toUosVersion(input.releaseVersion);
}

function validateSourceRun(data, expected) {
  const packageVersion = validateExpected(expected);
  const { run, workflow, jobs, artifacts } = data;
  requireValid(run && workflow && String(run.id) === expected.runId && run.workflow_id === workflow.id &&
    workflow.path === WORKFLOW_PATH && run.path === WORKFLOW_PATH && run.event === 'workflow_dispatch' &&
    run.head_branch === 'main' && run.status === 'completed' &&
    run.repository?.full_name === expected.repository && run.head_repository?.full_name === expected.repository &&
    Number.isSafeInteger(run.repository.id) && run.repository.id > 0 && run.head_repository.id === run.repository.id &&
    /^[0-9a-f]{40}$/u.test(run.head_sha || '') && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0,
  '来源必须是本仓 main 上已完成的 release.yml 手动运行');
  requireValid(Array.isArray(jobs) && Array.isArray(artifacts), '来源任务或制品列表无效');
  for (const name of REQUIRED_JOBS) {
    const matches = jobs.filter((job) => job.name === name);
    requireValid(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success' &&
      String(matches[0].run_id) === expected.runId && matches[0].run_attempt === run.run_attempt,
    '来源准备、双架构构建和清单验证必须成功');
  }
  const select = (name) => {
    const matches = artifacts.filter((artifact) => artifact.name === name);
    const artifact = matches[0];
    requireValid(matches.length === 1 && Number.isSafeInteger(artifact.id) && artifact.id > 0 && artifact.expired === false &&
      Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && /^sha256:[0-9a-f]{64}$/u.test(artifact.digest || '') &&
      String(artifact.workflow_run?.id) === expected.runId && artifact.workflow_run.repository_id === run.repository.id &&
      artifact.workflow_run.head_repository_id === run.repository.id && artifact.workflow_run.head_branch === 'main' &&
      artifact.workflow_run.head_sha === run.head_sha, '来源制品缺失、过期、重复或不属于受信运行');
    return Object.freeze({ id: String(artifact.id), name, digest: artifact.digest });
  };
  return Object.freeze({
    schemaVersion: 1, repository: expected.repository, runId: expected.runId, sourceValidationAttempt: run.run_attempt,
    workflowSha: run.head_sha, sourceSha: expected.sourceSha, releaseVersion: expected.releaseVersion, packageVersion,
    manifest: select(`uos-publication-manifest-${packageVersion}-${expected.runId}-${run.run_attempt}`),
    packages: Object.freeze(Object.entries(ARCHES).map(([arch, artifactArch]) => Object.freeze({ arch, ...select(`uos-linux-${artifactArch}`) }))),
  });
}

async function selectSourceRun(expected, options = {}) {
  validateExpected(expected);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const token = options.token;
  requireValid(typeof token === 'string' && token.length > 0, '缺少只读 GitHub 凭据');
  const base = `https://api.github.com/repos/${expected.repository}/actions`;
  const get = async (endpoint) => {
    const response = await fetchImpl(`${base}/${endpoint}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    requireValid(response.ok, '无法读取来源 GitHub 元数据');
    return response.json();
  };
  const [run, workflow] = await Promise.all([get(`runs/${expected.runId}`), get('workflows/release.yml')]);
  requireValid(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, '来源运行尝试编号无效');
  const list = async (endpoint, key) => {
    const entries = [];
    let total;
    for (let page = 1; page <= 20; page += 1) {
      const payload = await get(`${endpoint}?per_page=100&page=${page}`);
      requireValid(Number.isSafeInteger(payload.total_count) && payload.total_count >= 0 && payload.total_count <= 2000 &&
        Array.isArray(payload[key]), '来源 GitHub 分页无效');
      total ??= payload.total_count;
      requireValid(total === payload.total_count && payload[key].length <= 100, '来源 GitHub 分页已变化');
      entries.push(...payload[key]);
      if (entries.length === total) return entries;
      requireValid(entries.length < total && payload[key].length > 0, '来源 GitHub 分页不完整');
    }
    throw new Error('UOS_REUSE_INVALID: 来源 GitHub 分页超过上限');
  };
  const [jobs, artifacts] = await Promise.all([
    list(`runs/${expected.runId}/attempts/${run.run_attempt}/jobs`, 'jobs'),
    list(`runs/${expected.runId}/artifacts`, 'artifacts'),
  ]);
  return validateSourceRun({ run, workflow, jobs, artifacts }, expected);
}

function readJsonFile(file) {
  const stat = fs.lstatSync(file);
  requireValid(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 1024 * 1024, '来源元数据文件无效');
  const bytes = fs.readFileSync(file);
  return { value: JSON.parse(bytes.toString('utf8')), digest: sha256(bytes) };
}

function packageFiles(directory, arch, releaseVersion) {
  const expected = [`Floatboat-${releaseVersion}-${arch}.deb`, `Floatboat-${releaseVersion}-${arch}-dependency-audit.json`];
  const files = [];
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    requireValid(!stat.isSymbolicLink(), '来源制品不能包含符号链接');
    if (stat.isDirectory()) for (const name of fs.readdirSync(current)) visit(path.join(current, name));
    else { requireValid(stat.isFile(), '来源制品不能包含特殊文件'); files.push(current); }
  };
  visit(directory);
  requireValid(files.length === 2 && expected.every((name) => files.filter((file) => path.basename(file) === name).length === 1),
    '每个来源架构制品必须只包含对应安装包和依赖审计');
  return files;
}

function samePackages(left, right) {
  return Array.isArray(left) && left.length === 2 && JSON.stringify(left) === JSON.stringify(right);
}

function restoreArtifacts({ selection, sourceManifestPath, sourcePackagesDir, outputDir, expected }) {
  validateExpected(expected);
  requireValid(selection.repository === expected.repository && selection.runId === expected.runId &&
    selection.releaseVersion === expected.releaseVersion && selection.sourceSha === expected.sourceSha &&
    selection.packageVersion === toUosVersion(expected.releaseVersion), '下载选择与当前发布请求不一致');
  const source = readJsonFile(sourceManifestPath);
  const manifest = source.value;
  requireValid(manifest.schemaVersion === 1 && manifest.appid === 'com.floatboat.desktop' &&
    String(manifest.github?.runId) === selection.runId && manifest.github?.runAttempt === selection.sourceValidationAttempt &&
    manifest.sourceSha === expected.sourceSha && manifest.releaseVersion === expected.releaseVersion && manifest.packageVersion === selection.packageVersion,
  '旧清单的应用、源码、版本或运行身份不匹配');
  const files = Object.entries(ARCHES).map(([arch, artifactArch]) => [artifactArch, packageFiles(path.join(sourcePackagesDir, artifactArch), arch, expected.releaseVersion)]);
  const verified = buildUosPublicationManifest({ artifactsDir: sourcePackagesDir, releaseVersion: expected.releaseVersion,
    sourceSha: expected.sourceSha, runId: selection.runId, runAttempt: selection.sourceValidationAttempt });
  requireValid(samePackages(manifest.packages, verified.packages), '旧清单的双包大小、SHA-256 或依赖审计与下载制品不一致');
  const buildSource = sanitizeBuildSource({
    repository: selection.repository, runId: selection.runId, sourceValidationAttempt: selection.sourceValidationAttempt,
    workflowSha: selection.workflowSha, manifestArtifactId: selection.manifest.id, manifestArtifactDigest: selection.manifest.digest,
    manifestSha256: source.digest,
    packageArtifactIds: Object.fromEntries(selection.packages.map((item) => [ARCHES[item.arch], item.id])),
    packageArtifactDigests: Object.fromEntries(selection.packages.map((item) => [ARCHES[item.arch], item.digest])),
  });
  requireValid(buildSource, '来源追溯字段无效');
  const metadata = { schemaVersion: 1, buildSource, releaseVersion: verified.releaseVersion, packageVersion: verified.packageVersion,
    sourceSha: verified.sourceSha, packages: verified.packages };
  requireValid(!fs.existsSync(outputDir), '复用输出目录必须是新目录');
  for (const [arch, artifacts] of files) {
    fs.mkdirSync(path.join(outputDir, arch), { recursive: true });
    for (const file of artifacts) fs.copyFileSync(file, path.join(outputDir, arch, path.basename(file)), fs.constants.COPYFILE_EXCL);
  }
  const metadataPath = path.join(outputDir, 'x64', SOURCE_METADATA);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return Object.freeze({ buildSource, metadataSha256: sha256(fs.readFileSync(metadataPath)) });
}

function sanitizeBuildSource(value) {
  try {
    const fields = ['repository', 'runId', 'sourceValidationAttempt', 'workflowSha', 'manifestArtifactId', 'manifestArtifactDigest', 'manifestSha256', 'packageArtifactIds', 'packageArtifactDigests'];
    if (!value || Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field)) ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) || !positiveId(value.runId) ||
        !Number.isSafeInteger(value.sourceValidationAttempt) || value.sourceValidationAttempt < 1 ||
        !/^[0-9a-f]{40}$/u.test(value.workflowSha) || !positiveId(value.manifestArtifactId) ||
        !/^sha256:[0-9a-f]{64}$/u.test(value.manifestArtifactDigest) || !/^[0-9a-f]{64}$/u.test(value.manifestSha256)) return undefined;
    for (const [key, valid] of [['packageArtifactIds', positiveId], ['packageArtifactDigests', (digest) => /^sha256:[0-9a-f]{64}$/u.test(digest)]]) {
      if (!value[key] || Object.keys(value[key]).length !== 2 || !['x64', 'arm64'].every((arch) => valid(value[key][arch]))) return undefined;
    }
    return Object.freeze({ ...Object.fromEntries(fields.slice(0, -2).map((field) => [field, value[field]])),
      packageArtifactIds: Object.freeze({ x64: value.packageArtifactIds.x64, arm64: value.packageArtifactIds.arm64 }),
      packageArtifactDigests: Object.freeze({ x64: value.packageArtifactDigests.x64, arm64: value.packageArtifactDigests.arm64 }) });
  } catch { return undefined; }
}

function buildReusedManifest(input) {
  validateExpected(input.expected);
  const metadata = readJsonFile(path.join(input.artifactsDir, SOURCE_METADATA));
  requireValid(/^[0-9a-f]{64}$/u.test(input.metadataSha256 || '') && metadata.digest === input.metadataSha256, '来源记录摘要与恢复任务不一致');
  const proof = metadata.value;
  const buildSource = sanitizeBuildSource(proof.buildSource);
  requireValid(proof.schemaVersion === 1 && buildSource && buildSource.repository === input.expected.repository && buildSource.runId === input.expected.runId &&
    proof.sourceSha === input.expected.sourceSha && proof.releaseVersion === input.expected.releaseVersion &&
    proof.packageVersion === toUosVersion(input.expected.releaseVersion), '来源记录身份与当前发布请求不一致');
  const manifest = buildUosPublicationManifest({ artifactsDir: input.artifactsDir, sourceSha: input.expected.sourceSha,
    releaseVersion: input.expected.releaseVersion, runId: input.expected.currentRunId, runAttempt: input.currentRunAttempt });
  requireValid(samePackages(proof.packages, manifest.packages), '当前运行双包与已恢复的来源摘要不一致');
  return Object.freeze({ ...manifest, buildSource });
}

function appendOutputs(values) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

async function main(argv) {
  const [operation, first, second, third, fourth] = argv;
  const expected = { repository: process.env.GITHUB_REPOSITORY, runId: process.env.UOS_REUSE_RUN_ID,
    currentRunId: process.env.GITHUB_RUN_ID, sourceSha: process.env.UOS_SOURCE_SHA, releaseVersion: process.env.UOS_RELEASE_VERSION };
  if (operation === 'select') {
    const selection = await selectSourceRun(expected, { token: process.env.GH_TOKEN });
    fs.mkdirSync(path.dirname(first), { recursive: true });
    fs.writeFileSync(first, `${JSON.stringify(selection, null, 2)}\n`, { mode: 0o600 });
    appendOutputs({ source_run_id: selection.runId, manifest_artifact_id: selection.manifest.id,
      x64_artifact_id: selection.packages.find((item) => item.arch === 'amd64').id,
      arm64_artifact_id: selection.packages.find((item) => item.arch === 'arm64').id });
  } else if (operation === 'restore') {
    const result = restoreArtifacts({ selection: readJsonFile(first).value, sourceManifestPath: second, sourcePackagesDir: third, outputDir: fourth, expected });
    appendOutputs({ build_source_sha256: result.metadataSha256 });
  } else if (operation === 'manifest') {
    const manifest = buildReusedManifest({ artifactsDir: first, expected, currentRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      metadataSha256: process.env.UOS_BUILD_SOURCE_SHA256 });
    fs.writeFileSync(second, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const manifestBytes = fs.readFileSync(second);
    const writtenManifest = JSON.parse(manifestBytes);
    appendOutputs({ manifest_sha256: sha256(manifestBytes), package_version: manifest.packageVersion,
      manifest_run_attempt: writtenManifest.github.runAttempt });
  } else throw new Error('UOS_REUSE_INVALID: 未知复用校验操作');
}

if (require.main === module) void main(process.argv.slice(2)).catch(() => {
  console.error('::error::UOS_REUSE_INVALID: 来源运行或双架构制品未通过复用校验');
  process.exitCode = 1;
});

module.exports = { validateSourceRun, selectSourceRun, restoreArtifacts, buildReusedManifest, sanitizeBuildSource };
