#!/usr/bin/env node
// ABOUTME: 实际执行官网 Linux 下载地址同步步骤，验证双架构更新和有界回读失败。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'release.yml'), 'utf8');
const marker = '      - name: Sync stable UOS installer URLs\n';
assert.ok(workflow.includes(marker), 'workflow 必须同步官网 UOS 双架构地址');
const step = workflow.slice(workflow.indexOf(marker)).split(/\n  [a-z][a-z0-9-]*:\n/)[0];
const shell = step.match(/        run: \|\n((?:          [^\n]*\n|\n)+)/)[1].replace(/^          /gm, '');
const expected = {
  DOWNLOAD_UOS_AMD64_INSTALLER_URL: 'https://downloads.example.invalid/uos/Floatboat-1.2.4-amd64.deb',
  DOWNLOAD_UOS_ARM64_INSTALLER_URL: 'https://downloads.example.invalid/uos/Floatboat-1.2.4-arm64.deb',
};

function executeSync(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uos-installer-urls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'calls.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, '');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const url = args.find((arg) => arg.startsWith('https://'));
assert.ok(url?.startsWith('https://website.example.invalid/api/ops/installer-urls'));
const method = option('-X') || 'GET';
const payload = option('-d') ? JSON.parse(option('-d')) : null;
const headers = args.flatMap((arg, index) => arg === '-H' ? [args[index + 1]] : []);
assert.ok(headers.includes('Authorization: Bearer fake-test-token'));
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify({ method, url, payload, headers }) + '\\n');
const data = JSON.parse(process.env.MOCK_EXPECTED_URLS);
if ((method === 'GET' && process.env.MOCK_STALE_KEY) || process.env.MOCK_BAD_PATCH === '1') {
  data[process.env.MOCK_STALE_KEY || 'DOWNLOAD_UOS_ARM64_INSTALLER_URL'] = 'https://downloads.example.invalid/old.deb';
}
fs.writeFileSync(option('-o'), JSON.stringify({ code: 0, data }));
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // 只隔离临时回执路径；运行的发布逻辑直接取自 workflow。
  const result = spawnSync('bash', ['-c', shell.replaceAll('/tmp/uos-installer-urls-', `${root}/uos-installer-urls-`)], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_CALLS: calls,
      MOCK_EXPECTED_URLS: JSON.stringify(expected), MOCK_STALE_KEY: '', MOCK_BAD_PATCH: '',
      INSTALLER_URLS_API_TOKEN: 'fake-test-token', INSTALLER_URLS_API_BASE_URL: 'https://website.example.invalid/',
      UOS_AMD64_URL: expected.DOWNLOAD_UOS_AMD64_INSTALLER_URL,
      UOS_ARM64_URL: expected.DOWNLOAD_UOS_ARM64_INSTALLER_URL,
      VERSION: '1.2.4', GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '2', ...overrides,
    },
  });
  return { ...result, calls: fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(JSON.parse) };
}

test('正式版官网 Linux 双链接 PATCH 和 GET 完全一致后才报告成功', (t) => {
  const result = executeSync(t);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].method, 'PATCH');
  assert.deepEqual(result.calls[0].payload, expected);
  assert.equal(result.calls[0].url, 'https://website.example.invalid/api/ops/installer-urls');
  assert.equal(result.calls[1].method, 'GET');
  assert.equal(result.calls[1].url, 'https://website.example.invalid/api/ops/installer-urls?verify_version=1.2.4&verify_attempt=1&verify_nonce=1234-2');
  assert.ok(result.calls[1].headers.includes('Cache-Control: no-cache, no-store'));
  assert.match(result.stdout, /UOS amd64\/arm64 packages published and installer URLs verified/);
});

test('任一架构回读仍为旧链接时重试五次后失败', (t) => {
  for (const key of Object.keys(expected)) {
    const result = executeSync(t, { MOCK_STALE_KEY: key });
    assert.notEqual(result.status, 0, key);
    assert.equal(result.calls.filter((call) => call.method === 'PATCH').length, 1);
    const reads = result.calls.filter((call) => call.method === 'GET');
    assert.equal(reads.length, 5);
    assert.deepEqual(reads.map((call) => new URL(call.url).searchParams.get('verify_attempt')), ['1', '2', '3', '4', '5']);
    assert.match(result.stdout, /UOS installer URLs did not converge/);
    assert.doesNotMatch(result.stdout, /installer URLs verified/);
  }
});

test('PATCH 回执缺少本次任一链接时立即失败，不继续 GET', (t) => {
  const result = executeSync(t, { MOCK_BAD_PATCH: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.calls.map((call) => call.method), ['PATCH']);
  assert.doesNotMatch(result.stdout, /installer URLs verified/);
});

test('官网稳定链接步骤仅用于 stable，并消费已完成 CDN 校验的输出', () => {
  assert.match(step, /^        if: inputs\.is_rc == false$/m);
  assert.match(step, /UOS_AMD64_URL: \$\{\{ steps\.uos_downloads\.outputs\.uos_amd64_url \}\}/);
  assert.match(step, /UOS_ARM64_URL: \$\{\{ steps\.uos_downloads\.outputs\.uos_arm64_url \}\}/);
});
