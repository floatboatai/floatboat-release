// ABOUTME: 使用有界并发和幂等重试上传原始分片，所有失败只输出固定原因。
'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const CHUNK_TIMEOUT_MS = 300_000;

class UosChunkUploadError extends Error {
  constructor(reason, retryable = false, httpStatus) {
    super(`分片上传失败 (${reason})${Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? ` HTTP ${httpStatus}` : ''}`);
    this.name = 'UosChunkUploadError';
    this.reason = reason;
    this.retryable = retryable;
  }
}

function networkFailure(error, deadline) {
  if (deadline.aborted) return new UosChunkUploadError('deadline', true);
  const codes = [];
  for (let item = error, depth = 0; item && depth < 4; item = item.cause, depth += 1) {
    if (typeof item.code === 'string') codes.push(item.code);
  }
  if (codes.some((code) => /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/u.test(code))) {
    return new UosChunkUploadError('tls');
  }
  if (codes.includes('UND_ERR_CONNECT_TIMEOUT')) return new UosChunkUploadError('connect_timeout', true);
  if (codes.some((code) => ['ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code))) {
    return new UosChunkUploadError('network_timeout', true);
  }
  if (codes.includes('ENOTFOUND')) return new UosChunkUploadError('dns');
  if (codes.includes('EAI_AGAIN')) return new UosChunkUploadError('dns_temporary', true);
  if (codes.some((code) => ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ECONNABORTED'].includes(code))) {
    return new UosChunkUploadError('connection_reset', true);
  }
  return new UosChunkUploadError('network_other');
}

function validateChunkUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const localTest = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !localTest) || url.username || url.password || url.hash) throw new Error();
  } catch { throw new UosChunkUploadError('invalid_url'); }
}

async function putChunk(chunk, options, cancelled) {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? CHUNK_TIMEOUT_MS);
  const signal = AbortSignal.any([deadline, cancelled]);
  try {
    const response = await options.fetchImpl(chunk.url, {
      method: 'PUT',
      // 签名 URL 不得自动跳转；manual 仅用于区分 3xx，绝不读取或访问 Location。
      redirect: 'manual',
      headers: { 'content-type': 'application/octet-stream' },
      body: chunk.data,
      signal,
    });
    // PUT 不消费响应内容，也不将服务端正文带入日志。
    if (response.body) await response.body.cancel();
    if (response.status >= 300 && response.status < 400) throw new UosChunkUploadError('redirect', false, response.status);
    if (!response.ok) {
      const temporary = [408, 429].includes(response.status) || response.status >= 500;
      throw new UosChunkUploadError(temporary ? 'http_temporary' : 'http_rejected', temporary, response.status);
    }
  } catch (error) {
    if (cancelled.aborted) throw new UosChunkUploadError('cancelled');
    if (error instanceof UosChunkUploadError) throw error;
    throw networkFailure(error, deadline);
  }
}

async function uploadChunks(chunks, options) {
  for (const chunk of chunks) validateChunkUrl(chunk.url);
  const controller = new AbortController();
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  let next = 0;
  let completed = 0;
  let retries = 0;
  let failure;
  const report = (event, reason = null) => options.onProgress?.(Object.freeze({
    event, completed, total: chunks.length, retries, reason,
  }));
  report('start');
  const worker = async () => {
    try {
      while (!controller.signal.aborted && next < chunks.length) {
        const chunk = chunks[next++];
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          try {
            await putChunk(chunk, options, controller.signal);
            completed += 1;
            report('complete');
            break;
          } catch (error) {
            if (controller.signal.aborted || !(error instanceof UosChunkUploadError) || !error.retryable || attempt === MAX_ATTEMPTS) throw error;
            retries += 1;
            report('retry', error.reason);
            await wait(attempt * 1000, controller.signal);
            controller.signal.throwIfAborted();
          }
        }
      }
    } catch (error) {
      if (!failure) {
        failure = error instanceof UosChunkUploadError ? error : new UosChunkUploadError('upload_interrupted');
        controller.abort();
      }
    }
  };
  // 取消后等待所有在途请求退出，调用方才可清理或决定重跑。
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
  if (failure) throw failure;
}

module.exports = { uploadChunks, UosChunkUploadError };
