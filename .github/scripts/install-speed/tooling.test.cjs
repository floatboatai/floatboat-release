// ABOUTME: 在不运行安装器的情况下验证性能工具的载荷边界、真实 ASAR 版本解析和 workflow 参数门禁。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { files, hash, within, asarVersion, addGeneratedFile } = require('./build-baseline.cjs');
const { verifyArchive } = require('./verify-electron-cache.cjs');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floatboat-performance-tooling-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('构建失败不会被依赖的退出清理回调改成成功', (t) => {
  const root = temporary(t);
  const preload = path.join(root, 'cleanup-hook.cjs');
  // async-exit-hook 在 beforeExit 后显式 exit(0)，重现构建器临时目录清理的退出行为。
  fs.writeFileSync(preload, "process.once('beforeExit', () => process.exit(0));\n");
  const result = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'build-baseline.cjs')], {
    env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8',
  });
  assert.match(result.stderr, /GitHub-hosted Windows runner/);
  assert.equal(result.status, 1, result.stdout + result.stderr);
});
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

test('Electron 缓存按包内摘要复核，成功时保留原文件', async (t) => {
  const root = temporary(t);
  const archive = path.join(root, 'electron.zip');
  const payload = Buffer.from([0, 1, 2, 3, 4]);
  fs.writeFileSync(archive, payload);
  const expected = hash(payload);
  assert.equal(await verifyArchive(archive, expected), expected);
  assert.deepEqual(fs.readFileSync(archive), payload);
});

test('Electron 缓存摘要不匹配必须失败且不改写文件', async (t) => {
  const root = temporary(t);
  const archive = path.join(root, 'electron.zip');
  fs.writeFileSync(archive, 'unexpected bytes');
  await assert.rejects(verifyArchive(archive, hash('official bytes')), /SHA256 不匹配/);
  assert.equal(fs.readFileSync(archive, 'utf8'), 'unexpected bytes');
});

test('Electron 缓存缺失或包内摘要无效均拒绝继续', async (t) => {
  const root = temporary(t);
  const archive = path.join(root, 'missing.zip');
  await assert.rejects(verifyArchive(archive, hash('official bytes')), /ENOENT/);
  for (const digest of [undefined, '', 'abc', 'z'.repeat(64)]) {
    await assert.rejects(verifyArchive(archive, digest), /缺少有效 SHA256/);
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

const workflow = fs.readFileSync(path.join(__dirname, '../../workflows/release.yml'), 'utf8');
test('镜像恢复仅作用于 Windows 对照任务，验证工具在依赖安装前移出源码目录', () => {
  const windows = workflow.split('\n  build-windows:\n')[1].split('\n  build-')[0];
  assert.equal((windows.match(/name: Checkout installation comparison tooling/g) || []).length, 1);
  assert.equal((windows.match(/name: Checkout Electron cache verification tooling/g) || []).length, 1);
  const checkout = windows.indexOf('name: Checkout Electron cache verification tooling');
  const isolate = windows.indexOf('name: Isolate Electron cache verification tooling');
  const install = windows.indexOf('name: Install dependencies');
  const verify = windows.indexOf('name: Verify Electron mirror cache for installation comparison');
  const build = windows.indexOf('name: Build and package');
  assert.ok(checkout < isolate && isolate < install && install < verify && verify < build);
  const isolation = windows.slice(isolate, install);
  assert.match(isolation, /Move-Item -LiteralPath 'electron-cache-tooling\/\.github\/scripts\/install-speed\/verify-electron-cache\.cjs' -Destination "\$env:RUNNER_TEMP\/verify-electron-cache\.cjs"/);
  assert.match(isolation, /Remove-Item -LiteralPath 'electron-cache-tooling' -Recurse -Force/);
  assert.ok(windows.indexOf('name: Checkout installation comparison tooling') > windows.indexOf('name: Upload Windows artifacts'));
  const installation = windows.slice(install, verify);
  assert.match(installation, /npm_config_electron_mirror: \$\{\{ inputs\.compare_install_speed == true && 'https:\/\/npmmirror\.com\/mirrors\/electron\/' \|\| '' \}\}/);
  assert.match(installation, /npm_config_electron_custom_dir: \$\{\{ inputs\.compare_install_speed == true && '\{\{ version \}\}' \|\| '' \}\}/);
  assert.match(installation, /run: pnpm install --frozen-lockfile/);
  const verification = windows.slice(verify).split('\n      - name:')[0];
  assert.match(verification, /if: inputs\.compare_install_speed == true/);
  assert.match(verification, /run: node "\$env:RUNNER_TEMP\/verify-electron-cache\.cjs"/);
  assert.doesNotMatch(workflow.replace(windows, ''), /npm_config_electron_mirror/);
});
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
