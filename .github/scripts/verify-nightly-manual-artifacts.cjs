// ABOUTME: 校验手动 Nightly 的完整制品集合，并记录源码身份和流式 SHA256 校验值。
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function verifyManualArtifacts(directory, manifestPath, version, sourceSha) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha || '')) throw new Error('无效的源码提交 SHA');
  if (!/^\d+\.\d+\.\d+-n\.\d{8}-[0-9a-f]{6}$/.test(version || '') ||
      !version.endsWith(`-${sourceSha.slice(-6)}`)) {
    throw new Error('Nightly 版本必须绑定本次源码提交');
  }
  const expected = [
    `Floatboat-${version}-x64.dmg`,
    `Floatboat-${version}-x64.zip`,
    `Floatboat-${version}-amd64.deb`,
    `Floatboat-${version}-arm64.deb`,
  ].sort();
  const actual = fs.readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Nightly 制品集合不完整或含非目标平台文件：${actual.join(', ')}`);
  }

  const artifacts = [];
  for (const name of expected) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size === 0) throw new Error(`制品不是非空普通文件：${name}`);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    artifacts.push({ name, size: stat.size, sha256: hash.digest('hex') });
  }
  const manifest = { version, sourceSha, artifacts };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

module.exports = { verifyManualArtifacts };

if (require.main === module) {
  verifyManualArtifacts(process.argv[2], process.argv[3], process.env.FLOATBOAT_VERSION, process.env.SOURCE_SHA)
    .then((manifest) => console.log(`已验证 ${manifest.artifacts.length} 个 Nightly 制品：${manifest.version}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
