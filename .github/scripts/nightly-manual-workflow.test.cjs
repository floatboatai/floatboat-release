#!/usr/bin/env node
// ABOUTME: 验证手动 Nightly 安装包的选平台、失败关闭和自动更新隔离契约。

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const yaml = require('js-yaml');

const workflowPath = path.join(__dirname, '..', 'workflows', 'nightly.yml');
const manualPlatforms = 'macos-x64,linux';

function readWorkflow() {
  return yaml.load(fs.readFileSync(workflowPath, 'utf8'));
}

function context(platforms = manualPlatforms, manualOnly = 'true') {
  const needs = {
    prepare: {
      result: 'success',
      outputs: { platforms, manual_only: manualOnly, package_set: 'app', build_profile: 'release' },
    },
  };
  for (const job of Object.keys(readWorkflow().jobs)) {
    if (!(job in needs)) needs[job] = { result: 'success' };
  }
  return {
    needs,
    inputs: { platforms },
    github: { event_name: 'workflow_dispatch', event: { inputs: { platforms } } },
  };
}

function conditionMatches(condition, values) {
  const expression = String(condition ?? 'true')
    .replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, '')
    .replace(/needs\.([a-zA-Z0-9_-]+)/g, (_, job) => `needs[${JSON.stringify(job)}]`);
  return Boolean(vm.runInNewContext(expression, {
    ...values,
    always: () => true,
    contains: (collection, value) => collection.includes(value),
    fromJSON: JSON.parse,
  }, { timeout: 1000 }));
}

function step(job, name) {
  const result = job.steps.find((candidate) => candidate.name === name);
  assert.ok(result, `缺少步骤：${name}`);
  return result;
}

test('默认 Nightly 仍只构建 macOS arm64 和 Windows，手动组合不扩大定时矩阵', () => {
  const workflow = readWorkflow();
  const input = workflow.on.workflow_dispatch.inputs.platforms;
  assert.equal(input.default, 'macos,windows');
  assert.deepEqual(workflow.on.schedule, [{ cron: '0 16 * * *' }]);
  assert.deepEqual(input.options, ['macos,windows', 'macos', 'windows', manualPlatforms]);

  const scheduled = context('macos,windows', 'false');
  scheduled.github.event_name = 'schedule';
  const builds = ['build-macos-arm64', 'build-macos-x64', 'build-windows', 'build-linux'];
  assert.deepEqual(builds.filter((id) => conditionMatches(workflow.jobs[id].if, scheduled)), [
    'build-macos-arm64', 'build-windows',
  ]);
  assert.equal(conditionMatches(workflow.jobs.upload.if, scheduled), true);
  assert.equal(conditionMatches(workflow.jobs['manual-installers'].if, scheduled), false);
});

test('手动组合精确构建 macOS x64 与 Linux，不误触发 arm64 macOS 或 Windows', () => {
  const workflow = readWorkflow();
  const manual = context();
  const buildIds = Object.keys(workflow.jobs).filter((id) => id.startsWith('build-'));
  assert.deepEqual(buildIds.filter((id) => conditionMatches(workflow.jobs[id].if, manual)), [
    'build-macos-x64', 'build-linux',
  ]);
  const readConfig = step(workflow.jobs.prepare, 'Read config');
  assert.match(readConfig.run, /case\s/);
  assert.match(readConfig.run, /macos-x64,linux/);
  assert.match(readConfig.run, /manual_only/);
  assert.match(readConfig.run, /exit 1/);
  assert.equal(workflow.jobs.prepare.outputs.manual_only, '${{ steps.config.outputs.manual_only }}');
});

test('平台配置执行保留定时默认值，拒绝未知组合和手动测试环境包', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-manual-platforms-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const readConfig = step(readWorkflow().jobs.prepare, 'Read config');
  const cases = [
    { event: 'schedule', platforms: manualPlatforms, profile: 'release', expected: 'platforms=macos,windows\nmanual_only=false\n' },
    { event: 'workflow_dispatch', platforms: '', profile: 'release', expected: 'platforms=macos,windows\nmanual_only=false\n' },
    { event: 'workflow_dispatch', platforms: 'macos', profile: 'test', expected: 'platforms=macos\nmanual_only=false\n' },
    { event: 'workflow_dispatch', platforms: manualPlatforms, profile: 'release', expected: `platforms=${manualPlatforms}\nmanual_only=true\n` },
    { event: 'workflow_dispatch', platforms: 'macos,linux', profile: 'release' },
    { event: 'workflow_dispatch', platforms: manualPlatforms, profile: 'test' },
  ];
  for (const [index, scenario] of cases.entries()) {
    const outputPath = path.join(root, `${index}.txt`);
    fs.writeFileSync(outputPath, '');
    const result = spawnSync('bash', ['-c', readConfig.run], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT_NAME: scenario.event,
        INPUT_PLATFORMS: scenario.platforms,
        BUILD_PROFILE: scenario.profile,
        GITHUB_OUTPUT: outputPath,
      },
    });
    const label = `${scenario.event}/${scenario.platforms}/${scenario.profile}`;
    if (scenario.expected) {
      assert.equal(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}`);
      assert.equal(fs.readFileSync(outputPath, 'utf8'), scenario.expected, label);
    } else {
      assert.notEqual(result.status, 0, `${label} 必须在开始构建前失败`);
      assert.equal(fs.readFileSync(outputPath, 'utf8'), '', label);
    }
  }
});

test('Linux 使用两个原生架构并在上传前校验 Debian 包和 ELF 架构', () => {
  const job = readWorkflow().jobs['build-linux'];
  assert.equal(job['runs-on'], '${{ matrix.runner }}');
  assert.equal(job.strategy['fail-fast'], false);
  assert.deepEqual(job.strategy.matrix.include.map(({ arch, debArch, runner }) => ({ arch, debArch, runner })), [
    { arch: 'x64', debArch: 'amd64', runner: 'ubuntu-latest' },
    { arch: 'arm64', debArch: 'arm64', runner: 'ubuntu-24.04-arm' },
  ]);
  const buildIndex = job.steps.findIndex((candidate) => candidate.run?.includes('pnpm run forge:make:linux:deb'));
  const verificationIndex = job.steps.findIndex((candidate) => candidate.run?.includes('readelf -h'));
  const uploadIndex = job.steps.findIndex((candidate) => candidate.uses === 'actions/upload-artifact@v4');
  assert.ok(buildIndex >= 0 && verificationIndex > buildIndex && uploadIndex > verificationIndex);
  assert.match(job.steps[buildIndex].run, /forge:make:linux:deb --platform linux --arch \$\{\{ matrix\.arch \}\}/);
  assert.doesNotMatch(job.steps[buildIndex].run, /forge:make:linux:deb -- /);
  assert.equal(job.steps[buildIndex].env.BUILD_OBFUSCATE, 'true');
  assert.match(job.steps[verificationIndex].run, /dpkg-deb --field .* Architecture/);
  assert.match(job.steps[verificationIndex].run, /\.desktop/);
  assert.match(job.steps[verificationIndex].run, /X86-64/);
  assert.match(job.steps[verificationIndex].run, /AArch64/);
  assert.equal(job.steps[verificationIndex]['continue-on-error'], undefined);
});

test('手动汇总必须等待所有目标成功，失败、取消或跳过任一目标均不能交付', () => {
  const job = readWorkflow().jobs['manual-installers'];
  assert.deepEqual([...job.needs].sort(), ['prepare', 'build-macos-x64', 'build-linux'].sort());
  assert.equal(conditionMatches(job.if, context()), true);
  for (const dependency of job.needs) {
    for (const status of ['failure', 'cancelled', 'skipped']) {
      const values = context();
      values.needs[dependency].result = status;
      assert.equal(conditionMatches(job.if, values), false, `${dependency} ${status} 不应交付`);
    }
  }
  const upload = job.steps.find((candidate) => candidate.uses === 'actions/upload-artifact@v4');
  assert.ok(upload, '汇总后必须提供可下载的 Actions 制品');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.notEqual(upload.with.overwrite, true);
  assert.equal(upload['continue-on-error'], undefined);
});

test('手动生产包固定源码 SHA，macOS 保留签名、公证和真实运行门禁', () => {
  const workflow = readWorkflow();
  for (const id of ['build-macos-x64', 'build-linux']) {
    const job = workflow.jobs[id];
    const checkout = step(job, 'Checkout source repo');
    assert.equal(checkout.with.ref, '${{ needs.prepare.outputs.source_sha }}');
    const injection = job.steps.find((candidate) => candidate.run?.includes('pkg.version = process.env.VERSION'));
    assert.ok(injection, `${id} 必须使用统一 Nightly 版本`);
    assert.equal(injection.env.VERSION, '${{ needs.prepare.outputs.floatboat_version }}');
  }
  const mac = workflow.jobs['build-macos-x64'];
  assert.equal(mac['runs-on'], 'macos-26-intel');
  const signing = step(mac, 'Check code signing');
  assert.match(signing.run, /BUILD_PROFILE.*release/);
  assert.match(signing.run, /exit 1/);
  const verification = step(mac, 'Verify signed and notarized app (x64)');
  assert.match(verification.run, /codesign --verify --deep --strict/);
  assert.match(verification.run, /xcrun stapler validate/);
  assert.match(verification.run, /spctl --assess/);
  const runtime = step(mac, 'Verify packaged Node and workbench (x64)');
  const collect = step(mac, 'Collect x64 artifacts');
  assert.ok(mac.steps.indexOf(verification) < mac.steps.indexOf(runtime));
  assert.ok(mac.steps.indexOf(runtime) < mac.steps.indexOf(collect));
  assert.equal(runtime.if, undefined);
  assert.equal(runtime['continue-on-error'], undefined);
  assert.match(runtime.run, /packaged-workbench-runtime\.mjs.* x64/);
});

test('手动下载模式不写 updater feed、源码 tag、GitHub Release 或飞书通知', () => {
  const workflow = readWorkflow();
  const manual = context();
  assert.equal(conditionMatches(workflow.jobs.upload.if, manual), false);
  assert.equal(conditionMatches(workflow.jobs.notify.if, manual), false);
  const job = workflow.jobs['manual-installers'];
  const commands = job.steps.map((candidate) => candidate.run ?? '').join('\n');
  assert.doesNotMatch(commands, /publish-(?:internal|stable)-updater|generate-latest-yml|aws\s+s3|aws\s+cloudfront/);
  assert.doesNotMatch(commands, /git\s+(?:tag|push)|gh\s+release|FEISHU_WEBHOOK_URL|urllib\.request/);
  assert.equal(job.steps.some((candidate) => candidate.uses?.startsWith('softprops/action-gh-release@')), false);
  assert.equal(job.steps.some((candidate) => candidate.uses?.startsWith('aws-actions/')), false);
});

test('准备阶段尚未输出模式便失败时，默认通知保留且显式手动仍不通知', () => {
  const notification = readWorkflow().jobs.notify;
  const cases = [
    { event: 'workflow_dispatch', platforms: 'macos,windows', notify: true },
    { event: 'schedule', platforms: undefined, notify: true },
    { event: 'workflow_dispatch', platforms: manualPlatforms, notify: false },
  ];
  for (const scenario of cases) {
    const values = context(scenario.platforms);
    values.github.event_name = scenario.event;
    values.inputs = scenario.platforms === undefined ? {} : { platforms: scenario.platforms };
    values.needs.prepare = { result: 'failure', outputs: {} };
    assert.equal(
      conditionMatches(notification.if, values),
      scenario.notify,
      `${scenario.event}/${scenario.platforms ?? '默认平台'} 的早期失败通知行为不正确`,
    );
  }
});
