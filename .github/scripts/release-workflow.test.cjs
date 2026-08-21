#!/usr/bin/env node
// ABOUTME: 锁定正式发布才会执行双变体 S3 updater 发布脚本。

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowPath = path.join(__dirname, '..', 'workflows', 'release.yml');
const nightlyWorkflowPath = path.join(__dirname, '..', 'workflows', 'nightly.yml');

function readNamedStep(workflow, stepName) {
  const startMarker = `      - name: ${stepName}`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `workflow 缺少步骤：${stepName}`);
  const nextStep = workflow.indexOf('\n      - name:', start + startMarker.length);
  return workflow.slice(start, nextStep === -1 ? workflow.length : nextStep);
}

test('只有正式 release 会发布并验证选定范围的 stable feed', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const publishStep = readNamedStep(workflow, 'Publish and verify stable updater feeds');

  assert.match(publishStep, /inputs\.is_rc == false/);
  assert.match(publishStep, /inputs\.build_profile == 'release'/);
  assert.match(publishStep, /needs\.prepare\.outputs\.package_set != 'launcher'/);
  assert.match(publishStep, /DESKTOP_VARIANT: \$\{\{ needs\.prepare\.outputs\.desktop_variant \}\}/);
  assert.match(publishStep, /FLOATBOAT_VERSION: \$\{\{ needs\.prepare\.outputs\.floatboat_version \}\}/);
  assert.match(publishStep, /DEEPSEEK_VERSION: \$\{\{ needs\.prepare\.outputs\.deepseek_version \}\}/);
  assert.match(publishStep, /bash release-tooling\/\.github\/scripts\/publish-stable-updater\.sh/);
});

test('DeepSeek-only 使用独立矩阵与 release tag，并跳过 Floatboat 网站同步', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const scopeStep = readNamedStep(workflow, 'Resolve release scope');
  const websiteStep = readNamedStep(workflow, 'Sync Floatboat website installer URLs');
  const githubReleaseStep = readNamedStep(workflow, 'Create GitHub Release');

  assert.match(workflow, /desktop_variant:[\s\S]*default: "all"[\s\S]*- "deepseek-agent"/);
  assert.match(scopeStep, /release_tag="deepseek-v\$\{INPUT_VERSION\}"/);
  assert.match(scopeStep, /desktop_matrix='\{"include":\[\{"variant":"deepseek-agent"/);
  assert.match(scopeStep, /DeepSeek-only publishing is restricted to official release-profile builds/);
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.prepare\.outputs\.desktop_matrix\) \}\}/);
  assert.match(websiteStep, /needs\.prepare\.outputs\.desktop_variant == 'all'/);
  assert.match(githubReleaseStep, /tag_name: \$\{\{ needs\.prepare\.outputs\.release_tag \}\}/);
});

test('DeepSeek-only 生成和验证元数据时不会生成 Floatboat latest 文件', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const macMetadataStep = readNamedStep(workflow, 'Generate macOS Update Metadata');
  const windowsMetadataStep = readNamedStep(workflow, 'Generate Windows Update Metadata');
  const verifyStep = readNamedStep(workflow, 'Verify generated update metadata');

  assert.match(macMetadataStep, /if \[ "\$DESKTOP_VARIANT" = "all" \]; then[\s\S]*FLOATBOAT_VERSION/);
  assert.match(windowsMetadataStep, /if \[ "\$DESKTOP_VARIANT" = "all" \]; then[\s\S]*Floatboat-Setup/);
  assert.match(verifyStep, /DeepSeek-only publishing must not generate Floatboat updater metadata/);
});

test('macOS 发布打包会在外部签名或公证瞬时失败时进行三轮有界重试', () => {
  const workflows = [
    {
      path: workflowPath,
      steps: [
        'Build and package ${{ matrix.display_name }} (arm64)',
        'Build and package ${{ matrix.display_name }} (x64)',
      ],
    },
    {
      path: nightlyWorkflowPath,
      steps: ['Build ${{ matrix.display_name }} arm64', 'Build ${{ matrix.display_name }} x64'],
    },
  ];

  for (const workflowConfig of workflows) {
    const workflow = fs.readFileSync(workflowConfig.path, 'utf8');
    for (const stepName of workflowConfig.steps) {
      const packagingStep = readNamedStep(workflow, stepName);
      const location = `${path.basename(workflowConfig.path)}: ${stepName}`;

      assert.ok(packagingStep.includes('for attempt in 1 2 3; do'), `${location} 必须最多尝试三轮`);
      assert.ok(packagingStep.includes('if [ "$attempt" -eq 3 ]; then'), `${location} 必须在第三轮后失败`);
      assert.ok(
        packagingStep.includes('packaging attempt ${attempt}/3 failed'),
        `${location} 必须记录当前重试轮次`,
      );
      assert.ok(packagingStep.includes('hdiutil detach'), `${location} 重试前必须清理 DMG 挂载`);
      assert.ok(packagingStep.includes('rm -rf out'), `${location} 重试前必须清理不完整产物`);
      assert.ok(packagingStep.includes('sleep $((attempt * 20))'), `${location} 必须递增等待外部服务恢复`);
    }
  }
});
