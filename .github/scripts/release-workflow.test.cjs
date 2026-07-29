#!/usr/bin/env node
// ABOUTME: 锁定正式发布才会执行双变体 S3 updater 发布脚本。

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowPath = path.join(__dirname, '..', 'workflows', 'release.yml');

function readNamedStep(workflow, stepName) {
  const startMarker = `      - name: ${stepName}`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `workflow 缺少步骤：${stepName}`);
  const nextStep = workflow.indexOf('\n      - name:', start + startMarker.length);
  return workflow.slice(start, nextStep === -1 ? workflow.length : nextStep);
}

test('只有正式 release 会发布并验证 Floatboat 与 DeepSeek stable feed', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const publishStep = readNamedStep(workflow, 'Publish and verify stable updater feeds');

  assert.match(publishStep, /inputs\.is_rc == false/);
  assert.match(publishStep, /inputs\.build_profile == 'release'/);
  assert.match(publishStep, /needs\.prepare\.outputs\.package_set != 'launcher'/);
  assert.match(publishStep, /FLOATBOAT_VERSION: \$\{\{ needs\.prepare\.outputs\.floatboat_version \}\}/);
  assert.match(publishStep, /DEEPSEEK_VERSION: \$\{\{ needs\.prepare\.outputs\.deepseek_version \}\}/);
  assert.match(publishStep, /bash release-tooling\/\.github\/scripts\/publish-stable-updater\.sh/);
});
