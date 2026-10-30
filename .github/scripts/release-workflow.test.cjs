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

function readNamedJob(workflow, jobName) {
  const startMarker = `  ${jobName}:\n`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `workflow 缺少 job：${jobName}`);
  const remaining = workflow.slice(start + startMarker.length);
  const nextJob = /\n  [a-z0-9-]+:\n/.exec(remaining);
  return workflow.slice(start, nextJob ? start + startMarker.length + nextJob.index : workflow.length);
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
  assert.match(publishStep, /LINUX_DEB_ENABLED: \$\{\{ contains\(inputs\.platforms, 'linux'\) && \(inputs\.linux_package == 'deb' \|\| inputs\.linux_package == 'deb-and-uos'\) \}\}/);
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
  assert.match(scopeStep, /"macos,windows"\) ;;/);
  assert.match(scopeStep, /DeepSeek-only official publishing does not support Linux/);
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

test('通用 Linux 固定只构建 Floatboat amd64 与 arm64', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const scopeStep = readNamedStep(workflow, 'Resolve release scope');
  const job = readNamedJob(workflow, 'build-linux');
  const buildStep = readNamedStep(job, 'Build and package Floatboat (Linux ${{ matrix.arch }})');
  const matrixMatch = /linux_matrix='([^']+)'/.exec(scopeStep);

  assert.ok(matrixMatch, 'Resolve release scope 必须声明独立的 Floatboat Linux matrix');
  assert.deepEqual(JSON.parse(matrixMatch[1]).include, [
    { variant: 'floatboat', display_name: 'Floatboat', artifact_base: 'Floatboat', app_name: 'Floatboat', arch: 'x64', debArch: 'amd64', runner: 'ubuntu-latest' },
    { variant: 'floatboat', display_name: 'Floatboat', artifact_base: 'Floatboat', app_name: 'Floatboat', arch: 'arm64', debArch: 'arm64', runner: 'ubuntu-24.04-arm' },
  ]);
  assert.match(job, /needs\.prepare\.outputs\.desktop_variant != 'deepseek-agent'/);
  assert.match(job, /inputs\.linux_package == 'deb-and-uos'/);
  assert.doesNotMatch(job, /Floatboat-DeepSeek|deepseek_version|matrix\.variant ==/);
  assert.match(buildStep, /run: pnpm run forge:make:linux:deb --platform linux --arch \$\{\{ matrix\.arch \}\}\n/);
  assert.doesNotMatch(buildStep, /run: pnpm run [^\n]* -- /);
  assert.doesNotMatch(buildStep, /@electron-forge\/maker-/);
});

test('正式通用 Linux 双架构 deb 会随 stable 制品上传 S3', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const publishStep = readNamedStep(workflow, 'Publish and verify stable updater feeds');

  assert.match(publishStep, /LINUX_DEB_ENABLED: \$\{\{ contains\(inputs\.platforms, 'linux'\) && \(inputs\.linux_package == 'deb' \|\| inputs\.linux_package == 'deb-and-uos'\) \}\}/);
});

test('通用 Linux 不覆盖官网 UOS 专包下载地址', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const websiteStep = readNamedStep(workflow, 'Sync Floatboat website installer URLs');

  assert.doesNotMatch(websiteStep, /LINUX_DEB_ENABLED|DOWNLOAD_UOS_|Floatboat-\$\{VERSION\}-(?:amd64|arm64)\.deb/);
});

test('UOS 双架构送审包独立构建、强制 gzip 并同步专用下载地址', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const job = readNamedJob(workflow, 'build-linux-uos');
  const verifyStep = readNamedStep(job, 'Verify UOS package metadata and layout');
  const uploadStep = readNamedStep(job, 'Upload UOS artifacts');
  const publishJob = readNamedJob(workflow, 'publish-linux-uos');
  const uosStep = readNamedStep(workflow, 'Publish UOS packages and sync installer URLs');

  assert.match(workflow, /linux_package:[\s\S]*default: "deb-and-uos"[\s\S]*- "deb-and-uos"/);
  assert.match(job, /inputs\.linux_package == 'deb-and-uos'/);
  assert.match(job, /inputs\.desktop_variant != 'deepseek-agent'/);
  assert.match(job, /- arch: x64[\s\S]*debArch: amd64[\s\S]*- arch: arm64[\s\S]*debArch: arm64/);
  assert.match(verifyStep, /expected_members=\$'debian-binary\\ncontrol\.tar\.gz\\ndata\.tar\.gz'/);
  assert.match(uploadStep, /name: uos-linux-\$\{\{ matrix\.arch \}\}/);
  assert.match(publishJob, /needs: \[prepare, build-linux, build-linux-uos, upload\]/);
  assert.match(publishJob, /always\(\)/);
  assert.match(publishJob, /inputs\.linux_package == 'deb-and-uos'/);
  assert.match(publishJob, /needs\.upload\.result == 'success'/);
  assert.match(publishJob, /inputs\.platforms == 'linux'/);
  assert.match(publishJob, /needs\.build-linux\.result == 'success'/);
  assert.match(publishJob, /pattern: uos-linux-\*/);
  assert.match(uosStep, /s3:\/\/\$\{RELEASE_BUCKET\}\/\$\{key\}/);
  assert.match(uosStep, /DOWNLOAD_UOS_AMD64_INSTALLER_URL: \$amd64/);
  assert.match(uosStep, /DOWNLOAD_UOS_ARM64_INSTALLER_URL: \$arm64/);
  assert.match(uosStep, /\.data\.DOWNLOAD_UOS_AMD64_INSTALLER_URL == \$amd64/);
  assert.match(uosStep, /\.data\.DOWNLOAD_UOS_ARM64_INSTALLER_URL == \$arm64/);
});

test('制品汇总只接收两个普通 Floatboat deb，并把 UOS 作为独立门禁', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const uploadJob = readNamedJob(workflow, 'upload');
  const verifyStep = readNamedStep(uploadJob, 'Verify required artifacts');
  const notifyStep = readNamedStep(workflow, 'Send Feishu notification');

  assert.match(uploadJob, /needs\.build-linux\.result == 'success'/);
  assert.match(uploadJob, /needs\.build-linux-uos\.result == 'success'/);
  assert.match(verifyStep, /Floatboat-\$\{FLOATBOAT_VERSION\}-\$\{deb_arch\}\.deb/);
  assert.match(verifyStep, /expected_deb=2/);
  assert.doesNotMatch(verifyStep, /Floatboat-DeepSeek-Agent-\$\{DEEPSEEK_VERSION\}-\$\{deb_arch\}\.deb/);
  assert.doesNotMatch(notifyStep, /Floatboat-DeepSeek-Agent-\{deepseek_version\}-\{deb_arch\}\.deb/);
  assert.match(workflow, /notify:[\s\S]*needs: \[[^\]]*publish-linux-uos[^\]]*\]/);
  assert.match(notifyStep, /UOS 下载地址发布：\{icon\(uos_publish\)\} \{uos_publish\}/);
  assert.match(notifyStep, /linux_deb_names[\s\S]*upload == "success"/);
  assert.match(notifyStep, /uos_deb_names[\s\S]*uos_publish == "success"/);
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

test('UOS 双架构只在固定的 V20 ABI 容器中重编 SQLite 并复核最终 ELF', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const job = readNamedJob(workflow, 'build-linux-uos');
  const rebuildStep = readNamedStep(job, 'Rebuild SQLite for UOS V20 ABI');
  const verifyStep = readNamedStep(job, 'Verify UOS package metadata and layout');
  const otherJobs = workflow.replace(job, '');

  assert.match(job, /quay\.io\/pypa\/manylinux_2_28_x86_64@sha256:4131ddd7acb9c6c966af02fe7e71edc51e078c2d41f475966697676430bfa2ae/);
  assert.match(job, /quay\.io\/pypa\/manylinux_2_28_aarch64@sha256:abd1230aa9e4058a74b89d27cd14ba18c0db036d7bfe6e6f219a29ea63c24eb6/);
  assert.doesNotMatch(job, /^\s+container:/m);
  assert.doesNotMatch(otherJobs, /manylinux_2_28|Rebuild SQLite for UOS V20 ABI/);
  assert.ok(
    job.indexOf('- name: Install dependencies') < job.indexOf('- name: Rebuild SQLite for UOS V20 ABI') &&
      job.indexOf('- name: Rebuild SQLite for UOS V20 ABI') < job.indexOf('- name: Build Floatboat UOS package'),
    'SQLite 必须在安装依赖后、UOS 打包前按 V20 ABI 重编',
  );
  assert.match(rebuildStep, /docker run --rm/);
  assert.match(rebuildStep, /--build-from-source/);
  assert.match(rebuildStep, /--disable-pre-gyp-copy/);
  assert.match(rebuildStep, /--only better-sqlite3-multiple-ciphers/);
  assert.match(rebuildStep, /rm -rf node_modules\/better-sqlite3-multiple-ciphers\/bin/);
  assert.match(rebuildStep, /gcc-toolset-14/);
  assert.match(rebuildStep, /Advanced Micro Devices X86-64/);
  assert.match(rebuildStep, /AArch64/);
  assert.match(verifyStep, /UOS V20 \(glibc 2\.28 \/ GCC 8\)/);
  assert.match(verifyStep, /GLIBC: '2\.28'/);
  assert.match(verifyStep, /GLIBCXX: '3\.4\.25'/);
  assert.match(verifyStep, /CXXABI: '1\.3\.11'/);
  assert.match(verifyStep, /GCC: '7\.0\.0'/);
  assert.match(verifyStep, /LIBATOMIC: '1\.2'/);
  assert.match(verifyStep, /maxBuffer: 64 \* 1024 \* 1024/);
  assert.match(verifyStep, /--version-info/);
  assert.match(verifyStep, /--file-header/);
  assert.match(verifyStep, /RPATH\|RUNPATH/);
  assert.match(verifyStep, /UOS ELF 架构不匹配/);
  assert.match(verifyStep, /UOS ELF 残留构建路径/);
});
