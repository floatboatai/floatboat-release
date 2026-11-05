#!/usr/bin/env node
// ABOUTME: 将重验后的 UOS 双包发布到内容寻址的审核下载目录，并核对 S3 与 CDN 的完整摘要。
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { buildReusedManifest, sanitizeBuildSource } = require('./uos-artifact-reuse.cjs');
const { buildUosPublicationManifest, sha256 } = require('./uos-publication-manifest.cjs');

const BUCKET = 'aoe-desktop-releases';
const CDN_ORIGIN = 'https://release.aoe.chat';
const DISTRIBUTION_ID = 'EOFLQQ0A8KCX1';
const execFileAsync = promisify(execFile);

class UosStageError extends Error {
  constructor(code) { super(`UOS_STAGE_FAILED: ${code}`); this.code = code; }
}
function requireValid(condition, code) { if (!condition) throw new UosStageError(code); }

function buildStagePlan(input) {
  requireValid(input.expected.repository === 'floatboatai/floatboat-release', 'repository_invalid');
  const stat = fs.lstatSync(input.manifestPath);
  requireValid(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 1024 * 1024, 'manifest_file_invalid');
  const bytes = fs.readFileSync(input.manifestPath);
  requireValid(/^[0-9a-f]{64}$/u.test(input.manifestSha256 || '') && sha256(bytes) === input.manifestSha256, 'manifest_digest_mismatch');
  const manifest = JSON.parse(bytes.toString('utf8'));
  const verified = buildUosPublicationManifest({ artifactsDir: input.artifactsDir, releaseVersion: input.expected.releaseVersion,
    sourceSha: input.expected.sourceSha, runId: input.expected.currentRunId, runAttempt: input.currentRunAttempt });
  for (const field of ['schemaVersion', 'appid', 'releaseVersion', 'packageVersion', 'sourceSha', 'github', 'packages']) {
    requireValid(JSON.stringify(manifest[field]) === JSON.stringify(verified[field]), 'manifest_content_mismatch');
  }
  const buildSource = manifest.buildSource === undefined ? undefined : sanitizeBuildSource(manifest.buildSource);
  requireValid(manifest.buildSource === undefined || buildSource, 'build_source_invalid');
  if (input.expected.runId) requireValid(buildSource?.runId === input.expected.runId, 'source_run_mismatch');
  if (input.metadataSha256) {
    const reused = buildReusedManifest(input);
    requireValid(JSON.stringify(reused.buildSource) === JSON.stringify(buildSource), 'build_source_mismatch');
  }
  requireValid(typeof manifest.generatedAt === 'string' && Number.isFinite(Date.parse(manifest.generatedAt)), 'manifest_time_invalid');
  const prefix = `uos/review/${manifest.packageVersion}/${manifest.sourceSha}`;
  const object = (filePath, filename, size, digest, contentType, arch) => {
    const key = `${prefix}/${digest}/${filename}`;
    return Object.freeze({ filePath, filename, size, sha256: digest, contentType, key, url: `${CDN_ORIGIN}/${key}`, ...(arch ? { arch } : {}) });
  };
  const packages = manifest.packages.map((item) => object(path.join(input.artifactsDir, item.filename), item.filename,
    item.size, item.sha256, 'application/vnd.debian.binary-package', item.arch));
  const manifestObject = object(input.manifestPath, 'uos-publication-manifest.json', bytes.length, input.manifestSha256, 'application/json');
  return Object.freeze({ schemaVersion: 1, appid: manifest.appid, releaseVersion: manifest.releaseVersion, packageVersion: manifest.packageVersion,
    sourceSha: manifest.sourceSha, github: manifest.github, ...(buildSource ? { buildSource } : {}),
    packages: Object.freeze(packages), manifest: manifestObject });
}

async function runAws(args) {
  try {
    const { stdout } = await execFileAsync('aws', [...args, '--output', 'json', '--no-cli-pager'], {
      timeout: 20 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, AWS_PAGER: '' },
    });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) {
    const message = typeof error.stderr === 'string' ? error.stderr : '';
    const code = /\((?:404|NoSuchKey|NotFound)\)/u.test(message) ? 's3_not_found'
      : /\((?:412|PreconditionFailed)\)/u.test(message) ? 's3_precondition'
        : /\((?:409|ConditionalRequestConflict)\)/u.test(message) ? 's3_conflict' : 'aws_failed';
    throw new UosStageError(code);
  }
}

function verifyS3Object(remote, object) {
  requireValid(remote.ContentLength === object.size &&
    remote.ChecksumSHA256 === Buffer.from(object.sha256, 'hex').toString('base64') &&
    (!remote.ChecksumType || remote.ChecksumType === 'FULL_OBJECT'), 's3_content_mismatch');
}

async function ensureImmutableObject(object, aws = runAws) {
  const head = () => aws(['s3api', 'head-object', '--bucket', BUCKET, '--key', object.key, '--checksum-mode', 'ENABLED']);
  try { verifyS3Object(await head(), object); return 'reused'; }
  catch (error) { if (!(error instanceof UosStageError) || error.code !== 's3_not_found') throw error; }
  try {
    await aws(['s3api', 'put-object', '--bucket', BUCKET, '--key', object.key, '--body', object.filePath,
      '--if-none-match', '*', '--checksum-algorithm', 'SHA256',
      '--checksum-sha256', Buffer.from(object.sha256, 'hex').toString('base64'),
      '--content-type', object.contentType, '--cache-control', 'public,max-age=31536000,immutable']);
  } catch (error) {
    // 同时发布同一内容时只允许读取获胜对象；任何其他错误都不能降级为覆盖写入。
    if (!(error instanceof UosStageError) || !['s3_precondition', 's3_conflict'].includes(error.code)) throw error;
  }
  verifyS3Object(await head(), object);
  return 'verified';
}

async function verifyCdnObject(object, options = {}) {
  const response = await (options.fetchImpl || globalThis.fetch)(object.url, {
    redirect: 'error', headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  try {
    requireValid(response.status === 200 && response.body, 'cdn_http_failed');
    const encoding = response.headers.get('content-encoding');
    requireValid(!encoding || encoding === 'identity', 'cdn_content_encoding');
    const length = response.headers.get('content-length');
    requireValid(length === null || length === String(object.size), 'cdn_size_mismatch');
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      requireValid(size <= object.size, 'cdn_size_mismatch');
      hash.update(chunk);
    }
    requireValid(size === object.size && hash.digest('hex') === object.sha256, 'cdn_content_mismatch');
  } finally {
    if (response.body && !response.bodyUsed) await response.body.cancel();
  }
}

function publicObject(object) {
  return Object.freeze({ ...(object.arch ? { arch: object.arch } : {}), filename: object.filename,
    size: object.size, sha256: object.sha256, url: object.url });
}

async function publishStage(plan, options = {}) {
  const aws = options.aws || runAws;
  requireValid(typeof options.indexPath === 'string' && options.indexPath.length > 0, 'output_path_missing');
  const index = Object.freeze({ schemaVersion: 1, appid: plan.appid, releaseVersion: plan.releaseVersion, packageVersion: plan.packageVersion,
    sourceSha: plan.sourceSha, github: plan.github, ...(plan.buildSource ? { buildSource: plan.buildSource } : {}),
    packages: Object.freeze(plan.packages.map(publicObject)), manifestUrl: plan.manifest.url, manifestSha256: plan.manifest.sha256 });
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  fs.writeFileSync(options.indexPath, indexBytes, { mode: 0o600 });
  const indexSha256 = sha256(indexBytes);
  const indexKey = `uos/review/${plan.packageVersion}/${plan.sourceSha}/${indexSha256}/uos-review-downloads.json`;
  const indexObject = { filePath: options.indexPath, filename: 'uos-review-downloads.json', size: indexBytes.length,
    sha256: indexSha256, contentType: 'application/json', key: indexKey, url: `${CDN_ORIGIN}/${indexKey}` };
  const objects = [...plan.packages, plan.manifest, indexObject];
  for (const object of objects) await ensureImmutableObject(object, aws);
  // 仅清除本次内容地址可能缓存的 404，不刷新官网指针或整条 UOS 路径。
  await aws(['cloudfront', 'create-invalidation', '--distribution-id', DISTRIBUTION_ID, '--paths', ...objects.map((object) => `/${object.key}`)]);
  for (const object of objects) {
    for (let attempt = 1; ; attempt += 1) {
      try { await verifyCdnObject(object, options); break; }
      catch (error) {
        if (attempt >= 4 || (error instanceof UosStageError && error.code !== 'cdn_http_failed')) throw error;
        await (options.wait || delay)(attempt * 5000);
      }
    }
  }
  return Object.freeze({ index, indexUrl: indexObject.url, indexSha256 });
}

async function main(argv) {
  const [operation, artifactsDir, manifestPath, outputPath] = argv;
  requireValid(['verify', 'publish'].includes(operation) && artifactsDir && manifestPath, 'arguments_invalid');
  requireValid(process.env.GITHUB_REF === 'refs/heads/main' && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'workflow_identity_invalid');
  const expected = { repository: process.env.GITHUB_REPOSITORY, runId: process.env.UOS_REUSE_RUN_ID,
    currentRunId: process.env.GITHUB_RUN_ID, sourceSha: process.env.UOS_SOURCE_SHA, releaseVersion: process.env.UOS_RELEASE_VERSION };
  const plan = buildStagePlan({ artifactsDir, manifestPath, expected, currentRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    metadataSha256: process.env.UOS_BUILD_SOURCE_SHA256, manifestSha256: process.env.UOS_STAGE_MANIFEST_SHA256 });
  if (operation === 'verify') { console.log('UOS_STAGE_VERIFIED: 来源、当前运行身份与双包内容一致'); return; }
  requireValid(typeof outputPath === 'string' && outputPath.length > 0, 'output_path_missing');
  const result = await publishStage(plan, { indexPath: outputPath });
  const receipt = result.index;
  const outputs = { amd64_url: receipt.packages.find((item) => item.arch === 'amd64').url,
    arm64_url: receipt.packages.find((item) => item.arch === 'arm64').url,
    manifest_url: receipt.manifestUrl, manifest_sha256: receipt.manifestSha256,
    index_url: result.indexUrl, index_sha256: result.indexSha256 };
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## UOS 审核包已准备\n\n${receipt.packages.map((item) => `- [${item.arch} 安装包](${item.url}) — SHA-256: \`${item.sha256}\``).join('\n')}\n- [校验清单](${receipt.manifestUrl}) — SHA-256: \`${receipt.manifestSha256}\`\n- [下载索引](${result.indexUrl}) — SHA-256: \`${result.indexSha256}\`\n`);
  console.log(JSON.stringify(receipt, null, 2));
}

if (require.main === module) void main(process.argv.slice(2)).catch((error) => {
  console.error(`::error::${error instanceof UosStageError ? error.message : 'UOS_STAGE_FAILED: validation_or_transport_failed'}`);
  process.exitCode = 1;
});

module.exports = { buildStagePlan, ensureImmutableObject, verifyCdnObject, publishStage, UosStageError };
