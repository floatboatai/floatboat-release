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
  const metadata = {
    version: '1.2.3',
    files: [{ url: artifactName, size: content.byteLength, sha512 }],
    path: artifactName,
    sha512,
    releaseDate: '2026-07-28T00:00:00.000Z',
  };
  fs.writeFileSync(metadataPath, yaml.dump(metadata), 'utf8');
  return { root, artifactDirectory, artifactName, metadataPath, metadata };
}

function verifyFixture(fixture, overrides = {}) {
  return verifyUpdateMetadata({
    metadataPath: fixture.metadataPath,
    artifactDirectory: fixture.artifactDirectory,
    releaseVersion: '1.2.3',
    expectedArtifacts: [fixture.artifactName],
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
