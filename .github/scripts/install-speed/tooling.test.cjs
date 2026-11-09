// ABOUTME: 在不运行安装器的情况下验证性能工具的载荷边界、真实 ASAR 版本解析和 workflow 参数门禁。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { files, hash, within, asarVersion, addGeneratedFile } = require('./build-baseline.cjs');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floatboat-performance-tooling-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('载荷变化改变摘要，路径边界拒绝同前缀外部目录', (t) => {
  const root = temporary(t);
  const payload = path.join(root, 'payload'); fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, 'a.bin'), Buffer.from([0, 1, 2]));
  const before = files(payload);
  fs.writeFileSync(path.join(payload, 'a.bin'), Buffer.from([0, 1, 3]));
  assert.notEqual(hash(JSON.stringify(before)), hash(JSON.stringify(files(payload))));
  assert.equal(within(path.join(payload, 'child'), payload), true);
  assert.equal(within(path.join(root, 'payload-extra', 'child'), payload), false);
});
test('载荷不允许沿符号链接读取外部目录', (t) => {
  const root = temporary(t);
  const payload = path.join(root, 'payload'); fs.mkdirSync(payload);
  fs.symlinkSync(root, path.join(payload, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => files(payload), /链接载荷/);
});
test('从实际 ASAR package.json 读取版本，并拒绝截断文件', (t) => {
  const root = temporary(t);
  const pkg = Buffer.from(JSON.stringify({ version: '0.6.4-test.2' }));
  const header = Buffer.from(JSON.stringify({ files: { 'package.json': { size: pkg.length, offset: '0' } } }));
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(8 + header.length, 4); prefix.writeUInt32LE(header.length, 12);
  const file = path.join(root, 'app.asar');
  fs.writeFileSync(file, Buffer.concat([prefix, header, pkg]));
  assert.equal(asarVersion(file), '0.6.4-test.2');
  fs.truncateSync(file, 18);
  assert.throws(() => asarVersion(file), /truncated/);
});
test('NSIS 生成图标可复用同字节载荷，拒绝覆盖不同内容', (t) => {
  const root = temporary(t);
  const source = path.join(root, 'markdown.ico'); fs.writeFileSync(source, 'icon bytes');
  const manifest = { installedFiles: [] };
  addGeneratedFile(manifest, 'resources/markdown.ico', source, root);
  addGeneratedFile(manifest, 'resources/markdown.ico', source, root);
  assert.equal(manifest.installedFiles.length, 1);
  fs.writeFileSync(source, 'different icon');
  assert.throws(() => addGeneratedFile(manifest, 'resources/markdown.ico', source, root), /冲突/);
});

const workflow = fs.readFileSync(path.join(__dirname, '../../workflows/release.yml'), 'utf8');
const scope = workflow.split('      - name: Resolve release scope\n')[1].split('\n      - name:')[0];
const script = scope.split('        run: |\n')[1].split('\n').map((line) => line.replace(/^          /, '')).join('\n');
const defaultInputs = {
  INPUT_COMPARE_INSTALL_SPEED: 'true', INPUT_VERSION: '0.6.4-test.2', INPUT_IS_RC: 'false',
  INPUT_BUILD_PROFILE: 'release', INPUT_DESKTOP_VARIANT: 'floatboat', INPUT_PLATFORMS: 'windows',
  INPUT_LINUX_PACKAGE: 'deb-and-uos', INPUT_UPLOAD_UOS_STORE: 'false', INPUT_PROMOTE_MERGED_BUGS: 'false',
  INPUT_PACKAGE_SET: 'app', INPUT_NOTIFY_ONLY: 'false',
};
for (const [label, changes, expectedSuccess] of [
  ['签名 Windows test app', {}, true],
  ['RC 版本', { INPUT_VERSION: '0.6.4-rc.1', INPUT_IS_RC: 'true' }, false],
  ['测试服务器 profile', { INPUT_BUILD_PROFILE: 'test' }, false],
  ['macOS 平台', { INPUT_PLATFORMS: 'macos,windows' }, false],
  ['额外 launcher 包', { INPUT_PACKAGE_SET: 'all' }, false],
  ['仅通知', { INPUT_NOTIFY_ONLY: 'true' }, false],
  ['默认关闭时的正常 stable', { INPUT_COMPARE_INSTALL_SPEED: 'false', INPUT_VERSION: '0.6.4', INPUT_DESKTOP_VARIANT: 'all', INPUT_PLATFORMS: 'macos,windows' }, true],
]) {
  test(`实际 release scope 脚本：${label}`, (t) => {
    const root = temporary(t);
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, ...defaultInputs, ...changes, GITHUB_OUTPUT: path.join(root, 'output') }, encoding: 'utf8' });
    assert.equal(result.status === 0, expectedSuccess, result.stdout + result.stderr);
  });
}
