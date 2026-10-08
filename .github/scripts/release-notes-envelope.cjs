#!/usr/bin/env node
// ABOUTME: 为 stable updater 生成唯一 canonical 双语 release note envelope，并安全注入 metadata。

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'floatboat-release-notes';
const SCHEMA_VERSION = 1;
const MAX_NOTE_BYTES = 16 * 1024;
const MAX_PAYLOAD_BYTES = 36 * 1024;

function fail(message) { throw new Error(message); }

function normalizeNote(value, language) {
  const normalized = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) fail(`${language} release notes 不能为空`);
  const size = Buffer.byteLength(normalized, 'utf8');
  if (size > MAX_NOTE_BYTES) fail(`${language} release notes 超过 16 KiB：${size} bytes`);
  return normalized;
}

function createEnvelope(baseVersion, english, chinese) {
  const version = String(baseVersion ?? '').trim();
  if (!version || /[\r\n]/.test(version)) fail('基础 release version 无效');
  const payload = JSON.stringify({
    marker: MARKER,
    schemaVersion: SCHEMA_VERSION,
    version,
    notes: { en: normalizeNote(english, '英文'), 'zh-CN': normalizeNote(chinese, '简体中文') },
  });
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) fail(`canonical release note envelope 超过 36 KiB：${payloadBytes} bytes`);
  return {
    payload,
    digest: crypto.createHash('sha256').update(payload, 'utf8').digest('hex'),
    payloadBytes,
    version,
  };
}

function parseCanonicalPayload(payload) {
  let parsed;
  try { parsed = JSON.parse(payload); } catch { fail('release note payload 不是合法 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.marker !== MARKER ||
      parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.version !== 'string' ||
      !parsed.notes || typeof parsed.notes !== 'object' || Array.isArray(parsed.notes)) {
    fail('release note payload 不符合 schemaVersion 1 envelope');
  }
  const canonical = createEnvelope(parsed.version, parsed.notes.en, parsed.notes['zh-CN']);
  if (canonical.payload !== payload) fail('release note payload 不是 canonical 序列化结果');
  return canonical;
}

function injectPayload(metadataPath, payloadPath) {
  const payload = fs.readFileSync(payloadPath, 'utf8');
  parseCanonicalPayload(payload);
  const yaml = require('js-yaml');
  const metadata = yaml.load(fs.readFileSync(metadataPath, 'utf8'));
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail(`updater metadata 不是对象：${metadataPath}`);
  metadata.releaseNotes = payload;
  fs.writeFileSync(metadataPath, yaml.dump(metadata, { lineWidth: -1, noRefs: true, sortKeys: false }), 'utf8');
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) fail(`${name} 为必填项`);
  return argv[index + 1];
}

function main(argv) {
  const command = argv[0];
  if (command === 'generate') {
    const result = createEnvelope(readOption(argv, '--base-version'), process.env.RELEASE_NOTES_EN, process.env.RELEASE_NOTES_ZH_CN);
    const payloadOutput = path.resolve(readOption(argv, '--payload-output'));
    const manifestOutput = path.resolve(readOption(argv, '--manifest-output'));
    fs.mkdirSync(path.dirname(payloadOutput), { recursive: true });
    fs.mkdirSync(path.dirname(manifestOutput), { recursive: true });
    fs.writeFileSync(payloadOutput, result.payload, 'utf8');
    fs.writeFileSync(manifestOutput, `${JSON.stringify({ marker: MARKER, schemaVersion: SCHEMA_VERSION, version: result.version, payloadSha256: result.digest, payloadBytes: result.payloadBytes })}\n`, 'utf8');
    process.stdout.write(`✅ canonical release note envelope: ${result.digest}\n`);
    return;
  }
  if (command === 'inject') {
    injectPayload(path.resolve(readOption(argv, '--metadata')), path.resolve(readOption(argv, '--payload')));
    return;
  }
  fail('用法：release-notes-envelope.cjs <generate|inject> ...');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`❌ ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}

module.exports = { createEnvelope, injectPayload, parseCanonicalPayload };
