#!/usr/bin/env node
// ABOUTME: 独立校验 updater 元数据与本次正式发布制品的版本、大小和 SHA512 一致性。

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function fail(message) {
  throw new Error(message);
}

function readOption(argv, index, optionName) {
  const current = argv[index];
  const prefix = `${optionName}=`;
  if (current.startsWith(prefix)) {
    const value = current.slice(prefix.length).trim();
    if (!value) {
      fail(`${optionName} 缺少参数`);
    }
    return { value, consumed: 1 };
  }

  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    fail(`${optionName} 缺少参数`);
  }
  return { value, consumed: 2 };
}

function parseArgs(argv) {
  const options = {
    metadataPath: '',
    artifactDirectory: '',
    releaseVersion: '',
    expectedArtifacts: [],
  };

  for (let index = 0; index < argv.length; ) {
    const current = argv[index];
    const optionName = [
      '--metadata',
      '--artifact-dir',
      '--release-version',
      '--expected-artifact',
    ].find((candidate) => current === candidate || current.startsWith(`${candidate}=`));
    if (!optionName) {
      fail(`未知参数：${current}`);
    }

    const { value, consumed } = readOption(argv, index, optionName);
    if (optionName === '--metadata') {
      options.metadataPath = value;
    } else if (optionName === '--artifact-dir') {
      options.artifactDirectory = value;
    } else if (optionName === '--release-version') {
      options.releaseVersion = value;
    } else {
      options.expectedArtifacts.push(value);
    }
    index += consumed;
  }

  if (!options.metadataPath) fail('--metadata 为必填项');
  if (!options.artifactDirectory) fail('--artifact-dir 为必填项');
  if (!options.releaseVersion) fail('--release-version 为必填项');
  if (options.expectedArtifacts.length === 0) fail('至少需要一个 --expected-artifact');

  return options;
}

function calculateSha512(filePath) {
  const content = fs.readFileSync(filePath);
  const digest = crypto.createHash('sha512').update(content).digest();
  return {
    base64: digest.toString('base64'),
    hex: digest.toString('hex'),
  };
}

function assertSafeArtifactName(fileName) {
  if (!fileName || path.basename(fileName) !== fileName || fileName.includes('\\')) {
    fail(`制品名称必须是不含路径的文件名：${fileName}`);
  }
}

function loadMetadata(metadataPath) {
  if (!fs.existsSync(metadataPath) || !fs.statSync(metadataPath).isFile()) {
    fail(`updater 元数据不存在：${metadataPath}`);
  }

  const document = yaml.load(fs.readFileSync(metadataPath, 'utf8'));
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    fail(`updater 元数据不是对象：${metadataPath}`);
  }
  return document;
}

function verifyUpdateMetadata(options) {
  const metadataPath = path.resolve(options.metadataPath);
  const artifactDirectory = path.resolve(options.artifactDirectory);
  const expectedArtifacts = [...new Set(options.expectedArtifacts)];
  if (expectedArtifacts.length !== options.expectedArtifacts.length) {
    fail('expected artifact 列表包含重复项');
  }
  expectedArtifacts.forEach(assertSafeArtifactName);

  const metadata = loadMetadata(metadataPath);
  if (metadata.version !== options.releaseVersion) {
    fail(`元数据版本不匹配：期望 ${options.releaseVersion}，实际 ${String(metadata.version)}`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    fail('元数据 files 必须是非空数组');
  }

  const fileEntries = new Map();
  for (const entry of metadata.files) {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
      fail('元数据 files 包含无效条目');
    }
    assertSafeArtifactName(entry.url);
    if (fileEntries.has(entry.url)) {
      fail(`元数据 files 包含重复制品：${entry.url}`);
    }
    fileEntries.set(entry.url, entry);
  }

  const actualArtifacts = [...fileEntries.keys()].sort();
  const sortedExpectedArtifacts = [...expectedArtifacts].sort();
  if (JSON.stringify(actualArtifacts) !== JSON.stringify(sortedExpectedArtifacts)) {
    fail(
      `元数据制品集合不匹配：期望 ${sortedExpectedArtifacts.join(', ')}；实际 ${actualArtifacts.join(', ')}`,
    );
  }

  for (const artifactName of expectedArtifacts) {
    const artifactPath = path.join(artifactDirectory, artifactName);
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      fail(`本地更新制品不存在：${artifactPath}`);
    }

    const entry = fileEntries.get(artifactName);
    const stats = fs.statSync(artifactPath);
    if (!Number.isSafeInteger(entry.size) || entry.size !== stats.size) {
      fail(`制品大小不匹配：${artifactName}，期望 ${stats.size}，实际 ${String(entry.size)}`);
    }
    if (typeof entry.sha512 !== 'string' || !entry.sha512.trim()) {
      fail(`制品缺少 SHA512：${artifactName}`);
    }

    const digest = calculateSha512(artifactPath);
    const normalizedSha512 = entry.sha512.trim();
    if (normalizedSha512 !== digest.base64 && normalizedSha512.toLowerCase() !== digest.hex) {
      fail(`制品 SHA512 不匹配：${artifactName}`);
    }
  }

  if (typeof metadata.path !== 'string' || !fileEntries.has(metadata.path)) {
    fail(`元数据 path 未指向受信制品：${String(metadata.path)}`);
  }
  const primaryEntry = fileEntries.get(metadata.path);
  if (typeof metadata.sha512 !== 'string' || metadata.sha512.trim() !== primaryEntry.sha512.trim()) {
    fail(`元数据顶层 SHA512 与 path 制品不一致：${metadata.path}`);
  }
  if (typeof metadata.releaseDate !== 'string' || Number.isNaN(Date.parse(metadata.releaseDate))) {
    fail(`元数据 releaseDate 无效：${String(metadata.releaseDate)}`);
  }

  return {
    metadataPath,
    releaseVersion: metadata.version,
    primaryArtifact: metadata.path,
    artifactCount: expectedArtifacts.length,
  };
}

function main() {
  const result = verifyUpdateMetadata(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    `✅ updater 元数据校验通过：${result.metadataPath}（${result.releaseVersion}，${result.artifactCount} 个制品，主制品 ${result.primaryArtifact}）\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  verifyUpdateMetadata,
};
