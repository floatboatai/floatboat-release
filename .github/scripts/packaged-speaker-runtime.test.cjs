// ABOUTME: 检查包内模型选择、来源和架构拒绝边界，避免错误包通过真实推理门禁。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MODEL, validatePackagedConfiguration, validatePackagedVersion, getPackagedRuntimeRelative, validateModelBytes, verifyBundledModel, parseArguments, runVerification } = require('./packaged-speaker-runtime.cjs');
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-probe-test-'));
  const identity = { buildSha: 'a'.repeat(40), platform: 'darwin', arch: 'arm64', electronVersion: '39.4.0' };
  fs.mkdirSync(path.join(root, 'evidence'));
  fs.writeFileSync(path.join(root, 'evidence/build-identity.json'), JSON.stringify(identity));
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=must-not-be-reported\nAOE_SPEAKER_EMBEDDING_MODEL=campplus\n');
  fs.writeFileSync(path.join(root, 'app.asar'), 'fixture');
  const input = { resources: root, sourceSha: identity.buildSha, platform: identity.platform, arch: identity.arch };
  try { run(input, identity); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('验证来源与唯一模型声明，不把环境中其他设置放入结果', () => fixture((input) => {
  const result = validatePackagedConfiguration(input);
  assert.equal(result.identity.buildSha, input.sourceSha);
  assert.ok(!JSON.stringify(result).includes('must-not-be-reported'));
  for (const value of ['wavlm', '', 'campplus\nAOE_SPEAKER_EMBEDDING_MODEL=wavlm']) {
    fs.writeFileSync(path.join(input.resources, '.env'), `AOE_SPEAKER_EMBEDDING_MODEL=${value}\n`);
    assert.throws(() => validatePackagedConfiguration(input), /PACKAGED_MODEL/u);
  }
}));
test('拒绝不同来源SHA、平台或架构，不能拿其他包冒充当前构建', () => fixture((input) => {
  assert.throws(() => validatePackagedConfiguration({ ...input, sourceSha: 'b'.repeat(40) }), /SOURCE_SHA_MISMATCH/u);
  assert.throws(() => validatePackagedConfiguration({ ...input, arch: 'x64' }), /PACKAGE_ARCH_MISMATCH/u);
  assert.throws(() => validatePackagedConfiguration({ ...input, platform: 'win32', arch: 'x64' }), /PACKAGE_PLATFORM_MISMATCH/u);
  assert.throws(() => validatePackagedConfiguration({ ...input, platform: 'linux' }), /UNSUPPORTED_TARGET/u);
}));
test('拒绝残缺及同大小伪造模型', () => {
  assert.throws(() => validateModelBytes(Buffer.alloc(4)), /MODEL_SIZE_MISMATCH/u);
  assert.throws(() => validateModelBytes(Buffer.alloc(MODEL.bytes)), /MODEL_SHA256_MISMATCH/u);
});
test('测试完整版本取自包内清单，同时核对构建身份中的基础版本', () => {
  assert.equal(validatePackagedVersion('0.6.7-test.2785', '0.6.7'), '0.6.7-test.2785');
  assert.throws(() => validatePackagedVersion('0.6.7-test.2785', '0.6.6'), /PACKAGE_IDENTITY_VERSION_MISMATCH/u);
  assert.throws(() => validatePackagedVersion('0.6.7', '0.6.7'), /PACKAGED_TEST_VERSION_REQUIRED/u);
  assert.throws(() => validatePackagedVersion(undefined, '0.6.7'), /PACKAGED_TEST_VERSION_REQUIRED/u);
});
test('Windows 普通路径与命名空间路径均严格按同一 ASAR 判断', () => {
  const archive = 'D:\\a\\floatboat-release\\out\\Floatboat-win32-x64\\resources\\app.asar';
  const nested = 'node_modules\\.pnpm\\sherpa-onnx-node@2.0.1\\node_modules\\sherpa-onnx-node\\sherpa-onnx.js';
  assert.equal(getPackagedRuntimeRelative(archive, `${archive}\\node_modules\\sherpa-onnx-node\\sherpa-onnx.js`, 'win32'), 'node_modules/sherpa-onnx-node/sherpa-onnx.js');
  assert.equal(getPackagedRuntimeRelative(`\\\\?\\${archive}`, `${archive}\\${nested}`, 'win32'), nested.replaceAll('\\', '/'));
  assert.equal(getPackagedRuntimeRelative(archive, `\\\\?\\${archive}\\.vite\\build\\node_modules\\sherpa-onnx-node\\sherpa-onnx.js`, 'win32'), '.vite/build/node_modules/sherpa-onnx-node/sherpa-onnx.js');
  assert.equal(getPackagedRuntimeRelative('\\\\server\\share\\app.asar', '\\\\?\\UNC\\server\\share\\app.asar\\node_modules\\sherpa-onnx-node\\sherpa-onnx.js', 'win32'), 'node_modules/sherpa-onnx-node/sherpa-onnx.js');
});
test('拒绝 ASAR 之外的依赖、相邻解包目录、其他磁盘和目录穿越', () => {
  const archive = 'D:\\a\\out\\resources\\app.asar';
  for (const runtime of [
    'D:\\a\\node_modules\\sherpa-onnx-node\\sherpa-onnx.js',
    `${archive}.unpacked\\node_modules\\sherpa-onnx-node\\sherpa-onnx.js`,
    'C:\\node_modules\\sherpa-onnx-node\\sherpa-onnx.js',
    `${archive}\\node_modules\\..\\..\\sherpa-onnx.js`,
    archive,
  ]) assert.throws(() => getPackagedRuntimeRelative(archive, runtime, 'win32'), /RUNTIME_RESOLVED_OUTSIDE_PACKAGE/u);
  assert.throws(() => getPackagedRuntimeRelative('/app/resources/app.asar', '/app/node_modules/sherpa-onnx-node/sherpa-onnx.js', 'darwin'), /RUNTIME_RESOLVED_OUTSIDE_PACKAGE/u);
});
test('参数需要精确资源、Electron、来源和目标，不接受重复或未知参数', () => {
  const args = ['--resources', '/tmp/package', '--electron', '/tmp/electron', '--source-sha', 'a'.repeat(40), '--platform', 'darwin', '--arch', 'x64', '--report', '/tmp/result.json'];
  assert.equal(parseArguments(args).arch, 'x64');
  assert.throws(() => parseArguments([...args, '--arch', 'arm64']), /INVALID_ARGUMENTS/u);
  assert.throws(() => parseArguments([...args, '--skip-probe', 'true']), /INVALID_ARGUMENTS/u);
  assert.throws(() => parseArguments(args.slice(0, -2)), /MISSING_REPORT/u);
});

test('随包模型缺失不能退回联网下载，失败覆盖旧成功报告', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-offline-failure-'));
  try {
    await assert.rejects(verifyBundledModel(root), /ENOENT/u);
    const report = path.join(root, 'report.json');
    fs.writeFileSync(report, JSON.stringify({ passed: true, dimensions: 192 }));
    await assert.rejects(runVerification({
      resources: root, sourceSha: 'a'.repeat(40), platform: 'darwin', arch: 'arm64',
      electron: '/unused', report,
    }));
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(result.passed, false);
    assert.equal(result.dimensions, undefined);
    assert.equal(result.model, 'campplus');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
