// ABOUTME: 验证测试包按选择的平台完整交付，并拒绝漏包、混包和无效来源身份。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyTestArtifacts } = require('./verify-test-artifacts.cjs');

const version = '0.6.7-test.2785';
const sourceSha = 'a'.repeat(40);
const macNames = [
  `Floatboat-${version}-arm64.dmg`, `Floatboat-${version}-x64.dmg`,
  `Floatboat-${version}-arm64.zip`, `Floatboat-${version}-x64.zip`,
];
const winName = `Floatboat-Setup-${version}-x64.exe`;

function fixture(names, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'test-artifacts-'));
  try {
    for (const name of names) fs.writeFileSync(path.join(directory, name), `package:${name}`);
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('双平台测试包必须同时有两个 Mac 安装包、两个 ZIP 和 Windows 安装包', () => {
  const names = [...macNames, winName];
  fixture(names, (directory) => {
    const result = verifyTestArtifacts({ directory, version, sourceSha, platforms: 'macos,windows' });
    assert.equal(result.sourceSha, sourceSha);
    assert.equal(result.version, version);
    assert.equal(result.artifacts.length, 5);
    assert.deepEqual(result.artifacts.map((artifact) => artifact.name).sort(), names.sort());
    for (const artifact of result.artifacts) {
      assert.ok(artifact.bytes > 0);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    }
  });
  for (const missing of names) fixture(names.filter((name) => name !== missing), (directory) => {
    assert.throws(() => verifyTestArtifacts({ directory, version, sourceSha, platforms: 'macos,windows' }), /测试制品集合不匹配/);
  });
});

test('保留 Windows-only，并允许 Mac-only 双架构，拒绝未请求平台和零字节包', () => {
  for (const [platforms, names] of [['windows', [winName]], ['macos', macNames]]) {
    fixture(names, (directory) => assert.equal(verifyTestArtifacts({ directory, version, sourceSha, platforms }).artifacts.length, names.length));
  }
  fixture([...macNames, winName], (directory) => {
    assert.throws(() => verifyTestArtifacts({ directory, version, sourceSha, platforms: 'windows' }), /测试制品集合不匹配/);
  });
  fixture([winName], (directory) => {
    fs.truncateSync(path.join(directory, winName));
    assert.throws(() => verifyTestArtifacts({ directory, version, sourceSha, platforms: 'windows' }), /空文件/);
  });
});

test('不接受正式版本、未固定 SHA、Linux 范围或混入 updater 元数据', () => {
  fixture([winName], (directory) => {
    const options = { directory, version, sourceSha, platforms: 'windows' };
    for (const override of [{ version: '0.6.7' }, { sourceSha: 'dev' }, { platforms: 'linux' }]) {
      assert.throws(() => verifyTestArtifacts({ ...options, ...override }));
    }
    fs.writeFileSync(path.join(directory, 'latest.yml'), 'version: 0.6.7');
    assert.throws(() => verifyTestArtifacts(options), /测试制品集合不匹配/);
  });
});

function inferenceReport(platform, arch) {
  return {
    passed: true, evidence: 'same-version-electron-utility-with-packaged-entry', sourceSha,
    platform, arch, model: 'campplus', packageVersion: version, packagedConfigurationVerified: true,
    modelSha256: 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11',
    modelBytes: 28281138, dimensions: 192, norm: 1, runtimeVersion: '2.0.1',
    bundledModelVerified: true, offlineInferenceVerified: true, emptyCacheAtStart: true,
    networkGuardActive: true, stages: [{ stage: 'bundled-copy', status: 'completed' }],
    electronVersion: '40.1.0', appAsarSha256: 'b'.repeat(64),
    nativePackage: `sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${arch}`,
  };
}

function withInferenceReports(run) {
  const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'test-inference-reports-'));
  try {
    for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
      fs.writeFileSync(path.join(reportDirectory, `speaker-runtime-${platform}-${arch}.json`), JSON.stringify(inferenceReport(platform, arch)));
    }
    return fixture([...macNames, winName], (directory) => run({ directory, reportDirectory, version, sourceSha,
      platforms: 'macos,windows', speakerEmbeddingModel: 'campplus' }));
  } finally {
    fs.rmSync(reportDirectory, { recursive: true, force: true });
  }
}

test('选择 CAM++ 时汇总绑定当前源码和三种目标架构的成功实际推理证据', () => {
  withInferenceReports((options) => {
    const manifest = verifyTestArtifacts(options);
    assert.equal(manifest.speakerEmbeddingModel, 'campplus');
    assert.equal(manifest.speakerRuntimeReports.length, 3);
    assert.deepEqual(manifest.speakerRuntimeReports.map((report) => [report.platform, report.arch]),
      [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]);
    for (const report of manifest.speakerRuntimeReports) assert.match(report.sha256, /^[a-f0-9]{64}$/);
  });
});

test('CAM++ 汇总拒绝缺报、失败、错来源、错架构或其它模型的推理结果', () => {
  for (const override of [
    { passed: false }, { sourceSha: 'c'.repeat(40) }, { arch: 'arm64' }, { model: 'wavlm' },
    { packageVersion: '0.6.7' }, { packagedConfigurationVerified: false }, { dimensions: 512 },
    { modelSha256: 'd'.repeat(64) }, { runtimeVersion: '1.0.0' }, { norm: 0 },
    { bundledModelVerified: false }, { offlineInferenceVerified: false }, { emptyCacheAtStart: false },
    { networkGuardActive: false }, { stages: [] }, { stages: undefined },
    { stages: [{ stage: 'bundled-copy', status: 'completed' }, { stage: 'download', status: 'started' }] },
  ]) {
    withInferenceReports((options) => {
      fs.writeFileSync(path.join(options.reportDirectory, 'speaker-runtime-win32-x64.json'),
        JSON.stringify({ ...inferenceReport('win32', 'x64'), ...override }));
      assert.throws(() => verifyTestArtifacts(options), /CAM\+\+ 推理报告/, JSON.stringify(override));
    });
  }
  withInferenceReports((options) => {
    fs.unlinkSync(path.join(options.reportDirectory, 'speaker-runtime-darwin-x64.json'));
    assert.throws(() => verifyTestArtifacts(options), /CAM\+\+ 推理报告/);
  });
  withInferenceReports((options) => {
    assert.throws(() => verifyTestArtifacts({ ...options, reportDirectory: undefined }), /CAM\+\+ 推理报告/);
  });
});
