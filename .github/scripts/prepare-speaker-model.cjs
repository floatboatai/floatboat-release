#!/usr/bin/env node
// ABOUTME: 将固定 CAM++ 权重和许可证准备到随包资源目录，缓存与下载都必须通过大小和摘要校验。
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { MODEL } = require('./packaged-speaker-runtime.cjs');

async function validCache(modelPath, model) {
  try {
    const stat = await fsp.lstat(modelPath);
    if (!stat.isFile() || stat.size !== model.bytes) return false;
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(modelPath)) digest.update(chunk);
    return digest.digest('hex') === model.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function downloadModel(modelPath, model, fetchModel) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporaryPath = `${modelPath}.download-${crypto.randomUUID()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let handle;
    try {
      const response = await fetchModel(model.url, { signal: controller.signal });
      assert.ok(response.ok && response.body, `MODEL_DOWNLOAD_HTTP_${response.status}`);
      handle = await fsp.open(temporaryPath, 'wx');
      const digest = crypto.createHash('sha256');
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        assert.ok(bytes <= model.bytes, 'MODEL_SIZE_MISMATCH');
        digest.update(chunk);
        await handle.writeFile(chunk);
      }
      assert.equal(bytes, model.bytes, 'MODEL_SIZE_MISMATCH');
      assert.equal(digest.digest('hex'), model.sha256, 'MODEL_SHA256_MISMATCH');
      await handle.sync();
      await handle.close();
      handle = undefined;
      // 只有完整验证的临时文件才可替换缓存，失败时保留原文件用于排查。
      await fsp.rename(temporaryPath, modelPath);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await handle?.close();
      await fsp.rm(temporaryPath, { force: true });
    }
  }
  throw lastError;
}

async function prepareSpeakerModel(destination, { model = MODEL, fetchModel = fetch } = {}) {
  assert.ok(destination, 'MODEL_DESTINATION_REQUIRED');
  assert.match(model.sha256, /^[a-f0-9]{64}$/u, 'MODEL_SHA256_REQUIRED');
  assert.ok(Number.isSafeInteger(model.bytes) && model.bytes > 0, 'MODEL_SIZE_REQUIRED');
  const directory = path.resolve(destination);
  await fsp.mkdir(directory, { recursive: true });
  const modelPath = path.join(directory, `${model.sha256}.onnx`);
  const cached = await validCache(modelPath, model);
  if (!cached) await downloadModel(modelPath, model, fetchModel);
  await fsp.copyFile(path.join(__dirname, 'campplus-LICENSE.txt'), path.join(directory, 'LICENSE.campplus'));
  await fsp.writeFile(path.join(directory, 'NOTICE.campplus'), [
    'CAM++ speaker embedding model (3D-Speaker)',
    'Model card: https://modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common',
    `ONNX distribution: ${model.url}`,
    `SHA256: ${model.sha256}`,
    `Bytes: ${model.bytes}`,
    'License: Apache-2.0 (see LICENSE.campplus)',
    '',
  ].join('\n'));
  return { modelPath, cached, sha256: model.sha256, bytes: model.bytes };
}

if (require.main === module) {
  prepareSpeakerModel(process.argv[2]).then((result) => {
    console.log(`Verified bundled CAM++ model (${result.cached ? 'cache' : 'download'}, ${result.bytes} bytes)`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { prepareSpeakerModel };
