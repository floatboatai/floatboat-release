// ABOUTME: 验证随包模型下载和缓存都按固定大小、摘要校验，不让损坏权重进入安装包。
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareSpeakerModel } = require('./prepare-speaker-model.cjs');

const bytes = Buffer.from('verified model fixture');
const model = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), url: 'https://fixture.invalid/model' };
async function fixture(run) {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-model-'));
  try { return await run(destination); } finally { fs.rmSync(destination, { recursive: true, force: true }); }
}

test('首次下载固定模型及许可证，命中可信缓存时无需网络', async () => {
  await fixture(async (destination) => {
    let calls = 0;
    const fetchModel = async () => { calls++; return new Response(bytes); };
    await prepareSpeakerModel(destination, { model, fetchModel });
    assert.deepEqual(fs.readFileSync(path.join(destination, `${model.sha256}.onnx`)), bytes);
    assert.match(fs.readFileSync(path.join(destination, 'LICENSE.campplus'), 'utf8'), /Apache License/);
    assert.match(fs.readFileSync(path.join(destination, 'NOTICE.campplus'), 'utf8'), /modelscope\.cn/);
    await prepareSpeakerModel(destination, { model, fetchModel: async () => { throw new Error('offline'); } });
    assert.equal(calls, 1);
  });
});

test('损坏缓存重新下载，错误大小或摘要不得替换为可用权重', async () => {
  await fixture(async (destination) => {
    const modelPath = path.join(destination, `${model.sha256}.onnx`);
    fs.writeFileSync(modelPath, Buffer.alloc(bytes.length));
    await assert.rejects(prepareSpeakerModel(destination, { model, fetchModel: async () => new Response(Buffer.alloc(bytes.length)) }), /MODEL_SHA256_MISMATCH/);
    assert.deepEqual(fs.readFileSync(modelPath), Buffer.alloc(bytes.length));
    await assert.rejects(prepareSpeakerModel(destination, { model, fetchModel: async () => new Response(Buffer.alloc(bytes.length + 1)) }), /MODEL_SIZE_MISMATCH/);
    await prepareSpeakerModel(destination, { model, fetchModel: async () => new Response(bytes) });
    assert.deepEqual(fs.readFileSync(modelPath), bytes);
    assert.equal(fs.readdirSync(destination).some((name) => name.includes('.download-')), false);
  });
});
