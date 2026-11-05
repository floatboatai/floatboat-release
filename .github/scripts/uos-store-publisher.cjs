#!/usr/bin/env node
// ABOUTME: 以幂等状态机上传 UOS 双架构包、自动提交审核并生成脱敏回执。

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  UosStoreApiClient,
  UosStoreApiError,
  normalizeRemoteArch,
  redactMessage,
} = require('./uos-store-api-client.cjs');
const { authenticateUnionTechIdentity } = require('./uniontech-identity-authenticator.cjs');

const APP_ID = 'com.floatboat.desktop';
const RECEIPT_SCHEMA_VERSION = 1;

class UosStorePublisherError extends Error {
  constructor(code, message, options = {}) {
    super(`${code}: ${message}`);
    this.name = 'UosStorePublisherError';
    this.code = code;
    this.stage = options.stage || 'failed';
  }
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function canonicalManifestDigest(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.appid !== APP_ID) {
    throw new UosStorePublisherError('UOS_MANIFEST_INVALID', '送审清单身份无效', { stage: 'validate' });
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(manifest.packageVersion) || !/^[0-9a-f]{40}$/u.test(manifest.sourceSha)) {
    throw new UosStorePublisherError('UOS_MANIFEST_INVALID', '送审版本或 source SHA 无效', { stage: 'validate' });
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== 2) {
    throw new UosStorePublisherError('UOS_MANIFEST_INVALID', '送审清单必须包含双架构', { stage: 'validate' });
  }
  const arches = manifest.packages.map((item) => item.arch).sort();
  if (JSON.stringify(arches) !== JSON.stringify(['amd64', 'arm64'])) {
    throw new UosStorePublisherError('UOS_MANIFEST_INVALID', '送审架构集合无效', { stage: 'validate' });
  }
  for (const item of manifest.packages) {
    if (!/^[0-9a-f]{64}$/u.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size <= 0 || path.basename(item.filename) !== item.filename) {
      throw new UosStorePublisherError('UOS_MANIFEST_INVALID', `${item.arch} 包摘要无效`, { stage: 'validate' });
    }
  }
  return manifest;
}

function validateRuntimeIdentity(manifest, runtime) {
  if (
    String(manifest.github?.runId) !== String(runtime.runId) ||
    Number(manifest.github?.runAttempt) !== Number(runtime.runAttempt) ||
    manifest.sourceSha !== runtime.sourceSha
  ) {
    throw new UosStorePublisherError('UOS_MANIFEST_RUN_IDENTITY_MISMATCH', '送审清单不属于当前 GitHub run/source', {
      stage: 'validate',
    });
  }
}

function resolvePackageFiles(artifactsDir, manifest) {
  const root = path.resolve(artifactsDir);
  const files = [];
  for (const item of manifest.packages) {
    const filePath = path.resolve(root, item.filename);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      throw new UosStorePublisherError('UOS_ARTIFACT_PATH_UNSAFE', `${item.arch} 包路径越界`, { stage: 'validate' });
    }
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size || hashFile(filePath) !== item.sha256) {
      throw new UosStorePublisherError('UOS_ARTIFACT_DIGEST_MISMATCH', `${item.arch} 包与已验证清单不一致`, { stage: 'validate' });
    }
    files.push(Object.freeze({ ...item, filePath }));
  }
  return files;
}

class JsonPublicationJournal {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load(manifest) {
    const identity = {
      appid: manifest.appid,
      packageVersion: manifest.packageVersion,
      sourceSha: manifest.sourceSha,
      packages: manifest.packages.map(({ arch, sha256 }) => ({ arch, sha256 })),
    };
    if (!fs.existsSync(this.filePath)) return Object.freeze({ schemaVersion: 1, identity, stage: 'created', uploaded: {} });
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      throw new UosStorePublisherError('UOS_JOURNAL_INVALID', '发布 journal 损坏', { stage: 'validate' });
    }
    if (JSON.stringify(existing.identity) !== JSON.stringify(identity)) {
      throw new UosStorePublisherError('UOS_VERSION_CONTENT_CONFLICT', '同一 journal 的发布内容已变化', { stage: 'validate' });
    }
    return existing;
  }

  save(journal) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}

function createReceipt(manifest, overrides = {}) {
  return Object.freeze({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    appid: manifest.appid,
    releaseVersion: manifest.releaseVersion,
    packageVersion: manifest.packageVersion,
    sourceSha: manifest.sourceSha,
    github: manifest.github,
    packages: manifest.packages.map(({ arch, filename, sha256, size }) => ({ arch, filename, sha256, size })),
    stage: overrides.stage || 'created',
    status: overrides.status || 'running',
    diagnosticCode: overrides.diagnosticCode || null,
    idempotent: Boolean(overrides.idempotent),
    submittedAt: overrides.submittedAt || null,
    lastCheckedAt: overrides.lastCheckedAt || new Date().toISOString(),
  });
}

async function publishUosStore(options) {
  const manifest = validateManifest(options.manifest);
  const packageFiles = resolvePackageFiles(options.artifactsDir, manifest);
  const journalStore = options.journalStore;
  let journal = journalStore.load(manifest);
  const saveStage = (stage, fields = {}) => {
    journal = { ...journal, ...fields, stage, updatedAt: options.now() };
    journalStore.save(journal);
  };

  saveStage('authenticate');
  await options.client.authenticate(options.credentials);
  const application = await options.client.resolveApplicationRecord(APP_ID);
  saveStage('preflight');
  const existing = await options.client.inspectPublication(application.appId, manifest);
  if (existing.state === 'conflict') {
    throw new UosStorePublisherError('UOS_VERSION_CONTENT_CONFLICT', '统信平台已有同版本不同内容', { stage: 'preflight' });
  }
  if (existing.state === 'version-regression') {
    throw new UosStorePublisherError('UOS_VERSION_ORDER_INVALID', '送审版本低于统信平台已有最高版本', { stage: 'preflight' });
  }
  if (existing.state === 'manual-action-required') {
    throw new UosStorePublisherError('UOS_REVIEW_MANUAL_ACTION_REQUIRED', '统信平台上的当前版本需要人工处理审核结果', {
      stage: 'preflight',
    });
  }
  if (existing.state === 'unconfirmed') {
    throw new UosStorePublisherError('UOS_REMOTE_STATE_UNCONFIRMED', '无法安全确认统信平台上的当前版本状态', {
      stage: 'preflight',
    });
  }
  if (existing.state === 'submitted') {
    saveStage('confirmed');
    return createReceipt(manifest, {
      stage: 'confirmed',
      status: 'submitted',
      idempotent: true,
      submittedAt: options.now(),
      lastCheckedAt: options.now(),
    });
  }

  const template = await options.client.getApplicationTemplate(existing.versionId || application.currentVersionId);
  const submissionPackages = [];
  const reusableByArch = new Map(
    existing.state === 'uploaded' || existing.state === 'partial-uploaded'
      ? existing.packages.map((row) => [normalizeRemoteArch(row.pkg_arch ?? row.pkgArch), row])
      : [],
  );
  for (const packageFile of packageFiles) {
    const reusable = reusableByArch.get(packageFile.arch);
    if (reusable && reusable.pkg_version === manifest.packageVersion &&
        String(reusable.sha256).toLowerCase() === packageFile.sha256) {
      submissionPackages.push({ ...reusable });
      saveStage(`reused-${packageFile.arch}`, {
        uploaded: { ...journal.uploaded, [packageFile.arch]: { sha256: packageFile.sha256, remote: true } },
      });
      continue;
    }
    saveStage(`detect-${packageFile.arch}`);
    const detected = await options.client.detectPackage(packageFile.filePath);
    const detectedArch = normalizeRemoteArch(detected.pkg_arch ?? detected.pkgArch);
    if (detected.pkg_name !== APP_ID || detected.pkg_version !== manifest.packageVersion || detectedArch !== packageFile.arch) {
      throw new UosStorePublisherError('UOS_PACKAGE_METADATA_MISMATCH', `${packageFile.arch} 服务端解析结果不匹配`, {
        stage: `detect-${packageFile.arch}`,
      });
    }

    saveStage(`upload-${packageFile.arch}`);
    const uploaded = await options.client.uploadPackage(packageFile.filePath);
    if (!uploaded || typeof uploaded.file_save_key !== 'string' || !uploaded.file_save_key) {
      throw new UosStorePublisherError('UOS_UPLOAD_CONTRACT_MISMATCH', `${packageFile.arch} 上传完成但缺少 file_save_key`, {
        stage: `upload-${packageFile.arch}`,
      });
    }
    submissionPackages.push({
      ...detected,
      file_save_key: uploaded.file_save_key,
      pkg_name: APP_ID,
      pkg_version: manifest.packageVersion,
      pkg_size: packageFile.size,
      sha256: packageFile.sha256,
    });
    saveStage(`uploaded-${packageFile.arch}`, {
      uploaded: { ...journal.uploaded, [packageFile.arch]: { sha256: packageFile.sha256, remote: true } },
    });
  }

  saveStage('submit');
  const payload = options.client.prepareSubmission(template, submissionPackages);
  try {
    await options.client.submitApplication(payload);
  } catch (error) {
    const recovered = await options.client.inspectPublication(application.appId, manifest);
    if (recovered.state !== 'submitted') throw error;
  }

  saveStage('readback');
  let confirmed = null;
  for (let attempt = 1; attempt <= options.readbackAttempts; attempt += 1) {
    confirmed = await options.client.inspectPublication(application.appId, manifest);
    if (confirmed.state === 'submitted') break;
    if (confirmed.state === 'conflict') {
      throw new UosStorePublisherError('UOS_VERSION_CONTENT_CONFLICT', '提交后回读到同版本不同内容', { stage: 'readback' });
    }
    if (attempt < options.readbackAttempts) await options.wait(attempt);
  }
  if (!confirmed || confirmed.state !== 'submitted') {
    throw new UosStorePublisherError('UOS_SUBMISSION_NOT_CONFIRMED', '提交后未能确认双架构审核状态', { stage: 'readback' });
  }
  saveStage('confirmed');
  return createReceipt(manifest, {
    stage: 'confirmed',
    status: 'submitted',
    submittedAt: options.now(),
    lastCheckedAt: options.now(),
  });
}

function safeDiagnostic(error) {
  if (error instanceof UosStorePublisherError || error instanceof UosStoreApiError) return error.code;
  return 'UOS_PUBLICATION_FAILED';
}

async function main(argv) {
  const [artifactsDir, manifestPath, receiptPath, journalPath] = argv;
  if (!artifactsDir || !manifestPath || !receiptPath || !journalPath) {
    console.error('usage: uos-store-publisher.cjs <artifacts-dir> <manifest-json> <receipt-json> <journal-json>');
    process.exitCode = 2;
    return;
  }
  let manifest = null;
  let receipt;
  try {
    manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const expectedManifestSha256 = String(process.env.UOS_PUBLICATION_MANIFEST_SHA256 || '').trim();
    if (!/^[0-9a-f]{64}$/u.test(expectedManifestSha256) || hashFile(manifestPath) !== expectedManifestSha256) {
      throw new UosStorePublisherError('UOS_MANIFEST_DIGEST_MISMATCH', '送审清单摘要与无 Secret 校验 job 不一致', {
        stage: 'validate',
      });
    }
    validateRuntimeIdentity(manifest, {
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      sourceSha: process.env.UOS_SOURCE_SHA,
    });
    const client = new UosStoreApiClient({
      baseUrl: 'https://appstore-dev.uniontech.com',
      identityAuthenticator: authenticateUnionTechIdentity,
    });
    receipt = await publishUosStore({
      manifest,
      artifactsDir,
      credentials: { username: process.env.UOS_STORE_USERNAME, password: process.env.UOS_STORE_PASSWORD },
      client,
      journalStore: new JsonPublicationJournal(journalPath),
      now: () => new Date().toISOString(),
      readbackAttempts: 5,
      wait: (attempt) => new Promise((resolve) => setTimeout(resolve, attempt * 3000)),
    });
  } catch (error) {
    const diagnosticCode = safeDiagnostic(error);
    receipt = manifest
      ? createReceipt(manifest, {
          stage: error && typeof error.stage === 'string' ? error.stage : 'failed',
          status: 'failed',
          diagnosticCode,
          lastCheckedAt: new Date().toISOString(),
        })
      : {
          schemaVersion: RECEIPT_SCHEMA_VERSION,
          appid: APP_ID,
          status: 'failed',
          stage: 'validate',
          diagnosticCode,
          lastCheckedAt: new Date().toISOString(),
        };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    console.error(`::error::${diagnosticCode}: ${redactMessage(error instanceof Error ? error.message : String(error), [
      process.env.UOS_STORE_USERNAME,
      process.env.UOS_STORE_PASSWORD,
    ])}`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`UOS publication confirmed for ${receipt.appid} ${receipt.packageVersion}`);
}

if (require.main === module) void main(process.argv.slice(2));

module.exports = {
  JsonPublicationJournal,
  UosStorePublisherError,
  canonicalManifestDigest,
  createReceipt,
  publishUosStore,
  resolvePackageFiles,
  safeDiagnostic,
  validateManifest,
  validateRuntimeIdentity,
};
