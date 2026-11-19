#!/usr/bin/env node
// ABOUTME: 用真实 DEB 控制归档和本地 AWS/CDN 替身验证 UOS 下载分发与失败边界。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const scriptPath = path.join(__dirname, 'publish-uos-installers.sh');

function arArchive(members) {
  const parts = [Buffer.from('!<arch>\n')];
  for (const [name, data] of members) {
    parts.push(Buffer.from(`${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(data.length).padEnd(10)}\x60\n`));
    parts.push(data);
    if (data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

function writeDeb(f, arch, overrides = {}) {
  const controlRoot = path.join(f.root, `control-${arch}`);
  fs.mkdirSync(controlRoot, { recursive: true });
  const fields = {
    Package: 'com.floatboat.desktop',
    Version: f.version.includes('-rc.') ? f.version.replace('-rc.', '.') : `${f.version}.0`,
    Architecture: arch,
    ...overrides,
  };
  fs.writeFileSync(path.join(controlRoot, 'control'), Object.entries(fields).map(([key, value]) => `${key}: ${value}\n`).join(''));
  const controlTar = path.join(f.root, `control-${arch}.tar.gz`);
  const tar = spawnSync('tar', ['-czf', controlTar, '-C', controlRoot, 'control'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const deb = arArchive([
    ['debian-binary', Buffer.from('2.0\n')],
    ['control.tar.gz', fs.readFileSync(controlTar)],
    ['data.tar.gz', zlib.gzipSync(Buffer.alloc(1024))],
  ]);
  fs.writeFileSync(path.join(f.artifacts, `Floatboat-${f.version}-${arch}.deb`), deb);
}

function executable(file, source) { fs.writeFileSync(file, source, { mode: 0o755 }); }

function fixture(t, version = '1.2.4-rc.3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uos-installers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = {
    root, version,
    artifacts: path.join(root, 'artifacts/uos'),
    bin: path.join(root, 'bin'),
    store: path.join(root, 's3'),
    log: path.join(root, 'calls'),
    output: path.join(root, 'output'),
    summary: path.join(root, 'summary'),
  };
  fs.mkdirSync(f.artifacts, { recursive: true });
  fs.mkdirSync(f.bin);
  fs.writeFileSync(f.log, '');
  for (const arch of ['amd64', 'arm64']) writeDeb(f, arch);
  executable(path.join(f.bin, 'aws'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1]; };
fs.appendFileSync(process.env.MOCK_LOG, 'aws ' + args.join(' ') + '\\n');
const file = path.join(process.env.MOCK_STORE, option('--bucket'), option('--key'));
if (args[0] === 's3api' && args[1] === 'head-object') {
  if (!fs.existsSync(file)) { console.error('An error occurred (404) when calling HeadObject'); process.exit(254); }
  const metadata = JSON.parse(fs.readFileSync(file + '.json'));
  const bytes = fs.readFileSync(file);
  process.stdout.write(JSON.stringify({ContentLength: bytes.length, ChecksumType: 'FULL_OBJECT',
    ChecksumSHA256: process.env.MOCK_BAD_S3_SHA === '1' ? 'bad' : crypto.createHash('sha256').update(bytes).digest('base64'), ...metadata}));
  process.exit(0);
}
if (args[0] === 's3api' && args[1] === 'put-object') {
  if (option('--if-none-match') !== '*') throw new Error('Immutable write protection missing');
  if (fs.existsSync(file)) { console.error('An error occurred (PreconditionFailed)'); process.exit(254); }
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.copyFileSync(option('--body'), file);
  const bytes = fs.readFileSync(file);
  if (crypto.createHash('sha256').update(bytes).digest('base64') !== option('--checksum-sha256')) throw new Error('Upload checksum differs');
  fs.writeFileSync(file + '.json', JSON.stringify({CacheControl:option('--cache-control'), ContentType:option('--content-type')}));
  process.stdout.write('{}'); process.exit(0);
}
if (args[0] === 'cloudfront' && args[1] === 'create-invalidation') { process.stdout.write('INV-UOS'); process.exit(0); }
if (args[0] === 'cloudfront' && args[1] === 'wait') process.exit(0);
throw new Error('Unexpected AWS command');
`);
  executable(path.join(f.bin, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, 'curl ' + args.join(' ') + '\\n');
const url = new URL(args.at(-1));
if (url.hostname !== 'release.aoe.chat') throw new Error('Unexpected host');
if (args.includes('--head')) throw new Error('CDN must verify the full contents');
const file = path.join(process.env.MOCK_STORE, 'aoe-desktop-releases', url.pathname);
const bytes = fs.readFileSync(file);
if (process.env.MOCK_BAD_CDN_SHA === '1') bytes[0] ^= 1;
fs.writeFileSync(args[args.indexOf('--output') + 1], bytes);
`);
  return f;
}

function run(f, extra = {}) {
  return spawnSync('bash', [scriptPath], {
    cwd: f.root, encoding: 'utf8',
    env: {
      ...process.env, PATH: `${f.bin}:${process.env.PATH}`,
      VERSION: f.version, UOS_CHANNEL: f.version.includes('-rc.') ? 'rc' : 'stable',
      UOS_ARTIFACT_DIR: f.artifacts, AWS_S3_BUCKET: 'aoe-desktop-releases',
      INSTALLER_DOWNLOAD_BASE_URL: 'https://release.aoe.chat',
      MOCK_STORE: f.store, MOCK_LOG: f.log,
      GITHUB_OUTPUT: f.output, GITHUB_STEP_SUMMARY: f.summary,
      INSTALLER_URLS_API_TOKEN: '', UOS_STORE_USERNAME: '', UOS_STORE_PASSWORD: '',
      ...extra,
    },
  });
}

function requireSuccess(result) { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); }
function calls(f) { return fs.readFileSync(f.log, 'utf8'); }

test('RC 双包完整校验后分发到 internal/rc/uos，且不要求官网或商店凭据', (t) => {
  const f = fixture(t);
  requireSuccess(run(f));
  for (const arch of ['amd64', 'arm64']) {
    const name = `Floatboat-${f.version}-${arch}.deb`;
    assert.deepEqual(fs.readFileSync(path.join(f.store, 'aoe-desktop-releases/internal/rc/uos', name)), fs.readFileSync(path.join(f.artifacts, name)));
    assert.match(fs.readFileSync(f.output, 'utf8'), new RegExp(`uos_${arch}_url=https://release.aoe.chat/internal/rc/uos/`));
  }
  assert.match(fs.readFileSync(f.summary, 'utf8'), /SHA-256/);
  assert.doesNotMatch(calls(f), /installer-urls|uniontech|latest.yml|channel.yml/);
});

test('stable 使用 uos 前缀，与同名普通 Linux 制品保持隔离', (t) => {
  const f = fixture(t, '1.2.4');
  const genericDir = path.join(f.root, 'out/make');
  fs.mkdirSync(genericDir, { recursive: true });
  const generic = path.join(genericDir, 'Floatboat-1.2.4-amd64.deb');
  fs.writeFileSync(generic, 'ordinary Linux');
  requireSuccess(run(f));
  assert.equal(fs.readFileSync(generic, 'utf8'), 'ordinary Linux');
  const published = path.join(f.store, 'aoe-desktop-releases/uos/Floatboat-1.2.4-amd64.deb');
  assert.deepEqual(fs.readFileSync(published), fs.readFileSync(path.join(f.artifacts, path.basename(published))));
  assert.doesNotMatch(calls(f), /internal\/rc|out\/make|installer-urls/);
});

test('stable UOS 修订版本保留四段版本并使用对应下载文件名', (t) => {
  const f = fixture(t, '1.2.4.7');
  requireSuccess(run(f));
  for (const arch of ['amd64', 'arm64']) {
    const name = `Floatboat-${f.version}-${arch}.deb`;
    const published = path.join(f.store, 'aoe-desktop-releases/uos', name);
    assert.deepEqual(fs.readFileSync(published), fs.readFileSync(path.join(f.artifacts, name)));
  }
});

test('缺少第二架构时在任何远端调用前失败', (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.artifacts, `Floatboat-${f.version}-arm64.deb`));
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing regular UOS arm64/);
  assert.equal(calls(f), '');
});

test('轨道和版本不匹配时不触碰 S3', (t) => {
  const f = fixture(t);
  for (const extra of [{ UOS_CHANNEL: 'stable' }, { UOS_CHANNEL: 'nightly' }, { VERSION: '1.2.4' }, { VERSION: '../escape' }]) {
    assert.notEqual(run(f, extra).status, 0);
    assert.equal(calls(f), '');
  }
});

test('包内版本、应用身份或架构不匹配时在上传前失败', (t) => {
  const f = fixture(t);
  for (const overrides of [{ Version: '1.2.3.0' }, { Package: 'floatboat' }, { Architecture: 'amd64' }]) {
    writeDeb(f, 'arm64', overrides);
    assert.notEqual(run(f).status, 0);
    assert.equal(calls(f), '');
  }
});

test('已上传的 S3 摘要不符会失败，且不发出 CDN 下载链接', (t) => {
  const f = fixture(t);
  const result = run(f, { MOCK_BAD_S3_SHA: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /S3 SHA256 mismatch/);
  assert.equal(fs.existsSync(f.output), false);
  assert.doesNotMatch(calls(f), /cloudfront|curl/);
});

test('同尺寸 CDN 内容损坏仍会失败，不只检查 Content-Length', (t) => {
  const f = fixture(t);
  const result = run(f, { MOCK_BAD_CDN_SHA: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CDN SHA256 mismatch/);
  assert.equal(fs.existsSync(f.output), false);
  assert.equal(fs.existsSync(f.summary), false);
});

test('相同内容重跑只校验并复用，不覆盖 immutable 对象', (t) => {
  const f = fixture(t);
  requireSuccess(run(f));
  fs.writeFileSync(f.log, '');
  requireSuccess(run(f));
  assert.doesNotMatch(calls(f), /put-object/);
  assert.match(calls(f), /head-object/);
});

test('已有版本地址的内容不同会在任何写入前拒绝覆盖', (t) => {
  const f = fixture(t);
  requireSuccess(run(f));
  fs.writeFileSync(f.log, '');
  const name = `Floatboat-${f.version}-arm64.deb`;
  const existing = path.join(f.store, 'aoe-desktop-releases/internal/rc/uos', name);
  const corrupted = fs.readFileSync(existing); corrupted[0] ^= 1; fs.writeFileSync(existing, corrupted);
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /S3 SHA256 mismatch/);
  assert.doesNotMatch(calls(f), /put-object|cloudfront|curl/);
  assert.deepEqual(fs.readFileSync(existing), corrupted);
});
