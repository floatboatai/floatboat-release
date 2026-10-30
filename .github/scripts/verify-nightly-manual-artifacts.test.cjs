// ABOUTME: 用真实文件验证 Nightly 汇总校验，避免缺包、混包和源码身份不符时交付。
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyManualArtifacts } = require('./verify-nightly-manual-artifacts.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-nightly-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'installers');
  fs.mkdirSync(directory);
  const sourceSha = 'a'.repeat(34) + 'abcdef';
  const version = '0.6.3-n.20261030-abcdef';
  const names = ['x64.dmg', 'x64.zip', 'amd64.deb', 'arm64.deb'].map((suffix) => `Floatboat-${version}-${suffix}`);
  for (const name of names) fs.writeFileSync(path.join(directory, name), `artifact:${name}`);
  return { directory, sourceSha, version, names, manifestPath: path.join(root, 'manifest.json') };
}

test('完整四包输出与真实文件一致的来源和校验值', async (t) => {
  const f = fixture(t);
  await verifyManualArtifacts(f.directory, f.manifestPath, f.version, f.sourceSha);
  const result = JSON.parse(fs.readFileSync(f.manifestPath, 'utf8'));
  assert.equal(result.version, f.version);
  assert.equal(result.sourceSha, f.sourceSha);
  assert.equal(result.artifacts.length, 4);
  for (const artifact of result.artifacts) {
    const content = fs.readFileSync(path.join(f.directory, artifact.name));
    assert.equal(artifact.size, content.length);
    assert.equal(artifact.sha256, crypto.createHash('sha256').update(content).digest('hex'));
  }
});

for (const corruption of ['missing', 'extra', 'empty', 'symlink', 'source', 'version']) {
  test(`${corruption} 制品或来源异常时不生成可交付清单`, async (t) => {
    const f = fixture(t);
    const target = path.join(f.directory, f.names[0]);
    if (corruption === 'missing') fs.unlinkSync(target);
    if (corruption === 'extra') fs.writeFileSync(path.join(f.directory, 'unexpected.exe'), 'extra');
    if (corruption === 'empty') fs.writeFileSync(target, '');
    if (corruption === 'symlink') {
      fs.unlinkSync(target);
      fs.symlinkSync(path.join(f.directory, f.names[1]), target);
    }
    if (corruption === 'source') f.sourceSha = 'b'.repeat(40);
    if (corruption === 'version') f.version = '0.6.3';
    await assert.rejects(verifyManualArtifacts(f.directory, f.manifestPath, f.version, f.sourceSha));
    assert.equal(fs.existsSync(f.manifestPath), false);
  });
}
