#!/usr/bin/env node
// ABOUTME: 验证双语 release note envelope 的 canonicalization、限制与 metadata 注入。

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const { createEnvelope, injectPayload, parseCanonicalPayload } = require('./release-notes-envelope.cjs');

test('归一化 CRLF、trim 并按固定字段顺序生成 digest', () => {
  const result = createEnvelope('1.2.3', '  First\r\n\rLine  ', '\r\n 中文内容 \r\n');
  assert.equal(result.payload, '{"marker":"floatboat-release-notes","schemaVersion":1,"version":"1.2.3","notes":{"en":"First\\n\\nLine","zh-CN":"中文内容"}}');
  assert.equal(result.digest, crypto.createHash('sha256').update(result.payload).digest('hex'));
  assert.deepEqual(parseCanonicalPayload(result.payload), result);
});

test('拒绝空语言与超过 16 KiB 的正文', () => {
  assert.throws(() => createEnvelope('1.2.3', ' ', '中文'), /英文 release notes 不能为空/);
  assert.throws(() => createEnvelope('1.2.3', 'a'.repeat(16 * 1024 + 1), '中文'), /超过 16 KiB/);
});

test('把 payload 字节等值写入 updater 标准 releaseNotes 字段', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-note-envelope-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadataPath = path.join(root, 'latest.yml');
  const payloadPath = path.join(root, 'payload.json');
  const result = createEnvelope('1.2.3', 'Markdown **body**', '中文正文');
  fs.writeFileSync(metadataPath, yaml.dump({ version: '1.2.3', files: [] }));
  fs.writeFileSync(payloadPath, result.payload);
  injectPayload(metadataPath, payloadPath);
  assert.equal(yaml.load(fs.readFileSync(metadataPath, 'utf8')).releaseNotes, result.payload);
});


test('release workflow 仅为 official stable app 生成并传播 canonical payload', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /release_notes_en:\n[\s\S]*?type: string/);
  assert.match(workflow, /release_notes_zh_cn:\n[\s\S]*?type: string/);
  assert.match(workflow, /skip_release_notes:\n[\s\S]*?default: false[\s\S]*?type: boolean/);
  assert.match(
    workflow,
    /\[ "\$NOTIFY_ONLY" = "false" \] && \[ "\$IS_RC" = "false" \] && \[ "\$BUILD_PROFILE" = "release" \] && \[ "\$PACKAGE_SET" != "launcher" \]/,
  );
  assert.match(workflow, /\[ "\$is_stable_app_release" = "true" \] && \[ "\$SKIP_RELEASE_NOTES" = "true" \]/);
  assert.match(workflow, /skip_release_notes=true cannot be combined with release note content/);
  assert.match(workflow, /Official stable release will be published without public release notes/);
  assert.match(workflow, /name: stable-release-notes/);
  assert.match(workflow, /release-notes-envelope\.cjs inject/);
  assert.match(workflow, /--forbid-release-notes/);
  assert.match(workflow, /body_path: \/tmp\/empty-release-body\.md/);
});

test('每个 Desktop 打包任务在打包前领取同一说明 artifact，非正式构建清理残留', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'release.yml'), 'utf8'));
  for (const jobName of ['build-macos-arm64', 'build-macos-x64', 'build-windows', 'build-linux', 'build-linux-uos']) {
    const steps = workflow.jobs[jobName].steps;
    const clear = steps.findIndex((step) => step.name === 'Clear bundled release notes');
    const download = steps.findIndex((step) => step.name === 'Download bundled release notes');
    const verify = steps.findIndex((step) => step.name === 'Verify bundled release notes digest');
    const packageStep = steps.findIndex((step) => /pnpm run forge:make/.test(step.run || ''));
    assert.ok(clear >= 0 && clear < download && download < verify && verify < packageStep, jobName);
    assert.equal(steps[clear].if, undefined, jobName);
    assert.match(steps[clear].run, /rm -rf resources\/release-notes/);
    assert.equal(steps[download].uses, 'actions/download-artifact@v4');
    assert.equal(steps[download].with.name, 'stable-release-notes');
    assert.equal(steps[download].with.path, 'resources/release-notes/');
    assert.equal(steps[download].if, "needs.prepare.outputs.release_notes_enabled == 'true'");
    assert.equal(steps[verify].if, steps[download].if);
    assert.equal(steps[verify].env.RELEASE_NOTES_SHA256, '${{ needs.prepare.outputs.release_notes_sha256 }}');
    assert.match(steps[verify].run, /resources\/release-notes\/payload.json/);
  }
});
