// ABOUTME: 验证打包源码包预填按固定提交优先、SHA-256 不符拒收，并在消费它的构建步骤之前以同一 shell 执行。
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { VENDORED_SOURCE_COMMIT, resolveCachePath, seedBundledToolSources } = require('./seed-bundled-tool-sources.cjs');

const ARCHIVE = Buffer.from('ffmpeg source archive');
const SOURCE = {
  url: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
  sha256: crypto.createHash('sha256').update(ARCHIVE).digest('hex'),
  fileName: 'ffmpeg-8.1.2.tar.xz',
};

function createSourceRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'seed-bundled-sources-'));
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(
    path.join(root, 'scripts/bundle-ffmpeg.mjs'),
    `export const FFMPEG_SOURCE = ${JSON.stringify(SOURCE)};\n`,
  );
  return root;
}

function response(status, body = Buffer.alloc(0)) {
  return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => body };
}

test('固定的源码仓库提交是完整 SHA，不能是分支名或空值', () => {
  assert.match(VENDORED_SOURCE_COMMIT, /^[0-9a-f]{40}$/);
});

test('源码仓库固定提交不可用时回退上游，并按打包脚本的缓存命名写入', async () => {
  const root = createSourceRoot();
  const calls = [];
  try {
    const results = await seedBundledToolSources({
      sourceRoot: root,
      cacheDirectory: path.join(root, 'cache'),
      env: { SOURCE_REPO: 'AOE-HQ/aoe-desktop', SOURCE_REPO_TOKEN: '﻿ token-value \n' },
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1 ? response(503) : response(200, ARCHIVE);
      },
      log: () => {},
    });

    assert.deepEqual(results, { [SOURCE.fileName]: 'seeded' });
    assert.equal(
      calls[0].url,
      `https://api.github.com/repos/AOE-HQ/aoe-desktop/contents/vendor/bundled-tool-sources/${SOURCE.fileName}?ref=${VENDORED_SOURCE_COMMIT}`,
    );
    assert.equal(calls[0].init.headers.Authorization, 'Bearer token-value');
    assert.equal(calls[0].init.headers.Accept, 'application/vnd.github.raw');
    assert.equal(calls[1].url, SOURCE.url);
    const cachePath = resolveCachePath(path.join(root, 'cache'), SOURCE);
    assert.equal(path.basename(cachePath), `${SOURCE.sha256.slice(0, 16)}-${SOURCE.fileName}`);
    assert.deepEqual(readFileSync(cachePath), ARCHIVE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SHA-256 不符的内容不写入缓存，源码已入库时不发起下载', async () => {
  const root = createSourceRoot();
  try {
    const cacheDirectory = path.join(root, 'cache');
    const tampered = await seedBundledToolSources({
      sourceRoot: root,
      cacheDirectory,
      env: {},
      fetchImpl: async () => response(200, Buffer.from('tampered')),
      log: () => {},
    });
    assert.deepEqual(tampered, { [SOURCE.fileName]: 'missing' });
    assert.equal(existsSync(resolveCachePath(cacheDirectory, SOURCE)), false);

    mkdirSync(path.join(root, 'vendor/bundled-tool-sources'), { recursive: true });
    writeFileSync(path.join(root, 'vendor/bundled-tool-sources', SOURCE.fileName), ARCHIVE);
    const vendored = await seedBundledToolSources({
      sourceRoot: root,
      cacheDirectory,
      env: {},
      fetchImpl: async () => assert.fail('源码已入库时不应下载'),
      log: () => {},
    });
    assert.deepEqual(vendored, { [SOURCE.fileName]: 'vendored' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function stepSource(workflow, name, from = 0) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker, from);
  assert.notEqual(start, -1, `缺少步骤：${name}`);
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return { start, source: workflow.slice(start, next < 0 ? undefined : next) };
}

const CONSUMERS = {
  'release.yml': {
    'build-macos-arm64': ['Build and package ${{ matrix.display_name }} (arm64)', 'bash'],
    'build-macos-x64': ['Build and package ${{ matrix.display_name }} (x64)', 'bash'],
    'build-windows': ['Build bundled FFmpeg (Windows x64)', 'msys2 {0}'],
  },
  'nightly.yml': {
    'build-macos-arm64': ['Build ${{ matrix.display_name }} arm64', 'bash'],
    'build-macos-x64': ['Build ${{ matrix.display_name }} x64', 'bash'],
    'build-windows': ['Build bundled FFmpeg (Windows x64)', 'msys2 {0}'],
  },
};

for (const [filename, jobs] of Object.entries(CONSUMERS)) {
  for (const [job, [consumerName, shell]] of Object.entries(jobs)) {
    test(`${filename} ${job} 在下载源码包之前以同一 shell 预填缓存`, () => {
      const workflow = readFileSync(path.join(__dirname, '../workflows', filename), 'utf8');
      const jobStart = workflow.indexOf(`\n  ${job}:\n`);
      assert.notEqual(jobStart, -1, `缺少 job：${job}`);
      const seed = stepSource(workflow, 'Seed bundled tool sources', jobStart);
      const consumer = stepSource(workflow, consumerName, jobStart);
      const checkout = stepSource(workflow, 'Checkout release tooling for bundled sources', jobStart);
      // 缓存目录来自 os.tmpdir()，msys2 与 pwsh 下取值不同，预填必须与下载方同一 shell。
      assert.ok(checkout.start < seed.start && seed.start < consumer.start);
      assert.match(seed.source, new RegExp(`shell: ${shell.replace(/[{}]/g, '\\$&')}\\n`));
      assert.match(seed.source, /SOURCE_REPO_TOKEN: \$\{\{ secrets\.SOURCE_REPO_PAT \}\}/);
      assert.match(seed.source, /rm -rf release-tooling/);
      assert.doesNotMatch(seed.source, /continue-on-error/);
    });
  }
}
