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
  assert.match(publishStep, /LINUX_DEB_ENABLED: \$\{\{ contains\(inputs\.platforms, 'linux'\) && inputs\.linux_package == 'deb' \}\}/);
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

  assert.match(macMetadataStep, /if \[ "\$DESKTOP_VARIANT" != "deepseek-agent" \]; then[\s\S]*FLOATBOAT_VERSION/);
  assert.match(windowsMetadataStep, /if \[ "\$DESKTOP_VARIANT" != "deepseek-agent" \]; then[\s\S]*Floatboat-Setup/);
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

test('通用 Linux 只用 deb maker 打包，且不向 pnpm 脚本透传 --', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const step = readNamedStep(workflow, 'Build and package ${{ matrix.display_name }} (Linux ${{ matrix.arch }})');
  assert.match(step, /run: pnpm run forge:make:linux:deb --platform linux --arch \$\{\{ matrix\.arch \}\}\n/);
  assert.doesNotMatch(step, /run: pnpm run [^\n]* -- /);
  assert.doesNotMatch(step, /@electron-forge\/maker-/);
});

test('正式通用 Linux deb 会随 stable 制品上传 S3', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const publishStep = readNamedStep(workflow, 'Publish and verify stable updater feeds');

  assert.match(publishStep, /LINUX_DEB_ENABLED: \$\{\{ contains\(inputs\.platforms, 'linux'\) && inputs\.linux_package == 'deb' \}\}/);
});

test('正式通用 Linux deb 会同步到官网 UOS fallback 下载地址', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const websiteStep = readNamedStep(workflow, 'Sync Floatboat website installer URLs');

  assert.match(websiteStep, /LINUX_DEB_ENABLED: \$\{\{ contains\(inputs\.platforms, 'linux'\) && inputs\.linux_package == 'deb' \}\}/);
  assert.match(websiteStep, /Floatboat-\$\{VERSION\}-amd64\.deb/);
  assert.match(websiteStep, /Floatboat-\$\{VERSION\}-arm64\.deb/);
  assert.match(websiteStep, /DOWNLOAD_UOS_AMD64_INSTALLER_URL: \$linux_amd64/);
  assert.match(websiteStep, /DOWNLOAD_UOS_ARM64_INSTALLER_URL: \$linux_arm64/);
  assert.match(websiteStep, /\.data\.DOWNLOAD_UOS_AMD64_INSTALLER_URL == \$linux_amd64/);
  assert.match(websiteStep, /\.data\.DOWNLOAD_UOS_ARM64_INSTALLER_URL == \$linux_arm64/);
});

test('正式 UOS deb 会上传 S3 并同步后端 UOS 下载地址', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const uosStep = readNamedStep(workflow, 'Publish UOS packages and sync installer URLs');

  assert.match(workflow, /publish-linux-uos:[\s\S]*inputs\.linux_package == 'uos-floatboat'/);
  assert.match(uosStep, /s3:\/\/\$\{RELEASE_BUCKET\}\/\$\{key\}/);
  assert.match(uosStep, /DOWNLOAD_UOS_AMD64_INSTALLER_URL: \$amd64/);
  assert.match(uosStep, /DOWNLOAD_UOS_ARM64_INSTALLER_URL: \$arm64/);
  assert.match(uosStep, /\.data\.DOWNLOAD_UOS_AMD64_INSTALLER_URL == \$amd64/);
  assert.match(uosStep, /\.data\.DOWNLOAD_UOS_ARM64_INSTALLER_URL == \$arm64/);
});

test('Nightly release-profile 完整应用发布 internal/nightly 并自动接管轨道', () => {
  const workflow = fs.readFileSync(nightlyWorkflowPath, 'utf8');
  const publishStep = readNamedStep(workflow, 'Publish and verify internal nightly updater');
  assert.doesNotMatch(workflow, /internal_preferred_prerelease/);
  assert.match(publishStep, /build_profile == 'release'/);
  assert.match(publishStep, /package_set != 'launcher'/);
  assert.match(publishStep, /TRACK: nightly/);
  assert.doesNotMatch(publishStep, /PREFERRED_PRERELEASE/);
  assert.match(publishStep, /publish-internal-updater\.sh/);
});

test('RC 仅在 release Floatboat 及完整 macOS Windows 构建时发布 internal/rc', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const publishStep = readNamedStep(workflow, 'Publish and verify internal RC updater');
  assert.doesNotMatch(workflow, /internal_preferred_prerelease/);
  assert.match(publishStep, /inputs\.is_rc == true/);
  assert.match(publishStep, /inputs\.build_profile == 'release'/);
  assert.match(publishStep, /desktop_variant == 'floatboat'/);
  assert.match(publishStep, /contains\(inputs\.platforms, 'macos'\)/);
  assert.match(publishStep, /contains\(inputs\.platforms, 'windows'\)/);
  assert.match(publishStep, /TRACK: rc/);
  assert.doesNotMatch(publishStep, /PREFERRED_PRERELEASE/);
});


test('Nightly 只构建 Floatboat macOS arm64 与 Windows x64 应用包', () => {
  const workflow = fs.readFileSync(nightlyWorkflowPath, 'utf8');
  const macJob = workflow.slice(workflow.indexOf('  build-macos-arm64:'), workflow.indexOf('  build-macos-x64:'));
  const windowsJob = workflow.slice(workflow.indexOf('  build-windows:'), workflow.indexOf('  build-test-launcher-macos-arm64:'));
  const verifyStep = readNamedStep(workflow, 'Verify complete Desktop artifact set');

  assert.doesNotMatch(macJob, /deepseek-agent|Floatboat DeepSeek Agent/);
  assert.doesNotMatch(windowsJob, /deepseek-agent|Floatboat DeepSeek Agent/);
  assert.match(workflow, /PACKAGE_SET="app"/);
  assert.match(workflow, /platforms=macos,windows/);
  assert.match(verifyStep, /expected 2/);
  assert.doesNotMatch(verifyStep, /DEEPSEEK|DeepSeek/);
  assert.match(workflow, /build-macos-x64:[\s\S]*if: \$\{\{ false \}\}/);
});

test('RC 强制 Floatboat app 范围并只接受 macOS arm64 与 Windows x64', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const scopeStep = readNamedStep(workflow, 'Resolve release scope');
  const packageStep = readNamedStep(workflow, 'Resolve package set');
  const publishStep = readNamedStep(workflow, 'Publish and verify internal RC updater');
  const macX64Job = workflow.slice(workflow.indexOf('  build-macos-x64:'), workflow.indexOf('  build-windows:'));

  assert.match(scopeStep, /RC publishing requires desktop_variant=floatboat/);
  assert.match(scopeStep, /RC publishing requires exactly macos,windows/);
  assert.match(packageStep, /RC publishing requires package_set=app/);
  assert.match(macX64Job, /inputs\.is_rc == false/);
  assert.match(publishStep, /desktop_variant == 'floatboat'/);
  assert.doesNotMatch(publishStep, /desktop_variant == 'all'/);
});

test('Floatboat-only 飞书通知只列 Floatboat 制品并隐藏 DeepSeek 版本', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const notifyStep = readNamedStep(workflow, 'Send Feishu notification');

  assert.match(notifyStep, /has_floatboat = desktop_variant in \("all", "floatboat"\)/);
  assert.match(notifyStep, /has_deepseek = desktop_variant in \("all", "deepseek-agent"\)/);
  assert.match(notifyStep, /if has_floatboat:[\s\S]*Floatboat-\{floatboat_version\}-arm64\.dmg/);
  assert.match(notifyStep, /if has_deepseek:[\s\S]*Floatboat-DeepSeek-Agent-\{deepseek_version\}-arm64\.dmg/);
  assert.match(notifyStep, /floatboat_version_line/);
  assert.match(notifyStep, /deepseek_version_line/);
});
