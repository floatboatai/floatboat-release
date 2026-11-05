#!/usr/bin/env node
// ABOUTME: 在不执行安装包内容的前提下汇聚校验 UOS 双架构包并生成送审清单。

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const APP_ID = 'com.floatboat.desktop';
const ARCHITECTURES = Object.freeze({
  amd64: Object.freeze({ elfMachine: 62 }),
  arm64: Object.freeze({ elfMachine: 183 }),
});
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_COUNT = 250_000;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_AUDIT_BYTES = 16 * 1024 * 1024;

class UosPublicationValidationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'UosPublicationValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new UosPublicationValidationError(code, message);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readNullTerminated(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8').trim();
}

function parseOctal(buffer, start, length, label) {
  const raw = readNullTerminated(buffer, start, length).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/u.test(raw)) fail('UOS_ARCHIVE_INVALID', `${label} 不是八进制整数`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail('UOS_ARCHIVE_INVALID', `${label} 超出安全范围`);
  return value;
}

function normalizeArchivePath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.includes('\0')) {
    fail('UOS_ARCHIVE_PATH_UNSAFE', '归档路径为空或包含 NUL');
  }
  if (rawPath.includes('\\') || rawPath.startsWith('/') || /^[A-Za-z]:/u.test(rawPath)) {
    fail('UOS_ARCHIVE_PATH_UNSAFE', `归档路径不是安全相对路径：${rawPath}`);
  }
  let candidate = rawPath;
  while (candidate.startsWith('./')) candidate = candidate.slice(2);
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '..')) {
    fail('UOS_ARCHIVE_PATH_UNSAFE', `归档路径越界：${rawPath}`);
  }
  const normalized = path.posix.normalize(candidate);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail('UOS_ARCHIVE_PATH_UNSAFE', `归档路径无效：${rawPath}`);
  }
  return normalized.replace(/\/$/u, '');
}

function validateLinkTarget(entryPath, target, type) {
  if (!target || target.includes('\\') || target.startsWith('/') || /^[A-Za-z]:/u.test(target)) {
    fail('UOS_ARCHIVE_LINK_UNSAFE', `${entryPath} 的${type}目标不安全`);
  }
  const virtualRoot = '/__uos_archive_root__';
  const base = type === '硬链接' ? virtualRoot : `${virtualRoot}/${path.posix.dirname(entryPath)}`;
  const resolved = path.posix.resolve(base, target);
  if (resolved !== virtualRoot && !resolved.startsWith(`${virtualRoot}/`)) {
    fail('UOS_ARCHIVE_LINK_UNSAFE', `${entryPath} 的${type}目标越界`);
  }
}

function parseAr(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 8).toString('ascii') !== '!<arch>\n') {
    fail('UOS_DEB_INVALID', '缺少 ar 文件头');
  }
  const members = [];
  let offset = 8;
  while (offset < buffer.length) {
    if (buffer.length - offset < 60) fail('UOS_DEB_INVALID', 'ar 成员头被截断');
    const header = buffer.subarray(offset, offset + 60);
    if (header.subarray(58, 60).toString('ascii') !== '`\n') fail('UOS_DEB_INVALID', 'ar 成员头无效');
    let name = header.subarray(0, 16).toString('ascii').trim();
    const sizeRaw = header.subarray(48, 58).toString('ascii').trim();
    if (!/^\d+$/u.test(sizeRaw)) fail('UOS_DEB_INVALID', 'ar 成员大小无效');
    const size = Number.parseInt(sizeRaw, 10);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 60 + size > buffer.length) {
      fail('UOS_DEB_INVALID', 'ar 成员超出文件边界');
    }
    if (name.endsWith('/')) name = name.slice(0, -1);
    if (!name || name.startsWith('#1/') || name === '//' || name === '/') {
      fail('UOS_DEB_INVALID', `不支持的 ar 成员名：${name || '<empty>'}`);
    }
    members.push(Object.freeze({ name, data: buffer.subarray(offset + 60, offset + 60 + size) }));
    offset += 60 + size + (size % 2);
  }
  if (offset !== buffer.length) fail('UOS_DEB_INVALID', 'ar 尾部边界无效');
  return Object.freeze(members);
}

function parsePaxFields(data) {
  let offset = 0;
  const fields = {};
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) fail('UOS_ARCHIVE_INVALID', 'PAX 记录缺少长度');
    const lengthText = data.subarray(offset, space).toString('ascii');
    if (!/^\d+$/u.test(lengthText)) fail('UOS_ARCHIVE_INVALID', 'PAX 长度无效');
    const length = Number.parseInt(lengthText, 10);
    if (length <= space - offset + 1 || offset + length > data.length) {
      fail('UOS_ARCHIVE_INVALID', 'PAX 记录越界');
    }
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const separator = record.indexOf('=');
    if (separator > 0) fields[record.slice(0, separator)] = record.slice(separator + 1);
    offset += length;
  }
  return fields;
}

function parseTar(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('UOS_ARCHIVE_INVALID', 'tar 内容不是 Buffer');
  const entries = new Map();
  let offset = 0;
  let pendingLongName = null;
  let pendingPax = null;
  let entryCount = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    entryCount += 1;
    if (entryCount > MAX_ENTRY_COUNT) fail('UOS_ARCHIVE_INVALID', 'tar 成员数量超出上限');

    const storedChecksum = parseOctal(header, 148, 8, 'tar checksum');
    let actualChecksum = 0;
    for (let index = 0; index < 512; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (storedChecksum !== actualChecksum) fail('UOS_ARCHIVE_INVALID', 'tar checksum 不匹配');

    const size = parseOctal(header, 124, 12, 'tar size');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) fail('UOS_ARCHIVE_INVALID', 'tar 成员内容越界');
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const rawName = readNullTerminated(header, 0, 100);
    const prefix = readNullTerminated(header, 345, 155);
    const headerName = prefix ? `${prefix}/${rawName}` : rawName;
    const data = buffer.subarray(dataStart, dataEnd);

    if (typeFlag === 'L') {
      pendingLongName = readNullTerminated(data, 0, data.length);
    } else if (typeFlag === 'x') {
      pendingPax = parsePaxFields(data);
    } else if (typeFlag === 'g') {
      const globalFields = parsePaxFields(data);
      if (globalFields.path || globalFields.linkpath) {
        fail('UOS_ARCHIVE_LINK_UNSAFE', '不允许 PAX 全局路径或链接覆盖');
      }
    } else if (typeFlag === 'K') {
      fail('UOS_ARCHIVE_LINK_UNSAFE', '不允许 GNU longlink 覆盖链接目标');
    } else {
      const rawEntryPath = pendingPax?.path || pendingLongName || headerName;
      pendingLongName = null;
      const linkTarget = pendingPax?.linkpath || readNullTerminated(header, 157, 100);
      pendingPax = null;
      if (rawEntryPath === '.' || rawEntryPath === './') {
        // dpkg 的 tar 会显式列出空根目录；它不是包内文件，也不能承载链接或数据。
        if (typeFlag !== '5' || size !== 0 || linkTarget) fail('UOS_ARCHIVE_PATH_UNSAFE', '归档根必须为空目录');
        offset = dataStart;
        continue;
      }
      const entryPath = normalizeArchivePath(rawEntryPath);
      if (entries.has(entryPath)) fail('UOS_ARCHIVE_INVALID', `tar 路径重复：${entryPath}`);
      if (typeFlag === '2') validateLinkTarget(entryPath, linkTarget, '符号链接');
      else if (typeFlag === '1') validateLinkTarget(entryPath, linkTarget, '硬链接');
      else if (!['0', '\0', '5'].includes(typeFlag)) {
        fail('UOS_ARCHIVE_INVALID', `不允许的 tar 成员类型 ${typeFlag}：${entryPath}`);
      }
      entries.set(entryPath, Object.freeze({ path: entryPath, type: typeFlag, linkTarget, data }));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function parseControl(text) {
  const fields = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    if (/^[ \t]/u.test(line)) {
      if (!current) fail('UOS_CONTROL_INVALID', 'control 延续行没有字段');
      fields.set(current, `${fields.get(current)}\n${line.trim()}`);
      continue;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) fail('UOS_CONTROL_INVALID', `control 行无效：${line}`);
    current = line.slice(0, separator);
    if (fields.has(current)) fail('UOS_CONTROL_INVALID', `control 字段重复：${current}`);
    fields.set(current, line.slice(separator + 1).trim());
  }
  return fields;
}

function readRegularEntry(entries, entryPath) {
  const entry = entries.get(entryPath);
  if (!entry || !['0', '\0'].includes(entry.type)) fail('UOS_PACKAGE_METADATA_MISMATCH', `缺少文件：${entryPath}`);
  return entry;
}

function readMetadataEntry(entries, entryPath) {
  const entry = readRegularEntry(entries, entryPath);
  if (entry.data.length > MAX_METADATA_BYTES) fail('UOS_PACKAGE_METADATA_MISMATCH', `元数据文件过大：${entryPath}`);
  return entry.data;
}

function parseJsonEntry(entries, entryPath) {
  try {
    return JSON.parse(readMetadataEntry(entries, entryPath).toString('utf8'));
  } catch (error) {
    fail('UOS_PACKAGE_METADATA_MISMATCH', `${entryPath} 不是有效 JSON：${error.message}`);
  }
}

function toUosVersion(releaseVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+)|\.(\d+))?$/u.exec(String(releaseVersion || '').trim());
  if (!match) fail('UOS_PUBLICATION_INPUT_INVALID', `自动送审只接受稳定或 RC 版本：${releaseVersion}`);
  return `${match[1]}.${match[2]}.${match[3]}.${match[4] || match[5] || '0'}`;
}

function assertElfMachine(buffer, expectedMachine, entryPath) {
  if (buffer.length < 20 || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    fail('UOS_PACKAGE_METADATA_MISMATCH', `${entryPath} 不是 ELF`);
  }
  const littleEndian = buffer[5] === 1;
  const machine = littleEndian ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18);
  if (machine !== expectedMachine) {
    fail('UOS_PACKAGE_METADATA_MISMATCH', `${entryPath} ELF machine=${machine} 与架构不符`);
  }
}

function validateDependencyAudit(audit, controlDepends, expected) {
  if (audit.appid !== APP_ID || audit.version !== expected.version || audit.arch !== expected.arch) {
    fail('UOS_DEPENDENCY_AUDIT_MISMATCH', `${expected.arch} 依赖审计身份不匹配`);
  }
  if (!Array.isArray(audit.neededLibraries) || !Array.isArray(audit.depends) || audit.depends.length === 0) {
    fail('UOS_DEPENDENCY_AUDIT_MISMATCH', `${expected.arch} 依赖审计结构无效`);
  }
  if (audit.depends.some((item) => typeof item !== 'string' || !item.trim() || item !== item.trim())) {
    fail('UOS_DEPENDENCY_AUDIT_MISMATCH', `${expected.arch} depends 含无效值`);
  }
  const actualDepends = controlDepends.split(',').map((item) => item.trim()).filter(Boolean);
  if (JSON.stringify(actualDepends) !== JSON.stringify(audit.depends)) {
    fail('UOS_DEPENDENCY_AUDIT_MISMATCH', `${expected.arch} control Depends 与依赖审计不一致`);
  }
  const classified = new Set();
  for (const group of ['systemLibraries', 'bundledLibraries', 'optionalLibraries']) {
    if (!Array.isArray(audit[group])) fail('UOS_DEPENDENCY_AUDIT_MISMATCH', `${expected.arch} 缺少 ${group}`);
    for (const item of audit[group]) {
      if (!item || typeof item.soname !== 'string' || classified.has(item.soname)) {
        fail('UOS_DEPENDENCY_AUDIT_MISMATCH', `${expected.arch} SONAME 分类无效`);
      }
      classified.add(item.soname);
      if (group === 'systemLibraries' && !audit.depends.includes(item.package)) {
        fail('UOS_DEPENDENCY_AUDIT_MISMATCH', `${expected.arch} 系统库 ${item.soname} 未映射到 Depends`);
      }
    }
  }
  for (const item of audit.neededLibraries) {
    if (!item || typeof item.soname !== 'string' || !classified.has(item.soname)) {
      fail('UOS_DEPENDENCY_AUDIT_MISMATCH', `${expected.arch} 存在未映射 SONAME`);
    }
  }
}

function inspectDeb(debPath, auditPath, expected) {
  const deb = fs.readFileSync(debPath);
  if (deb.length === 0 || deb.length > MAX_ARCHIVE_BYTES) fail('UOS_DEB_INVALID', `${expected.arch} DEB 大小无效`);
  const members = parseAr(deb);
  const memberNames = members.map((member) => member.name);
  if (JSON.stringify(memberNames) !== JSON.stringify(['debian-binary', 'control.tar.gz', 'data.tar.gz'])) {
    fail('UOS_DEB_INVALID', `${expected.arch} DEB 成员必须为 gzip control/data`);
  }
  if (members[0].data.toString('ascii') !== '2.0\n') fail('UOS_DEB_INVALID', 'debian-binary 版本无效');
  for (const member of members.slice(1)) {
    if (member.data[0] !== 0x1f || member.data[1] !== 0x8b) fail('UOS_DEB_INVALID', `${member.name} 不是 gzip`);
  }
  let controlTar;
  let dataTar;
  try {
    controlTar = zlib.gunzipSync(members[1].data, { maxOutputLength: MAX_ARCHIVE_BYTES });
    dataTar = zlib.gunzipSync(members[2].data, { maxOutputLength: MAX_ARCHIVE_BYTES });
  } catch (error) {
    fail('UOS_ARCHIVE_INVALID', `${expected.arch} gzip 解压失败：${error.message}`);
  }
  const controlEntries = parseTar(controlTar);
  const dataEntries = parseTar(dataTar);
  const control = parseControl(readMetadataEntry(controlEntries, 'control').toString('utf8'));
  if (control.get('Package') !== APP_ID || control.get('Version') !== expected.version || control.get('Architecture') !== expected.arch) {
    fail('UOS_PACKAGE_METADATA_MISMATCH', `${expected.arch} control 身份不匹配`);
  }
  const packageRoot = `opt/apps/${APP_ID}`;
  const info = parseJsonEntry(dataEntries, `${packageRoot}/info`);
  const marker = parseJsonEntry(dataEntries, `${packageRoot}/files/resources/uos-app-store.json`);
  const desktopEntry = readMetadataEntry(dataEntries, `${packageRoot}/entries/applications/${APP_ID}.desktop`).toString('utf8');
  const executablePath = `${packageRoot}/files/floatboat`;
  // ELF 架构只需前 20 字节，不复制 Electron 大二进制，也不放宽 JSON 等元数据上限。
  const executableHeader = readRegularEntry(dataEntries, executablePath).data.subarray(0, 20);
  if (info.appid !== APP_ID || info.version !== expected.version || JSON.stringify(info.arch) !== JSON.stringify([expected.arch])) {
    fail('UOS_PACKAGE_METADATA_MISMATCH', `${expected.arch} info 身份不匹配`);
  }
  if (marker.appid !== APP_ID) fail('UOS_PACKAGE_METADATA_MISMATCH', `${expected.arch} UOS marker 不匹配`);
  if (!desktopEntry.includes(`Exec=/opt/apps/${APP_ID}/files/floatboat`)) {
    fail('UOS_PACKAGE_METADATA_MISMATCH', `${expected.arch} desktop Exec 不匹配`);
  }
  if (dataEntries.has(`${packageRoot}/files/resources/app-update.yml`)) {
    fail('UOS_PACKAGE_METADATA_MISMATCH', `${expected.arch} 包含应用内更新配置`);
  }
  assertElfMachine(executableHeader, ARCHITECTURES[expected.arch].elfMachine, executablePath);
  let audit;
  try {
    const auditStat = fs.lstatSync(auditPath);
    if (!auditStat.isFile() || auditStat.isSymbolicLink() || auditStat.size <= 0 || auditStat.size > MAX_AUDIT_BYTES) {
      fail('UOS_DEPENDENCY_AUDIT_MISMATCH', `${expected.arch} 依赖审计大小或类型无效`);
    }
    audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
  } catch (error) {
    fail('UOS_DEPENDENCY_AUDIT_MISMATCH', `${expected.arch} 依赖审计无法读取：${error.message}`);
  }
  validateDependencyAudit(audit, control.get('Depends') || '', expected);
  return Object.freeze({
    arch: expected.arch,
    filename: path.basename(debPath),
    sha256: sha256(deb),
    size: deb.length,
    dependencyAuditFilename: path.basename(auditPath),
    dependencyAuditSha256: sha256(fs.readFileSync(auditPath)),
    depends: Object.freeze([...audit.depends]),
  });
}

function walkRegularFiles(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) fail('UOS_ARTIFACT_PATH_UNSAFE', `artifact 包含符号链接：${entryPath}`);
      if (stat.isDirectory()) visit(entryPath);
      else if (stat.isFile()) result.push(entryPath);
      else fail('UOS_ARTIFACT_PATH_UNSAFE', `artifact 包含特殊文件：${entryPath}`);
    }
  };
  visit(root);
  return result;
}

function findSingle(files, basename) {
  const matches = files.filter((file) => path.basename(file) === basename);
  if (matches.length !== 1) fail('UOS_ARTIFACT_SET_INVALID', `${basename} 数量必须为 1，实际 ${matches.length}`);
  return matches[0];
}

function buildUosPublicationManifest(input) {
  const artifactsDir = path.resolve(input.artifactsDir);
  if (!fs.statSync(artifactsDir).isDirectory()) fail('UOS_ARTIFACT_SET_INVALID', 'artifact 根目录不存在');
  const releaseVersion = String(input.releaseVersion || '').trim();
  const packageVersion = toUosVersion(releaseVersion);
  const sourceSha = String(input.sourceSha || '').trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) fail('UOS_PUBLICATION_INPUT_INVALID', 'source SHA 必须是不可变提交 SHA');
  const runId = String(input.runId || '').trim();
  const runAttempt = Number(input.runAttempt);
  if (!/^\d+$/u.test(runId) || !Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    fail('UOS_PUBLICATION_INPUT_INVALID', 'GitHub run identity 无效');
  }
  const files = walkRegularFiles(artifactsDir);
  const packages = Object.keys(ARCHITECTURES).map((arch) => {
    const debName = `Floatboat-${releaseVersion}-${arch}.deb`;
    const auditName = `Floatboat-${releaseVersion}-${arch}-dependency-audit.json`;
    return inspectDeb(findSingle(files, debName), findSingle(files, auditName), { arch, version: packageVersion });
  });
  const allDebs = files.filter((file) => file.endsWith('.deb'));
  const allAudits = files.filter((file) => file.endsWith('-dependency-audit.json'));
  if (allDebs.length !== 2 || allAudits.length !== 2) {
    fail('UOS_ARTIFACT_SET_INVALID', '送审 artifact 必须恰好包含双架构 DEB 与对应审计');
  }
  return Object.freeze({
    schemaVersion: 1,
    appid: APP_ID,
    releaseVersion,
    packageVersion,
    sourceSha,
    github: Object.freeze({ runId, runAttempt }),
    generatedAt: input.generatedAt || new Date().toISOString(),
    packages: Object.freeze(packages),
  });
}

function main(argv) {
  const [artifactsDir, outputPath] = argv;
  if (!artifactsDir || !outputPath) {
    console.error('usage: uos-publication-manifest.cjs <artifacts-dir> <output-json>');
    process.exitCode = 2;
    return;
  }
  const manifest = buildUosPublicationManifest({
    artifactsDir,
    releaseVersion: process.env.UOS_RELEASE_VERSION,
    sourceSha: process.env.UOS_SOURCE_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const manifestSha256 = sha256(fs.readFileSync(outputPath));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `manifest_sha256=${manifestSha256}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `package_version=${manifest.packageVersion}\n`);
  }
  console.log(`UOS_PUBLICATION_MANIFEST_SHA256=${manifestSha256}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof UosPublicationValidationError ? error.code : 'UOS_PUBLICATION_VALIDATION_FAILED';
    console.error(`::error::${code}: ${error instanceof Error ? error.message.replace(/^\w+:\s*/u, '') : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  APP_ID,
  UosPublicationValidationError,
  buildUosPublicationManifest,
  normalizeArchivePath,
  parseAr,
  parseControl,
  parseTar,
  sha256,
  toUosVersion,
};
