#!/usr/bin/env node
// ABOUTME: 验证 UOS 送审清单只接受安全且一致的双架构安装包。

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const {
  buildUosPublicationManifest,
  normalizeArchivePath,
  parseTar,
  toUosVersion,
} = require('./uos-publication-manifest.cjs');

function writeTarString(header, value, offset, length) {
  Buffer.from(value).copy(header, offset, 0, length);
}

function writeTarOctal(header, value, offset, length) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeTarString(header, `${encoded}\0`, offset, length);
}

function createTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const header = Buffer.alloc(512);
    writeTarString(header, entry.name, 0, 100);
    writeTarOctal(header, entry.mode || 0o644, 100, 8);
    writeTarOctal(header, 0, 108, 8);
    writeTarOctal(header, 0, 116, 8);
    writeTarOctal(header, data.length, 124, 12);
    writeTarOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type || '0').charCodeAt(0);
    if (entry.linkTarget) writeTarString(header, entry.linkTarget, 157, 100);
    writeTarString(header, 'ustar\0', 257, 6);
    writeTarString(header, '00', 263, 2);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeTarString(header, `${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function paxRecord(key, value) {
  const body = `${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 2;
  while (Buffer.byteLength(`${length} ${body}`) !== length) length = Buffer.byteLength(`${length} ${body}`);
  return `${length} ${body}`;
}

function createAr(members) {
  const buffers = [Buffer.from('!<arch>\n')];
  for (const member of members) {
    const name = `${member.name}/`.padEnd(16, ' ');
    const header = `${name}${'0'.padEnd(12, ' ')}${'0'.padEnd(6, ' ')}${'0'.padEnd(6, ' ')}${'100644'.padEnd(8, ' ')}${String(member.data.length).padEnd(10, ' ')}\`\n`;
    assert.equal(Buffer.byteLength(header), 60);
    buffers.push(Buffer.from(header), member.data);
    if (member.data.length % 2) buffers.push(Buffer.from('\n'));
  }
  return Buffer.concat(buffers);
}

function createElf(machine, size = 64) {
  const elf = Buffer.alloc(size);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(elf);
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(machine, 18);
  return elf;
}

function writeFixture(root, releaseVersion, arch, options = {}) {
  const packageVersion = toUosVersion(releaseVersion);
  const packageRoot = 'opt/apps/com.floatboat.desktop';
  const depends = options.depends || ['libc6'];
  const control = [
    'Package: com.floatboat.desktop',
    `Version: ${packageVersion}`,
    `Architecture: ${arch}`,
    `Depends: ${depends.join(', ')}`,
    '',
  ].join('\n');
  const rootEntry = options.rootEntry ? [{ name: './', type: '5' }] : [];
  const controlTar = createTar([...rootEntry, { name: 'control', data: control }]);
  const dataEntries = [
    ...rootEntry,
    {
      name: `${packageRoot}/info`,
      data: JSON.stringify({ appid: 'com.floatboat.desktop', version: packageVersion, arch: [arch], permissions: {} }),
    },
    {
      name: `${packageRoot}/files/resources/uos-app-store.json`,
      data: JSON.stringify({ appid: 'com.floatboat.desktop', padding: options.metadataPadding || '' }),
    },
    {
      name: `${packageRoot}/entries/applications/com.floatboat.desktop.desktop`,
      data: '[Desktop Entry]\nExec=/opt/apps/com.floatboat.desktop/files/floatboat\n',
    },
    {
      name: `${packageRoot}/files/floatboat`,
      data: createElf(options.elfMachine || (arch === 'amd64' ? 62 : 183), options.executableSize),
      mode: 0o755,
    },
    ...(options.extraEntries || []),
  ];
  const deb = createAr([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: zlib.gzipSync(controlTar) },
    { name: 'data.tar.gz', data: zlib.gzipSync(createTar(dataEntries)) },
  ]);
  const audit = {
    appid: 'com.floatboat.desktop',
    version: packageVersion,
    arch,
    neededLibraries: [{ soname: 'libc.so.6', requiredBy: ['files/floatboat'] }],
    depends: options.auditDepends || ['libc6'],
    systemLibraries: [{ soname: 'libc.so.6', package: 'libc6', requiredBy: ['files/floatboat'] }],
    bundledLibraries: [],
    optionalLibraries: [],
    abiCompatibility: { baseline: 'UOS V20 (glibc 2.28 / GCC 8)', limits: {}, maximumVersions: [] },
  };
  fs.writeFileSync(path.join(root, `Floatboat-${releaseVersion}-${arch}.deb`), deb);
  fs.writeFileSync(
    path.join(root, `Floatboat-${releaseVersion}-${arch}-dependency-audit.json`),
    `${JSON.stringify(audit)}\n`,
  );
}

test('稳定版本统一转换为 UOS 四段版本', () => {
  assert.equal(toUosVersion('0.6.3'), '0.6.3.0');
  assert.equal(toUosVersion('0.6.3.4'), '0.6.3.4');
  assert.equal(toUosVersion('0.6.3-rc.1'), '0.6.3.1');
});

test('安全路径拒绝绝对路径、反斜杠和父目录越界', () => {
  assert.equal(normalizeArchivePath('./opt/apps/file'), 'opt/apps/file');
  for (const unsafe of ['/etc/passwd', '../escape', 'opt/../../escape', 'C:/escape', 'opt\\escape']) {
    assert.throws(() => normalizeArchivePath(unsafe), /UOS_ARCHIVE_PATH_UNSAFE/);
  }
});

test('tar 解析拒绝越界路径和越界符号链接', () => {
  assert.throws(() => parseTar(createTar([{ name: '../escape', data: 'bad' }])), /UOS_ARCHIVE_PATH_UNSAFE/);
  assert.throws(
    () => parseTar(createTar([{ name: 'opt/link', type: '2', linkTarget: '/etc/passwd' }])),
    /UOS_ARCHIVE_LINK_UNSAFE/,
  );
  assert.throws(
    () => parseTar(createTar([{ name: 'opt/deep/link', type: '2', linkTarget: '../../../etc/passwd' }])),
    /UOS_ARCHIVE_LINK_UNSAFE/,
  );
  assert.throws(
    () => parseTar(createTar([{ name: 'opt/link', type: '1', linkTarget: '../etc/passwd' }])),
    /UOS_ARCHIVE_LINK_UNSAFE/,
  );
  assert.throws(
    () => parseTar(createTar([
      { name: 'PaxHeader', type: 'x', data: paxRecord('linkpath', '../../../../etc/passwd') },
      { name: 'opt/apps/link', type: '2', linkTarget: 'safe-target' },
    ])),
    /UOS_ARCHIVE_LINK_UNSAFE/,
  );
  assert.throws(
    () => parseTar(createTar([
      { name: 'LongLink', type: 'K', data: '../../../../etc/passwd\0' },
      { name: 'opt/apps/link', type: '2', linkTarget: 'safe-target' },
    ])),
    /UOS_ARCHIVE_LINK_UNSAFE/,
  );
});

test('双架构有效包生成只含脱敏身份和摘要的送审清单', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uos-publication-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFixture(root, '0.6.3', 'amd64');
  writeFixture(root, '0.6.3', 'arm64');
  const manifest = buildUosPublicationManifest({
    artifactsDir: root,
    releaseVersion: '0.6.3',
    sourceSha: 'a'.repeat(40),
    runId: '12345',
    runAttempt: 2,
    generatedAt: '2026-11-02T00:00:00.000Z',
  });
  assert.equal(manifest.appid, 'com.floatboat.desktop');
  assert.equal(manifest.packageVersion, '0.6.3.0');
  assert.deepEqual(manifest.packages.map((item) => item.arch), ['amd64', 'arm64']);
  assert.ok(manifest.packages.every((item) => /^[0-9a-f]{64}$/u.test(item.sha256)));
  assert.deepEqual(manifest.github, { runId: '12345', runAttempt: 2 });
  assert.doesNotMatch(JSON.stringify(manifest), /password|cookie|token|authorization/iu);
});

test('真实 tar 空根目录项与大于 1 MiB 的双架构 ELF 可以生成 RC 清单', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uos-publication-large-elf-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const arch of ['amd64', 'arm64']) {
    writeFixture(root, '0.6.3-rc.6', arch, { rootEntry: true, executableSize: 2 * 1024 * 1024 });
  }
  const manifest = buildUosPublicationManifest({
    artifactsDir: root,
    releaseVersion: '0.6.3-rc.6',
    sourceSha: 'a'.repeat(40),
    runId: '12345',
    runAttempt: 1,
  });
  assert.equal(manifest.packageVersion, '0.6.3.6');
  assert.deepEqual(manifest.packages.map((item) => item.arch), ['amd64', 'arm64']);
});

test('大 ELF 不放宽 JSON 元数据大小与架构约束', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uos-publication-metadata-limit-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = { artifactsDir: root, releaseVersion: '0.6.3', sourceSha: 'a'.repeat(40), runId: '1', runAttempt: 1 };
  writeFixture(root, '0.6.3', 'arm64');
  writeFixture(root, '0.6.3', 'amd64', { executableSize: 2 * 1024 * 1024, metadataPadding: 'x'.repeat(1024 * 1024) });
  assert.throws(() => buildUosPublicationManifest(input), /元数据文件过大.*uos-app-store\.json/u);
  writeFixture(root, '0.6.3', 'amd64', { executableSize: 2 * 1024 * 1024, elfMachine: 183 });
  assert.throws(() => buildUosPublicationManifest(input), /ELF machine=183 与架构不符/u);
});

test('归档根只接受空目录，根普通文件和链接仍拒绝', () => {
  for (const name of ['.', './']) {
    assert.equal(parseTar(createTar([{ name, type: '5' }, { name: './control', data: 'Package: example' }])).size, 1);
    for (const entry of [
      { name, data: 'content' },
      { name, type: '5', data: 'content' },
      { name, type: '1', linkTarget: 'control' },
      { name, type: '2', linkTarget: 'control' },
    ]) assert.throws(() => parseTar(createTar([entry])), /UOS_ARCHIVE_PATH_UNSAFE/u);
  }
});

test('control Depends 与审计不一致时在发布前失败', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uos-publication-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFixture(root, '0.6.3', 'amd64', { auditDepends: ['libgcc1'] });
  writeFixture(root, '0.6.3', 'arm64');
  assert.throws(
    () => buildUosPublicationManifest({
      artifactsDir: root,
      releaseVersion: '0.6.3',
      sourceSha: 'b'.repeat(40),
      runId: '1',
      runAttempt: 1,
    }),
    /UOS_DEPENDENCY_AUDIT_MISMATCH/,
  );
});

test('应用内更新配置和额外安装包均被拒绝', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uos-publication-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFixture(root, '0.6.3', 'amd64', {
    extraEntries: [{ name: 'opt/apps/com.floatboat.desktop/files/resources/app-update.yml', data: 'provider: generic' }],
  });
  writeFixture(root, '0.6.3', 'arm64');
  assert.throws(
    () => buildUosPublicationManifest({
      artifactsDir: root,
      releaseVersion: '0.6.3',
      sourceSha: 'c'.repeat(40),
      runId: '2',
      runAttempt: 1,
    }),
    /UOS_PACKAGE_METADATA_MISMATCH/,
  );
});
