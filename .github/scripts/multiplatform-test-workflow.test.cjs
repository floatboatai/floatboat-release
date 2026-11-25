#!/usr/bin/env node
// ABOUTME: 执行发布工作流中的真实条件和脚本，验证多平台测试包范围及发布隔离。

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const vm = require('node:vm');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'release.yml'), 'utf8');
const version = '0.6.7-test.17';
const sourceSha = 'a'.repeat(40);
const platforms = ['macos', 'windows', 'linux', 'macos,windows', 'macos,windows,linux'];
const linuxPackages = ['deb', 'uos-floatboat', 'deb-and-uos'];
const buildJobs = ['build-macos-arm64', 'build-macos-x64', 'build-windows', 'build-linux', 'build-linux-uos'];

function readJob(name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `缺少 job：${name}`);
  const remaining = workflow.slice(start + marker.length);
  const next = /\n  [a-z0-9-]+:\n/.exec(remaining);
  return workflow.slice(start, next ? start + marker.length + next.index : workflow.length);
}

function readStep(job, name) {
  const block = readJob(job);
  const marker = `      - name: ${name}\n`;
  const start = block.indexOf(marker);
  assert.notEqual(start, -1, `缺少步骤：${job}/${name}`);
  const next = block.indexOf('\n      - name:', start + marker.length);
  return block.slice(start, next === -1 ? block.length : next);
}

function evaluate(expression, context) {
  const code = expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/\b(?:inputs|needs|steps|github|matrix|secrets|vars)(?:\.[A-Za-z_][\w-]*)+/g, (reference) => `lookup(${JSON.stringify(reference)})`);
  return vm.runInNewContext(code, {
    lookup: (reference) => reference.split('.').reduce((value, key) => value?.[key], context),
    contains: (container, value) => container.includes(value),
    always: () => true,
    cancelled: () => false,
    success: () => true,
  });
}

function condition(block, context) {
  const match = /^( +)if: ([^\n]*)\n/m.exec(block);
  assert.ok(match, '发布或构建入口必须有条件');
  let expression = match[2];
  if (/^[|>][-+]?$/.test(expression)) {
    const lines = block.slice(match.index + match[0].length).split('\n');
    expression = [];
    for (const line of lines) {
      if (line.trim() && line.length - line.trimStart().length <= match[1].length) break;
      expression.push(line.trim());
    }
    expression = expression.join(' ');
  }
  return Boolean(evaluate(expression, context));
}

function context(inputOverrides = {}) {
  const inputs = {
    version, desktop_variant: 'floatboat', build_profile: 'release', is_rc: false,
    platforms: 'macos,windows,linux', linux_package: 'deb-and-uos', package_set: 'app',
    upload_uos_store: false, promote_merged_bugs: false, notify_only: false,
    reuse_uos_run_id: '', repo_ref: sourceSha,
    ...inputOverrides,
  };
  const outputs = {
    is_test: 'true', desktop_variant: inputs.desktop_variant, package_set: 'app', linux_package: inputs.linux_package,
    floatboat_version: inputs.version, deepseek_version: inputs.version, source_sha: sourceSha,
    release_tag: `test-v${inputs.version}`, release_notes_enabled: 'true',
  };
  const needs = Object.fromEntries([
    ...buildJobs, 'upload', 'restore-uos-artifacts', 'validate-uos-publication',
    'build-test-launcher-macos-arm64', 'build-test-launcher-macos-x64', 'build-test-launcher-windows',
  ].map((name) => [name, { result: 'success' }]));
  needs.prepare = { result: 'success', outputs };
  return {
    inputs, needs, github: { ref: 'refs/heads/main' },
    steps: {
      release_scope: { outputs }, package_set: { outputs },
      bug_handoff: { outputs: { enabled: 'true' } },
      bug_handoff_access: { outputs: { accessible: 'true' } },
    },
  };
}

function bashScript(step, ctx) {
  const marker = '        run: |\n';
  const start = step.indexOf(marker);
  assert.notEqual(start, -1, '步骤必须使用内联 Bash 脚本');
  return step.slice(start + marker.length).split('\n')
    .map((line) => line.replace(/^          /, '')).join('\n')
    .replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, expression) => String(evaluate(expression, ctx)));
}

function stepEnvironment(step, ctx) {
  const environment = {};
  const start = step.indexOf('        env:\n');
  if (start === -1) return environment;
  const block = step.slice(start).split(/\n(?=        \S)/)[0];
  for (const [, name, value] of block.matchAll(/^          ([A-Z][A-Z0-9_]*): (.+)$/gm)) {
    environment[name] = value.startsWith('${{') ? String(evaluate(value, ctx)) : value;
  }
  return environment;
}

function runStep(step, ctx, files = {}, setup) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'test-release-workflow-'));
  try {
    fs.mkdirSync(path.join(directory, 'out', 'make'), { recursive: true });
    for (const [file, contents] of Object.entries(files)) {
      const destination = path.join(directory, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, contents);
    }
    const extraEnvironment = setup?.(directory) ?? {};
    const outputFile = path.join(directory, 'github-output');
    const result = spawnSync('bash', ['-c', bashScript(step, ctx)], {
      cwd: directory, encoding: 'utf8',
      env: {
        ...process.env, ...stepEnvironment(step, ctx), ...extraEnvironment,
        GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
      },
    });
    assert.ifError(result.error);
    return {
      status: result.status,
      log: `${result.stdout}\n${result.stderr}`,
      outputs: fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '',
      commands: fs.existsSync(path.join(directory, 'commands')) ? fs.readFileSync(path.join(directory, 'commands'), 'utf8') : '',
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function expectedFiles(selected, linuxPackage, artifactVersion = version) {
  const files = {};
  if (selected.includes('macos')) {
    for (const arch of ['arm64', 'x64']) {
      for (const extension of ['dmg', 'zip']) files[`out/make/Floatboat-${artifactVersion}-${arch}.${extension}`] = '';
    }
  }
  if (selected.includes('windows')) files[`out/make/Floatboat-Setup-${artifactVersion}-x64.exe`] = '';
  if (selected.includes('linux')) {
    for (const arch of ['amd64', 'arm64']) {
      if (linuxPackage !== 'uos-floatboat') files[`out/make/Floatboat-${artifactVersion}-${arch}.deb`] = '';
      if (linuxPackage !== 'deb') {
        files[`artifacts/uos-test/Floatboat-${artifactVersion}-${arch}.deb`] = '';
        files[`artifacts/uos-test/Floatboat-${artifactVersion}-${arch}-dependency-audit.json`] = '{}';
      }
    }
  }
  return files;
}

test('test 范围脚本接受既有平台选择，并保持 Floatboat 单变体与 Linux 双架构', () => {
  const step = readStep('prepare', 'Resolve release scope');
  for (const selected of platforms) {
    for (const linuxPackage of linuxPackages) {
      const result = runStep(step, context({ platforms: selected, linux_package: linuxPackage }));
      assert.equal(result.status, 0, `${selected}/${linuxPackage}: ${result.log}`);
      assert.match(result.outputs, /^is_test=true$/m);
      assert.match(result.outputs, new RegExp(`^release_tag=test-v${version.replaceAll('.', '\\.')}\n`, 'm'));
      const desktop = JSON.parse(/^desktop_matrix=(.+)$/m.exec(result.outputs)[1]);
      assert.deepEqual(desktop.include.map((item) => item.variant), ['floatboat']);
      const linux = JSON.parse(/^linux_matrix=(.+)$/m.exec(result.outputs)[1]);
      assert.deepEqual(linux.include.map((item) => [item.arch, item.debArch]), [['x64', 'amd64'], ['arm64', 'arm64']]);
    }
  }
});

test('test 范围脚本在任何构建前拒绝混合发布语义和非法平台', () => {
  const step = readStep('prepare', 'Resolve release scope');
  const invalid = [
    { is_rc: true }, { build_profile: 'test' }, { desktop_variant: 'all' },
    { desktop_variant: 'deepseek-agent' }, { upload_uos_store: true }, { promote_merged_bugs: true },
    ...['', 'android', 'macosx', 'windows,windows', 'macos,,linux', ',linux', 'linux,',
      'macos, linux', 'macos,linux', 'windows,linux'].map((value) => ({ platforms: value })),
    { platforms: 'linux', linux_package: 'invalid' },
  ];
  for (const overrides of invalid) {
    const result = runStep(step, context(overrides));
    assert.notEqual(result.status, 0, `${JSON.stringify(overrides)} 被错误接受：${result.log}`);
    assert.match(result.log, /::error::/);
  }
});

test('test 的 auto 只解析成 app，显式 launcher 和 all 在 prepare 拒绝', () => {
  const step = readStep('prepare', 'Resolve package set');
  for (const packageSet of ['auto', 'app', 'all', 'launcher']) {
    const result = runStep(step, context({ package_set: packageSet }));
    if (packageSet === 'auto' || packageSet === 'app') {
      assert.equal(result.status, 0, result.log);
      assert.match(result.outputs, /^package_set=app$/m);
    } else {
      assert.notEqual(result.status, 0, `${packageSet} 被错误接受`);
    }
  }
});

test('test source ref 只读解析当前 SHA，不查询或写入远端 tag', () => {
  const result = runStep(readStep('prepare', 'Resolve source release tag'), context(), {}, (directory) => {
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin);
    const git = path.join(bin, 'git');
    fs.writeFileSync(git, `#!/bin/bash\nprintf '%s\\n' "$*" >> "$COMMAND_LOG"\nif [ "$*" = 'rev-parse HEAD' ]; then printf '%s\\n' '${sourceSha}'; else exit 93; fi\n`);
    fs.chmodSync(git, 0o755);
    return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, COMMAND_LOG: path.join(directory, 'commands') };
  });
  assert.equal(result.status, 0, result.log);
  assert.equal(result.commands, 'rev-parse HEAD\n');
  assert.match(result.outputs, new RegExp(`^source_sha=${sourceSha}$`, 'm'));
});

test('UOS 包校验将 test 和 RC 来源映射为四段版本，保持 stable 与四段来源兼容', () => {
  const step = readStep('build-linux-uos', 'Verify UOS package metadata and layout');
  const snippet = /const inputVersion = process\.env\.VERSION;[\s\S]*?(?=const field =)/.exec(step);
  assert.ok(snippet, 'UOS 包校验必须从输入版本推导四段版本');
  const convert = (value) => vm.runInNewContext(`${snippet[0]}\nversion;`, { assert, process: { env: { VERSION: value } } });
  for (const [input, expected] of [
    ['0.6.7-test.17', '0.6.7.17'], ['0.6.7-rc.17', '0.6.7.17'],
    ['0.6.7', '0.6.7.0'], ['0.6.7.17', '0.6.7.17'],
  ]) assert.equal(convert(input), expected);
  for (const input of ['0.6.7-test', '0.6.7-test.bad', '0.6.7-nightly.17']) assert.throws(() => convert(input));
});

test('UOS 正式修订发布使用四段标签与下载文件名，Electron 和更新日志使用三段版本', () => {
  const ctx = context({ version: '0.6.7.1', platforms: 'linux', linux_package: 'uos-floatboat', repo_ref: 'v0.6.7.1' });
  const scope = runStep(readStep('prepare', 'Resolve release scope'), ctx);
  assert.equal(scope.status, 0, scope.log);
  const outputs = Object.fromEntries(scope.outputs.trim().split('\n').map((entry) => entry.split(/=(.*)/s).slice(0, 2)));
  assert.equal(outputs.is_test, 'false');
  assert.equal(outputs.release_tag, 'v0.6.7.1');
  assert.equal(outputs.uos_revision, '0.6.7.1');
  assert.equal(outputs.uos_desktop_version, '0.6.7');
  ctx.steps.release_scope = { outputs };
  Object.assign(ctx.needs.prepare.outputs, outputs, { floatboat_version: '0.6.7' });

  const stepEnv = (job, name) => stepEnvironment(readStep(job, name), ctx);
  assert.equal(stepEnv('prepare', 'Resolve Desktop variant versions').INPUT_VERSION, '0.6.7');
  assert.equal(stepEnv('prepare', 'Generate canonical release notes payload').BASE_VERSION, '0.6.7');
  assert.equal(stepEnv('build-linux-uos', 'Inject Floatboat version into package.json').VERSION, '0.6.7');
  assert.equal(stepEnv('build-linux-uos', 'Build Floatboat UOS package').AOE_UOS_PACKAGE_VERSION, '0.6.7.1');
  assert.equal(stepEnv('build-linux-uos', 'Verify UOS package metadata and layout').VERSION, '0.6.7.1');
  assert.equal(stepEnv('publish-linux-uos', 'Publish and verify UOS installers').VERSION, '0.6.7.1');
  assert.equal(stepEnv('publish-linux-uos', 'Sync stable UOS installer URLs').VERSION, '0.6.7.1');
  const upload = readStep('build-linux-uos', 'Upload UOS artifacts');
  for (const arch of ['amd64', 'arm64']) {
    const resolved = upload.replaceAll('${{ matrix.debArch }}', arch)
      .replace(/\$\{\{ (needs\.prepare\.outputs\.[^}]+) \}\}/g, (_, expression) => evaluate(expression, ctx));
    const prefix = `out/make/uos/${arch}/Floatboat-0.6.7.1-${arch}`;
    assert.ok(resolved.includes(`${prefix}.deb\n`));
    assert.ok(resolved.includes(`${prefix}-dependency-audit.json\n`));
  }
  for (const job of buildJobs) {
    const selected = condition(readJob(job), ctx);
    assert.equal(selected, job === 'build-linux-uos', job);
    ctx.needs[job].result = selected ? 'success' : 'skipped';
  }
  assert.equal(condition(readJob('upload'), ctx), false);
  ctx.needs.upload.result = 'skipped';
  assert.equal(condition(readJob('publish-linux-uos'), ctx), true);
  for (const job of ['validate-uos-publication', 'stage-uos-review', 'notify']) {
    assert.equal(condition(readJob(job), ctx), false, job);
  }
});

test('四段版本仅用于正式 UOS 双架构官网包', () => {
  const inputs = { version: '0.6.7.1', platforms: 'linux', linux_package: 'uos-floatboat' };
  const step = readStep('prepare', 'Resolve release scope');
  const valid = runStep(step, context(inputs));
  assert.equal(valid.status, 0, valid.log);
  const invalid = [
    { platforms: 'macos' }, { platforms: 'windows' }, { platforms: 'macos,windows,linux' },
    { linux_package: 'deb' }, { linux_package: 'deb-and-uos' },
    { desktop_variant: 'all' }, { desktop_variant: 'deepseek-agent' }, { is_rc: true },
    { build_profile: 'test' }, { build_profile: 'internal-test' },
    { notify_only: true }, { upload_uos_store: true }, { promote_merged_bugs: true },
    { package_set: 'launcher' }, { package_set: 'all' },
    { repo_ref: 'v0.6.7' }, { repo_ref: 'dev' }, { repo_ref: 'nightly-20261120' },
    { version: '0.6.7.0' }, { version: '0.6.7.01' }, { version: '0.06.7.1' },
  ];
  for (const overrides of invalid) {
    const result = runStep(step, context({ ...inputs, ...overrides }));
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.match(result.log, /::error::/);
  }
});

test('UOS 修订只复用指向当前源码提交的正式标签', () => {
  for (const scenario of ['matching', 'missing', 'mismatching']) {
    const ctx = context({ version: '0.6.7.1', platforms: 'linux', linux_package: 'uos-floatboat' });
    Object.assign(ctx.steps.release_scope.outputs, { is_test: 'false', release_tag: 'v0.6.7.1' });
    const result = runStep(readStep('prepare', 'Resolve source release tag'), ctx, {}, (directory) => {
      const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], { cwd: directory, encoding: 'utf8' }).trim();
      git('init', '--quiet');
      git('remote', 'add', 'origin', directory);
      git('commit', '--allow-empty', '--quiet', '-m', 'source');
      if (scenario !== 'missing') git('tag', '-a', 'v0.6.7.1', '-m', 'UOS revision');
      if (scenario === 'mismatching') git('commit', '--allow-empty', '--quiet', '-m', 'different commit');
      ctx.inputs.repo_ref = git('rev-parse', 'HEAD');
    });
    assert.equal(result.status === 0, scenario === 'matching', `${scenario}: ${result.log}`);
    if (scenario === 'matching') assert.match(result.outputs, /^release_tag=v0\.6\.7\.1$/m);
    else assert.match(result.log, /::error::/);
  }
});

test('所选 test 平台全部成功后才汇总，任一必需 job 失败或跳过均阻断', () => {
  for (const selected of platforms) {
    for (const linuxPackage of linuxPackages) {
      const ctx = context({ platforms: selected, linux_package: linuxPackage });
      const selectedJobs = [];
      for (const job of buildJobs) {
        const enabled = condition(readJob(job), ctx);
        const expected = job.startsWith('build-macos') ? selected.includes('macos')
          : job === 'build-windows' ? selected.includes('windows')
            : selected.includes('linux') && (job === 'build-linux' ? linuxPackage !== 'uos-floatboat' : linuxPackage !== 'deb');
        assert.equal(enabled, expected, `${selected}/${linuxPackage}/${job}`);
        ctx.needs[job].result = expected ? 'success' : 'skipped';
        if (expected) selectedJobs.push(job);
      }
      assert.equal(condition(readJob('upload'), ctx), true, `${selected}/${linuxPackage} 未汇总`);
      for (const job of selectedJobs) {
        for (const status of ['failure', 'cancelled', 'skipped']) {
          ctx.needs[job].result = status;
          assert.equal(condition(readJob('upload'), ctx), false, `${selected}/${linuxPackage}/${job} ${status} 仍汇总`);
        }
        ctx.needs[job].result = 'success';
      }
      ctx.needs.prepare.result = 'failure';
      assert.equal(condition(readJob('upload'), ctx), false, `${selected} 的 prepare 失败仍汇总`);
    }
  }
});

test('test 产物校验执行真实脚本，覆盖平台组合及 UOS 独立目录', () => {
  const step = readStep('upload', 'Verify required artifacts');
  for (const selected of platforms) {
    for (const linuxPackage of linuxPackages) {
      const result = runStep(step, context({ platforms: selected, linux_package: linuxPackage }), expectedFiles(selected, linuxPackage));
      assert.equal(result.status, 0, `${selected}/${linuxPackage}: ${result.log}`);
    }
  }
  const download = readStep('upload', 'Download UOS test artifacts');
  assert.match(download, /pattern: uos-linux-\*/);
  assert.match(download, /path: artifacts\/uos-test\//);
  assert.equal(condition(download, context()), true);
  assert.equal(condition(download, context({ platforms: 'windows' })), false);
});

test('test 产物缺失、错误架构、额外包或元数据均失败', () => {
  const step = readStep('upload', 'Verify required artifacts');
  const complete = expectedFiles('macos,windows,linux', 'deb-and-uos');
  for (const missing of Object.keys(complete)) {
    const files = { ...complete };
    delete files[missing];
    const result = runStep(step, context(), files);
    assert.notEqual(result.status, 0, `缺少 ${missing} 仍通过`);
  }
  for (const extra of [
    'out/make/wrong-arch.exe', 'out/make/extra.dmg', 'out/make/extra.zip', 'out/make/extra.deb',
    'out/make/latest.yml', 'artifacts/uos-test/extra.deb', 'artifacts/uos-test/extra-dependency-audit.json',
  ]) {
    const result = runStep(step, context(), { ...complete, [extra]: '' });
    assert.notEqual(result.status, 0, `额外 ${extra} 仍通过`);
  }
  const windowsFiles = expectedFiles('windows', 'deb');
  windowsFiles[`artifacts/uos-test/Floatboat-${version}-amd64.deb`] = '';
  assert.notEqual(runStep(step, context({ platforms: 'windows', linux_package: 'deb' }), windowsFiles).status, 0);
});

test('test 在所有平台范围关闭外部发布、商店暂存、bug 晋级和通知入口', () => {
  const blockedJobs = ['publish-linux-uos', 'restore-uos-artifacts', 'validate-uos-publication', 'stage-uos-review', 'notify'];
  const blockedSteps = [
    'Generate macOS Update Metadata', 'Generate Windows Update Metadata',
    'Inject canonical release notes into stable metadata', 'Verify generated update metadata',
    'Create GitHub Release', 'Check bug handoff configuration', 'Setup pnpm for bug handoff',
    'Setup Node.js for bug handoff', 'Install bug handoff tooling', 'Configure Lark CLI for bug handoff',
    'Check Lark Base access for bug handoff',
    'Promote merged bug PRs to acceptance', 'Configure AWS credentials for internal RC updater',
    'Publish and verify internal RC updater', 'Configure AWS Credentials',
    'Publish and verify stable updater feeds', 'Sync Floatboat website installer URLs',
  ];
  for (const selected of platforms) {
    const ctx = context({ platforms: selected });
    for (const job of blockedJobs) assert.equal(condition(readJob(job), ctx), false, `${selected}/${job}`);
    for (const name of blockedSteps) assert.equal(condition(readStep('upload', name), ctx), false, `${selected}/${name}`);
    for (const job of ['build-test-launcher-macos-arm64', 'build-test-launcher-macos-x64', 'build-test-launcher-windows']) {
      assert.equal(condition(readJob(job), ctx), false, `${selected}/${job}`);
    }
  }
  const official = context({ version: '0.6.7', desktop_variant: 'all', promote_merged_bugs: true });
  official.needs.prepare.outputs.is_test = 'false';
  assert.equal(condition(readJob('publish-linux-uos'), official), true);
  assert.equal(condition(readJob('notify'), official), true);
  for (const name of ['Create GitHub Release', 'Publish and verify stable updater feeds', 'Sync Floatboat website installer URLs', 'Promote merged bug PRs to acceptance']) {
    assert.equal(condition(readStep('upload', name), official), true, `正式发布被误阻断：${name}`);
  }
  const rc = context({ version: '0.6.7-rc.17', is_rc: true, platforms: 'macos,windows' });
  rc.needs.prepare.outputs.is_test = 'false';
  assert.equal(condition(readStep('upload', 'Publish and verify internal RC updater'), rc), true);
  const uos = context({ version: '0.6.7', platforms: 'linux', upload_uos_store: true, linux_package: 'uos-floatboat' });
  uos.needs.prepare.outputs.is_test = 'false';
  assert.equal(condition(readJob('stage-uos-review'), uos), true);
});

test('test 发布护栏独立阻断发布输入，即使 prepare 尚未产生输出也不通知', () => {
  const ctx = context({ upload_uos_store: true, promote_merged_bugs: true, is_rc: true, reuse_uos_run_id: '123' });
  for (const job of ['stage-uos-review', 'restore-uos-artifacts', 'validate-uos-publication']) {
    assert.equal(condition(readJob(job), ctx), false, job);
  }
  for (const name of ['Publish and verify internal RC updater', 'Promote merged bug PRs to acceptance']) {
    assert.equal(condition(readStep('upload', name), ctx), false, name);
  }
  ctx.needs.prepare.result = 'failure';
  ctx.needs.prepare.outputs = {};
  assert.equal(condition(readJob('notify'), ctx), false);
});

test('正式双变体、DeepSeek-only 和 RC 制品校验保留原有平台范围', () => {
  const step = readStep('upload', 'Verify required artifacts');
  for (const variant of ['all', 'floatboat', 'deepseek-agent']) {
    const selected = variant === 'all' ? 'macos,windows,linux' : 'macos,windows';
    const ctx = context({ version: '0.6.7', desktop_variant: variant, platforms: selected, linux_package: 'deb' });
    ctx.needs.prepare.outputs.is_test = 'false';
    const floatboat = expectedFiles(selected, 'deb', '0.6.7');
    const deepseek = Object.fromEntries(Object.entries(expectedFiles('macos,windows', 'deb', '0.6.7'))
      .map(([file, contents]) => [file.replace('Floatboat-', 'Floatboat-DeepSeek-Agent-'), contents]));
    const files = variant === 'all' ? { ...floatboat, ...deepseek } : variant === 'floatboat' ? floatboat : deepseek;
    const result = runStep(step, ctx, files);
    assert.equal(result.status, 0, `${variant}: ${result.log}`);
    assert.equal(condition(readJob('upload'), ctx), true, variant);
  }
  const rc = context({ version: '0.6.7-rc.17', is_rc: true, platforms: 'macos,windows' });
  rc.needs.prepare.outputs.is_test = 'false';
  rc.needs['build-macos-x64'].result = 'skipped';
  const files = expectedFiles('macos,windows', 'deb', '0.6.7-rc.17');
  delete files['out/make/Floatboat-0.6.7-rc.17-x64.dmg'];
  delete files['out/make/Floatboat-0.6.7-rc.17-x64.zip'];
  const result = runStep(step, rc, files);
  assert.equal(result.status, 0, result.log);
  assert.equal(condition(readJob('upload'), rc), true);
});
