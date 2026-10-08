#!/usr/bin/env node
// ABOUTME: 覆盖 updater 发布门禁对正确元数据、错误版本和损坏摘要的判定。

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const { createEnvelope } = require('./release-notes-envelope.cjs');
const { verifyUpdateMetadata } = require('./verify-update-metadata.cjs');

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floatboat-updater-metadata-'));
  const artifactDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(artifactDirectory);
  const artifactName = 'Floatboat-1.2.3-arm64.zip';
  const artifactPath = path.join(artifactDirectory, artifactName);
  const content = Buffer.from('verified updater artifact');
  fs.writeFileSync(artifactPath, content);
  const sha512 = crypto.createHash('sha512').update(content).digest('base64');
  const metadataPath = path.join(root, 'latest-mac.yml');
  const payloadPath = path.join(root, 'release-notes.json');
  const releaseNotes = createEnvelope('1.2.3', 'English notes', '中文说明');
  fs.writeFileSync(payloadPath, releaseNotes.payload);
  const metadata = {
    version: '1.2.3',
    files: [{ url: artifactName, size: content.byteLength, sha512 }],
    path: artifactName,
    sha512,
    releaseDate: '2026-07-28T00:00:00.000Z',
    releaseNotes: releaseNotes.payload,
  };
  fs.writeFileSync(metadataPath, yaml.dump(metadata), 'utf8');
  return { root, artifactDirectory, artifactName, metadataPath, metadata, payloadPath, releaseNotes };
}

function verifyFixture(fixture, overrides = {}) {
  return verifyUpdateMetadata({
    metadataPath: fixture.metadataPath,
    artifactDirectory: fixture.artifactDirectory,
    releaseVersion: '1.2.3',
    expectedArtifacts: [fixture.artifactName],
    releaseNotesPayloadPath: fixture.payloadPath,
    releaseNotesSha256: fixture.releaseNotes.digest,
    baseVersion: '1.2.3',
    ...overrides,
  });
}

test('接受版本、大小和 SHA512 全部匹配的元数据', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = verifyFixture(fixture);

  assert.equal(result.releaseVersion, '1.2.3');
  assert.equal(result.artifactCount, 1);
});

test('拒绝错误发行版本', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.throws(() => verifyFixture(fixture, { releaseVersion: '1.2.4' }), /元数据版本不匹配/);
});

test('拒绝与本地制品不一致的 SHA512', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fixture.metadata.files[0].sha512 = crypto.createHash('sha512').update('other').digest('base64');
  fixture.metadata.sha512 = fixture.metadata.files[0].sha512;
  fs.writeFileSync(fixture.metadataPath, yaml.dump(fixture.metadata), 'utf8');

  assert.throws(() => verifyFixture(fixture), /制品 SHA512 不匹配/);
});

test('拒绝元数据中的额外制品', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fixture.metadata.files.push({
    url: 'Floatboat-Other-1.2.3.zip',
    size: 1,
    sha512: fixture.metadata.sha512,
  });
  fs.writeFileSync(fixture.metadataPath, yaml.dump(fixture.metadata), 'utf8');

  assert.throws(() => verifyFixture(fixture), /元数据制品集合不匹配/);
});


test('拒绝 releaseNotes payload bytes 漂移', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fixture.metadata.releaseNotes = createEnvelope('1.2.3', 'Changed notes', '中文说明').payload;
  fs.writeFileSync(fixture.metadataPath, yaml.dump(fixture.metadata), 'utf8');
  assert.throws(() => verifyFixture(fixture), /canonical payload bytes 不一致/);
});

test('接受 DeepSeek qualifier 并拒绝错误基础版本', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fixture.metadata.version = '1.2.3-deepseek';
  fs.writeFileSync(fixture.metadataPath, yaml.dump(fixture.metadata), 'utf8');
  assert.doesNotThrow(() => verifyFixture(fixture, { releaseVersion: '1.2.3-deepseek' }));
  assert.throws(() => verifyFixture(fixture, { releaseVersion: '1.2.3-deepseek', baseVersion: '1.2.4' }), /基础版本不匹配/);
});


test('拒绝非 stable metadata 携带 releaseNotes', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.throws(
    () => verifyFixture(fixture, {
      releaseNotesPayloadPath: '',
      releaseNotesSha256: '',
      baseVersion: '',
      forbidReleaseNotes: true,
    }),
    /非 stable updater 元数据不得包含 releaseNotes/,
  );
  delete fixture.metadata.releaseNotes;
  fs.writeFileSync(fixture.metadataPath, yaml.dump(fixture.metadata), 'utf8');
  assert.doesNotThrow(() => verifyFixture(fixture, {
    releaseNotesPayloadPath: '',
    releaseNotesSha256: '',
    baseVersion: '',
    forbidReleaseNotes: true,
  }));
});
