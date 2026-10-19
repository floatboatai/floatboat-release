#!/usr/bin/env node
// ABOUTME: 从固定脚本路径解析内部 updater YAML，避免临时工作目录改变依赖解析根。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function fail(message) {
  throw new Error(message);
}

function loadObject(filePath) {
  const value = yaml.load(fs.readFileSync(filePath, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`YAML 必须是对象：${filePath}`);
  }
  return value;
}

function listArtifacts(filePath) {
  const value = loadObject(filePath);
  if (!Array.isArray(value.files)) fail('metadata files 必须是数组');
  return value.files.map((item) => {
    const name = String(item?.url || '');
    if (!name || path.basename(name) !== name || name.includes('\\')) {
      fail(`非法 metadata 制品名：${name}`);
    }
    return name;
  });
}

function verifyChannel(filePath, expectedTrack) {
  const value = loadObject(filePath);
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'preferredPrerelease' ||
    keys[1] !== 'schemaVersion' ||
    value.schemaVersion !== 1 ||
    value.preferredPrerelease !== expectedTrack
  ) {
    fail('公网 channel.yml 不符合受控 schema');
  }
}

function main(argv) {
  const [command, filePath, expectedTrack] = argv;
  if (command === 'list-artifacts' && filePath) {
    process.stdout.write(`${listArtifacts(filePath).join('\n')}\n`);
    return;
  }
  if (command === 'verify-channel' && filePath && expectedTrack) {
    verifyChannel(filePath, expectedTrack);
    return;
  }
  fail('用法：internal-updater-yaml.cjs <list-artifacts|verify-channel> <file> [expected-track]');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { listArtifacts, verifyChannel };
