#!/usr/bin/env node
// ABOUTME: 校验正式环境测试包的完整平台集合，并生成绑定源码 SHA 的摘要清单。
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { MODEL, RUNTIME_VERSION } = require('./packaged-speaker-runtime.cjs');

function verifySpeakerRuntimeReports({ reportDirectory, selected, version, sourceSha }) {
  if (!reportDirectory || !fs.existsSync(reportDirectory)) throw new Error('缺少 CAM++ 推理报告目录');
  const targets = [];
  if (selected.includes('macos')) targets.push(['darwin', 'arm64'], ['darwin', 'x64']);
  if (selected.includes('windows')) targets.push(['win32', 'x64']);
  const names = targets.map(([platform, arch]) => `speaker-runtime-${platform}-${arch}.json`);
  if (JSON.stringify(fs.readdirSync(reportDirectory).sort()) !== JSON.stringify([...names].sort())) {
    throw new Error('CAM++ 推理报告必须完整且只包含所选平台');
  }
  return targets.map(([platform, arch], index) => {
    const name = names[index];
    const reportPath = path.join(reportDirectory, name);
    const stat = fs.lstatSync(reportPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > 256 * 1024) throw new Error(`CAM++ 推理报告文件无效：${name}`);
    const bytes = fs.readFileSync(reportPath);
    const report = JSON.parse(bytes.toString('utf8'));
    if (report.passed !== true || report.evidence !== 'same-version-electron-utility-with-packaged-entry' ||
        report.sourceSha !== sourceSha || report.platform !== platform || report.arch !== arch ||
        report.model !== 'campplus' || report.packageVersion !== version || report.packagedConfigurationVerified !== true ||
        report.bundledModelVerified !== true || report.offlineInferenceVerified !== true || report.emptyCacheAtStart !== true ||
        report.networkGuardActive !== true || !Array.isArray(report.stages) ||
        !report.stages.some((stage) => stage.stage === 'bundled-copy' && stage.status === 'completed') ||
        report.stages.some((stage) => stage.stage === 'download') ||
        report.modelSha256 !== MODEL.sha256 || report.modelBytes !== MODEL.bytes || report.dimensions !== MODEL.dimensions ||
        !Number.isFinite(report.norm) || Math.abs(report.norm - 1) > 0.001 || report.runtimeVersion !== RUNTIME_VERSION ||
        report.nativePackage !== `sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${arch}` || !/^[0-9a-f]{64}$/.test(report.appAsarSha256) ||
        !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(report.electronVersion)) {
      throw new Error(`CAM++ 推理报告未通过当前包的身份与实际推理校验：${name}`);
    }
    return { name, bytes: stat.size, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      platform, arch, model: report.model, dimensions: report.dimensions, modelSha256: report.modelSha256,
      runtimeVersion: report.runtimeVersion, electronVersion: report.electronVersion, appAsarSha256: report.appAsarSha256,
      bundledModelVerified: true, offlineInferenceVerified: true, emptyCacheAtStart: true, networkGuardActive: true };
  });
}

function verifyTestArtifacts({ directory, version, sourceSha, platforms, speakerEmbeddingModel = 'default', reportDirectory }) {
  if (!/^\d+\.\d+\.\d+-test\.\d+$/.test(version)) throw new Error('测试制品必须使用 -test.N 版本');
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error('测试制品必须绑定完整源码 SHA');
  if (!['macos', 'windows', 'macos,windows'].includes(platforms)) throw new Error('不支持的测试平台范围');
  if (!['default', 'campplus'].includes(speakerEmbeddingModel)) throw new Error('不支持的测试声纹模型');
  const selected = platforms.split(',');
  const expected = [];
  if (selected.includes('macos')) {
    for (const arch of ['arm64', 'x64']) for (const extension of ['dmg', 'zip']) {
      expected.push(`Floatboat-${version}-${arch}.${extension}`);
    }
  }
  if (selected.includes('windows')) expected.push(`Floatboat-Setup-${version}-x64.exe`);
  const actual = fs.readdirSync(directory).sort();
  expected.sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`测试制品集合不匹配；应有 ${expected.join(', ')}；实际 ${actual.join(', ')}`);
  }
  const artifacts = actual.map((name) => {
    const artifactPath = path.join(directory, name);
    const stat = fs.lstatSync(artifactPath);
    if (!stat.isFile() || stat.size === 0) throw new Error(`测试制品不是普通文件或为空文件：${name}`);
    // 安装包可达数 GB，按块计算摘要，避免聚合任务一次性读入整个文件。
    const hash = crypto.createHash('sha256');
    const handle = fs.openSync(artifactPath, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    try {
      let bytes;
      while ((bytes = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    } finally {
      fs.closeSync(handle);
    }
    return { name, bytes: stat.size, sha256: hash.digest('hex') };
  });
  const speakerRuntimeReports = speakerEmbeddingModel === 'campplus'
    ? verifySpeakerRuntimeReports({ reportDirectory, selected, version, sourceSha }) : [];
  return { schemaVersion: 1, version, sourceSha, platforms: selected, speakerEmbeddingModel, artifacts, speakerRuntimeReports };
}

if (require.main === module) {
  const manifest = verifyTestArtifacts({
    directory: process.argv[2], version: process.env.FLOATBOAT_VERSION,
    sourceSha: process.env.SOURCE_SHA, platforms: process.env.PLATFORMS,
    speakerEmbeddingModel: process.env.SPEAKER_EMBEDDING_MODEL || 'default', reportDirectory: process.argv[4],
  });
  const output = process.argv[3];
  if (!output) throw new Error('缺少测试制品清单输出路径');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Test packages\n\nSource: \`${manifest.sourceSha}\`\n\n` +
      manifest.artifacts.map((artifact) => `- ${artifact.name} (${artifact.bytes} bytes, SHA256 \`${artifact.sha256}\`)`).join('\n') + '\n');
  }
  console.log(`Verified ${manifest.artifacts.length} test artifacts for ${manifest.platforms.join(', ')}`);
}

module.exports = { verifyTestArtifacts };
