#!/usr/bin/env node
// ABOUTME: 用 Electron 包自带摘要复核镜像缓存，供 Forge 现有 electronZipDir 路由复用。
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

async function verifyArchive(archivePath, expectedSha256) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 || '')) {
    throw new Error('Electron 包内缺少有效 SHA256，停止复用缓存');
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(archivePath)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  if (sha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`Electron 镜像缓存 SHA256 不匹配：${archivePath}`);
  }
  return sha256;
}

async function locateElectronCache(sourceRoot) {
  const sourceRequire = createRequire(path.resolve(sourceRoot, 'package.json'));
  const electronPackage = sourceRequire.resolve('electron/package.json');
  const electronRequire = createRequire(electronPackage);
  const getEntry = electronRequire.resolve('@electron/get');
  const { Cache } = require(path.join(path.dirname(getEntry), 'Cache.js'));
  const { getArtifactVersion, getArtifactFileName, getArtifactRemoteURL } = require(
    path.join(path.dirname(getEntry), 'artifact-utils.js'),
  );
  const { version } = electronRequire('./package.json');
  const details = {
    artifactName: 'electron',
    version: getArtifactVersion({ version }),
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
  };
  if (details.platform !== 'win32' || details.arch !== 'x64') {
    throw new Error('安装速度对照只验证 Windows x64 Electron 缓存');
  }
  const fileName = getArtifactFileName(details);
  const downloadUrl = await getArtifactRemoteURL(details);
  // 与 electron/install.js 使用同一个 @electron/get 和 cacheRoot，避免猜测 URL 或缓存键。
  const cache = new Cache(process.env.electron_config_cache);
  const archivePath = await cache.getPathForFileInCache(downloadUrl, fileName);
  if (!archivePath) throw new Error(`Electron 镜像缓存缺失：${fileName}`);
  return {
    version,
    archivePath,
    expectedSha256: electronRequire('./checksums.json')[fileName],
  };
}

async function main() {
  const { version, archivePath, expectedSha256 } = await locateElectronCache(
    process.argv[2] || process.cwd(),
  );
  const sha256 = await verifyArchive(archivePath, expectedSha256);
  console.log(JSON.stringify({ version, archivePath, sha256, verified: true }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { locateElectronCache, verifyArchive };
