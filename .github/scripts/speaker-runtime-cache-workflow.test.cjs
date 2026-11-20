// ABOUTME: 校验声纹原生依赖只缓存 pnpm 原始 store，并在冻结安装及真实加载成功后立即保存。
'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const targets = [
  ['build-macos-arm64', 'darwin', 'arm64'],
  ['build-macos-x64', 'darwin', 'x64'],
  ['build-windows', 'win32', 'x64'],
];

function workflowSource(filename) {
  return readFileSync(path.join(__dirname, '../workflows', filename), 'utf8');
}

function jobSource(workflow, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `缺少 job：${jobName}`);
  const next = /\n  [a-z0-9-]+:\n/.exec(workflow.slice(start + marker.length));
  return workflow.slice(start, next ? start + marker.length + next.index : undefined);
}

function step(job, name) {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  assert.notEqual(start, -1, `缺少步骤：${name}`);
  const next = job.indexOf('\n      - name:', start + marker.length);
  return { start, source: job.slice(start, next < 0 ? undefined : next) };
}

function field(source, name) {
  return new RegExp(`^        ${name}: (.+)$`, 'm').exec(source)?.[1];
}

const phases = [
  'Checkout source repo',
  'Setup pnpm',
  'Setup Node.js',
  'Checkout speaker cache tooling',
  'Resolve speaker runtime cache key',
  'Restore speaker runtime dependency cache',
  'Install dependencies',
  'Verify speaker runtime dependencies',
  'Save speaker runtime dependency cache',
  'Remove speaker cache tooling',
];
const storePath = '${{ steps.speaker_cache_key.outputs.store_path }}';
const cacheKey = '${{ steps.speaker_cache_key.outputs.key }}';

for (const filename of ['release.yml', 'nightly.yml']) {
  for (const [jobName, platform, arch] of targets) {
    test(`${filename} ${jobName} 在打包前完成 store 恢复、冻结安装、原生加载及保存`, () => {
      const job = jobSource(workflowSource(filename), jobName);
      const indices = phases.map((name) => step(job, name).start);
      assert.deepEqual(indices, [...indices].sort((left, right) => left - right));
      assert.ok(indices.at(-1) < job.indexOf('pnpm run forge:make'), '必须在应用打包前保存并清理 tooling');

      const checkout = step(job, 'Checkout speaker cache tooling').source;
      assert.equal(field(checkout, 'uses'), 'actions/checkout@v4');
      assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/);
      assert.match(checkout, /path: speaker-cache-tooling\n/);
      assert.match(checkout, /sparse-checkout: \.github\/scripts\n/);
      assert.equal(field(step(job, 'Remove speaker cache tooling').source, 'run'), 'rm -rf speaker-cache-tooling');

      const key = step(job, 'Resolve speaker runtime cache key').source;
      assert.equal(field(key, 'id'), 'speaker_cache_key');
      assert.equal(field(key, 'shell'), 'bash');
      assert.match(key, /set -euo pipefail/);
      assert.match(key, /^          PNPM_VERSION="\$\(pnpm --version\)"$/m);
      assert.match(key, /^          PNPM_STORE_PATH="\$\(pnpm store path --silent\)"$/m);
      assert.match(key, /export PNPM_VERSION PNPM_STORE_PATH/);
      assert.match(key, /node speaker-cache-tooling\/\.github\/scripts\/speaker-runtime-cache\.cjs key/);
      assert.ok(key.includes(`          TARGET_PLATFORM: ${platform}\n`));
      assert.ok(key.includes(`          TARGET_ARCH: ${arch}\n`));
      assert.doesNotMatch(key, /inputs\.version|source_sha|repo_ref|matrix\.variant/);
    });

    test(`${filename} ${jobName} 缓存不替代安装、完整性与原生加载检查`, () => {
      const job = jobSource(workflowSource(filename), jobName);
      const restore = step(job, 'Restore speaker runtime dependency cache').source;
      const install = step(job, 'Install dependencies').source;
      const verify = step(job, 'Verify speaker runtime dependencies').source;
      const save = step(job, 'Save speaker runtime dependency cache').source;
      assert.equal(field(restore, 'id'), 'speaker_cache_restore');
      assert.equal(field(restore, 'uses'), 'actions/cache/restore@v4');
      assert.equal(field(save, 'uses'), 'actions/cache/save@v4');
      for (const cached of [restore, save]) {
        assert.ok(cached.includes(`          path: ${storePath}\n`));
        assert.ok(cached.includes(`          key: ${cacheKey}\n`));
        assert.equal(field(cached, 'continue-on-error'), 'true');
        assert.doesNotMatch(cached, /restore-keys|node_modules|speaker-models|resources\/|out\/|\.exe|\.dmg/);
      }
      assert.equal(field(install, 'if'), undefined);
      assert.equal(field(install, 'run'), 'pnpm install --frozen-lockfile --prefer-offline --verify-store-integrity=true --side-effects-cache=false');
      assert.equal(field(verify, 'id'), 'speaker_cache_verify');
      assert.equal(field(verify, 'if'), undefined);
      assert.equal(field(verify, 'shell'), 'bash');
      assert.equal(field(verify, 'run'), 'node speaker-cache-tooling/.github/scripts/speaker-runtime-cache.cjs verify');
      assert.ok(verify.includes(`          TARGET_PLATFORM: ${platform}\n`));
      assert.ok(verify.includes(`          TARGET_ARCH: ${arch}\n`));
      assert.equal(field(verify, 'continue-on-error'), undefined);
      assert.equal(field(install, 'continue-on-error'), undefined);
      assert.equal(field(save, 'if'), "steps.speaker_cache_restore.outputs.cache-hit != 'true' && steps.speaker_cache_verify.outcome == 'success'");
    });
  }

  test(`${filename} 声纹 store 缓存只接入既有 macOS/Windows 应用 job`, () => {
    const workflow = workflowSource(filename);
    const jobs = [...workflow.matchAll(/^  ([a-z0-9-]+):$/gm)].map((match) => match[1]);
    const cachedJobs = jobs.filter((name) => jobSource(workflow, name).includes('speaker-runtime-cache.cjs'));
    assert.deepEqual(cachedJobs, targets.map(([name]) => name));
  });
}

test('Release 与 Nightly 同目标使用同一声纹 store 缓存身份入口', () => {
  for (const [jobName] of targets) {
    const release = jobSource(workflowSource('release.yml'), jobName);
    const nightly = jobSource(workflowSource('nightly.yml'), jobName);
    for (const name of ['Resolve speaker runtime cache key', 'Restore speaker runtime dependency cache']) {
      assert.equal(step(release, name).source, step(nightly, name).source);
    }
  }
});

test('自动验收在三个平台用独立后续 job 强制命中同一固定源码的缓存', () => {
  const workflow = workflowSource('verify-speaker-runtime-cache.yml');
  const source = jobSource(workflow, 'source');
  const populate = jobSource(workflow, 'populate');
  const reuse = jobSource(workflow, 'reuse');
  assert.match(workflow, /^  pull_request:\n    paths:/m);
  assert.match(workflow, /'\.github\/scripts\/speaker-runtime-cache\*'/);
  assert.match(workflow, /'\.github\/workflows\/release\.yml'/);
  assert.match(workflow, /'\.github\/workflows\/nightly\.yml'/);
  assert.match(source, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(source, /sha=\$\(git rev-parse HEAD\)/);
  assert.match(populate, /ref: \$\{\{ needs\.source\.outputs\.sha \}\}/);
  assert.match(populate, /strategy: &platform_matrix\n/);
  const matrix = [...populate.matchAll(/- \{ platform: (\w+), arch: (\w+), runner: ([\w-]+) \}/g)]
    .map((match) => ({ platform: match[1], arch: match[2], runner: match[3] }));
  assert.deepEqual(matrix, [
    { platform: 'darwin', arch: 'arm64', runner: 'macos-26' },
    { platform: 'darwin', arch: 'x64', runner: 'macos-26-intel' },
    { platform: 'win32', arch: 'x64', runner: 'windows-latest' },
  ]);
  assert.match(populate, /steps: &verify_cache_steps\n/);
  assert.match(populate, /REQUIRE_CACHE_HIT: 'false'/);
  assert.match(reuse, /needs: \[source, populate\]/);
  assert.match(reuse, /strategy: \*platform_matrix/);
  assert.match(reuse, /steps: \*verify_cache_steps/);
  assert.match(reuse, /REQUIRE_CACHE_HIT: 'true'/);
  const requireHit = step(populate, 'Require cache reuse in the second job').source;
  assert.equal(field(requireHit, 'if'), "env.REQUIRE_CACHE_HIT == 'true'");
  assert.match(requireHit, /CACHE_HIT: \$\{\{ steps\.speaker_cache_restore\.outputs\.cache-hit \}\}/);
  assert.equal(field(requireHit, 'run'), 'test "$CACHE_HIT" = true');
  assert.equal(field(requireHit, 'continue-on-error'), undefined);
});

test('自动验收恢复后仍安装并加载依赖，缓存动作失败不得伪装为通过，且不发布制品', () => {
  const workflow = workflowSource('verify-speaker-runtime-cache.yml');
  const populate = jobSource(workflow, 'populate');
  const names = [
    'Resolve speaker runtime cache key',
    'Restore speaker runtime dependencies',
    'Require cache reuse in the second job',
    'Install dependencies',
    'Verify speaker runtime dependencies',
    'Save verified speaker runtime dependencies',
  ];
  const indices = names.map((name) => step(populate, name).start);
  assert.deepEqual(indices, [...indices].sort((left, right) => left - right));
  const restore = step(populate, names[1]).source;
  const install = step(populate, names[3]).source;
  const verify = step(populate, names[4]).source;
  const save = step(populate, names[5]).source;
  const key = step(populate, names[0]).source;
  assert.match(key, /set -euo pipefail/);
  assert.match(key, /^          PNPM_VERSION="\$\(pnpm --version\)"$/m);
  assert.match(key, /^          PNPM_STORE_PATH="\$\(pnpm store path --silent\)"$/m);
  assert.match(key, /export PNPM_VERSION PNPM_STORE_PATH/);
  assert.equal(field(restore, 'uses'), 'actions/cache/restore@v4');
  assert.equal(field(save, 'uses'), 'actions/cache/save@v4');
  for (const cached of [restore, save]) {
    assert.ok(cached.includes(`          path: ${storePath}\n`));
    assert.ok(cached.includes(`          key: ${cacheKey}\n`));
    assert.equal(field(cached, 'continue-on-error'), undefined);
    assert.doesNotMatch(cached, /restore-keys/);
  }
  assert.equal(field(install, 'if'), undefined);
  assert.equal(field(install, 'run'), 'pnpm install --frozen-lockfile --prefer-offline --verify-store-integrity=true --side-effects-cache=false');
  assert.equal(field(verify, 'if'), undefined);
  assert.equal(field(verify, 'shell'), 'bash');
  assert.equal(field(verify, 'continue-on-error'), undefined);
  assert.equal(field(step(populate, 'Test cache contracts').source, 'run'), 'node --test speaker-cache-tooling/.github/scripts/speaker-runtime-cache.test.cjs');
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(workflow, /actions\/upload-artifact|action-gh-release|gh release|gh workflow run|forge:make|publish-|signing|FEISHU|LARK|contents: write/);
});

test('pnpm 版本或 store 路径解析失败必须在计算缓存键前阻断', () => {
  const commands = [
    ...['release.yml', 'nightly.yml'].flatMap((filename) => targets.map(([job]) => {
      const key = step(jobSource(workflowSource(filename), job), 'Resolve speaker runtime cache key').source;
      return key.split('        run: |\n')[1].split('\n').map((line) => line.replace(/^          /, '')).join('\n');
    })),
    step(jobSource(workflowSource('verify-speaker-runtime-cache.yml'), 'populate'), 'Resolve speaker runtime cache key')
      .source.split('        run: |\n')[1].split('\n').map((line) => line.replace(/^          /, '')).join('\n'),
  ];
  for (const command of commands) {
    for (const failedArgument of ['--version', 'store']) {
      const result = spawnSync('bash', ['-c', `
function pnpm() {
  if [ "$1" = "$FAILED_ARGUMENT" ]; then return 19; fi
  printf '%s\\n' fixture-value
}
function node() { exit 77; }
${command}`], {
        encoding: 'utf8',
        env: { ...process.env, FAILED_ARGUMENT: failedArgument },
      });
      assert.equal(result.status, 19, result.stderr);
    }
  }
});
