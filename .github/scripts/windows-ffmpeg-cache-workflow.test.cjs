// ABOUTME: 约束 Windows 音频组件缓存的恢复、验证、编译和保存顺序，防止跨工具链复用或后续打包失败丢缓存。
'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function windowsJob(filename) {
  const workflow = readFileSync(path.join(__dirname, '../workflows', filename), 'utf8');
  const marker = '  build-windows:\n';
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `${filename} 缺少 Windows job`);
  const nextJob = /\n  [a-z0-9-]+:\n/.exec(workflow.slice(start + marker.length));
  return workflow.slice(start, nextJob ? start + marker.length + nextJob.index : undefined);
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

const outputPath = '${{ runner.temp }}\\floatboat-ffmpeg-x64';
const key = '${{ steps.windows_ffmpeg_key.outputs.key }}';
const metadata = '${{ steps.windows_ffmpeg_key.outputs.metadata }}';
const phases = [
  'Setup FFmpeg build toolchain',
  'Checkout release tooling for bundled sources',
  'Seed bundled tool sources',
  'Resolve Windows FFmpeg cache key',
  'Restore Windows FFmpeg cache',
  'Inspect Windows FFmpeg cache',
  'Build bundled FFmpeg (Windows x64)',
  'Verify and seal Windows FFmpeg cache',
  'Save Windows FFmpeg cache',
  'Remove bundled source tooling',
];

for (const filename of ['release.yml', 'nightly.yml']) {
  test(`${filename} 在应用打包前完成音频缓存恢复、校验和保存`, () => {
    const job = windowsJob(filename);
    const appStep = filename === 'release.yml'
      ? 'Build and package ${{ matrix.display_name }} (Windows x64)'
      : 'Build and package ${{ matrix.display_name }}';
    const indices = [...phases, appStep].map((name) => step(job, name).start);
    assert.deepEqual(indices, [...indices].sort((left, right) => left - right));
    assert.match(step(job, 'Checkout release tooling for bundled sources').source, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(step(job, appStep).source, /FFMPEG_BUNDLE_SOURCE_DIR: \$\{\{ runner\.temp \}\}\\floatboat-ffmpeg-x64/);
    assert.doesNotMatch(step(job, 'Seed bundled tool sources').source, /rm -rf release-tooling/);
    assert.equal(field(step(job, 'Remove bundled source tooling').source, 'run'), 'rm -rf release-tooling');
  });

  test(`${filename} 只恢复精确身份的未签名音频目录`, () => {
    const job = windowsJob(filename);
    const restore = step(job, 'Restore Windows FFmpeg cache').source;
    assert.equal(field(restore, 'uses'), 'actions/cache/restore@v4');
    assert.equal(field(restore, 'id'), 'windows_ffmpeg_restore');
    assert.match(restore, new RegExp(`^          path: ${outputPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.ok(restore.includes(`          key: ${key}\n`));
    assert.doesNotMatch(restore, /restore-keys|fail-on-cache-miss|\.exe|out\/|resources\/|matrix\.variant|repo_ref|source_sha/);
  });

  test(`${filename} 命中也验证产物，验证无效才编译，不能只信 cache-hit`, () => {
    const job = windowsJob(filename);
    const inspect = step(job, 'Inspect Windows FFmpeg cache').source;
    const build = step(job, 'Build bundled FFmpeg (Windows x64)').source;
    const seal = step(job, 'Verify and seal Windows FFmpeg cache').source;
    assert.equal(field(inspect, 'id'), 'windows_ffmpeg_inspect');
    assert.equal(field(inspect, 'if'), undefined);
    assert.equal(field(build, 'if'), "steps.windows_ffmpeg_inspect.outputs.valid != 'true'");
    assert.equal(field(seal, 'id'), 'windows_ffmpeg_seal');
    assert.equal(field(seal, 'if'), undefined);
    for (const [source, command] of [[inspect, 'inspect'], [seal, 'seal']]) {
      assert.equal(field(source, 'shell'), 'msys2 {0}');
      assert.equal(field(source, 'run'), `node release-tooling/.github/scripts/windows-ffmpeg-cache.cjs ${command}`);
      assert.ok(source.includes(`          FFMPEG_CACHE_METADATA: ${metadata}\n`));
      assert.ok(source.includes(`          FFMPEG_BUNDLE_SOURCE_DIR: ${outputPath}\n`));
      assert.equal(field(source, 'continue-on-error'), undefined);
    }
  });

  test(`${filename} 验证成功立即保存，缓存服务不可用时仍由实际产物校验兜底`, () => {
    const job = windowsJob(filename);
    const save = step(job, 'Save Windows FFmpeg cache').source;
    assert.equal(field(save, 'uses'), 'actions/cache/save@v4');
    assert.equal(field(save, 'if'), "steps.windows_ffmpeg_restore.outputs.cache-hit != 'true' && steps.windows_ffmpeg_seal.outcome == 'success'");
    assert.ok(save.includes(`          path: ${outputPath}\n`));
    assert.ok(save.includes(`          key: ${key}\n`));
    assert.equal(field(save, 'continue-on-error'), 'true');
    assert.equal(field(step(job, 'Restore Windows FFmpeg cache').source, 'continue-on-error'), 'true');
    assert.equal(field(step(job, 'Resolve Windows FFmpeg cache key').source, 'continue-on-error'), undefined);
    assert.equal(field(step(job, 'Build bundled FFmpeg (Windows x64)').source, 'continue-on-error'), undefined);
  });
}

test('Release 和 Nightly 使用相同工具链身份和缓存键入口，业务版本与变体不分割缓存', () => {
  const jobs = ['release.yml', 'nightly.yml'].map(windowsJob);
  for (const phase of ['Setup FFmpeg build toolchain', 'Resolve Windows FFmpeg cache key', 'Restore Windows FFmpeg cache']) {
    assert.equal(step(jobs[0], phase).source, step(jobs[1], phase).source, phase);
  }
  const resolve = step(jobs[0], 'Resolve Windows FFmpeg cache key').source;
  assert.equal(field(resolve, 'id'), 'windows_ffmpeg_key');
  assert.equal(field(resolve, 'shell'), 'msys2 {0}');
  assert.equal(field(resolve, 'run'), 'node release-tooling/.github/scripts/windows-ffmpeg-cache.cjs key');
  assert.match(resolve, /TARGET_PLATFORM: win32\n/);
  assert.match(resolve, /TARGET_ARCH: x64\n/);
  assert.doesNotMatch(resolve, /matrix\.variant|repo_ref|source_sha|inputs\.version|build_profile/);
});
