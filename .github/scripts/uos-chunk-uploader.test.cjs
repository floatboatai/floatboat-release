// ABOUTME: 验证分片上传的并发、幂等重试、取消与脱敏错误边界。
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { uploadChunks, UosChunkUploadError } = require('./uos-chunk-uploader.cjs');

function fixture(count = 1) {
  return Array.from({ length: count }, (_, index) => ({
    url: `https://uploads.example.test/${index}?signature=private-signature`,
    data: Buffer.from(`chunk-${index}`),
  }));
}

test('最多四个 PUT 并发，发送原字节及 URL，不发送商店凭证', async () => {
  const chunks = fixture(11);
  let active = 0;
  let maximum = 0;
  const observed = [];
  const progress = [];
  await uploadChunks(chunks, {
    fetchImpl: async (url, options) => {
      const index = Number(new URL(url).pathname.slice(1));
      assert.equal(String(url), chunks[index].url);
      assert.equal(options.method, 'PUT');
      assert.equal(options.redirect, 'manual');
      assert.deepEqual(options.headers, { 'content-type': 'application/octet-stream' });
      assert.equal(options.body, chunks[index].data);
      maximum = Math.max(maximum, ++active);
      await delay(2);
      observed.push(index);
      active -= 1;
      return new Response(null, { status: 200 });
    },
    onProgress: (event) => progress.push(event),
  });
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.equal(new Set(observed).size, 11);
  assert.deepEqual(progress.at(-1), { event: 'complete', completed: 11, total: 11, retries: 0, reason: null });
});

test('超时、连接中断及临时 HTTP 错误只重试同一分片，退避最多两次', async () => {
  for (const failure of [
    () => { throw Object.assign(new Error('secret url'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); },
    () => { throw Object.assign(new Error('secret url'), { cause: { code: 'ECONNRESET' } }); },
    () => new Response(null, { status: 408 }),
    () => new Response(null, { status: 429 }),
    () => new Response(null, { status: 503 }),
  ]) {
    const chunks = fixture();
    let attempts = 0;
    const waits = [];
    const progress = [];
    await uploadChunks(chunks, {
      fetchImpl: async (url, options) => {
        assert.equal(url, chunks[0].url);
        assert.equal(options.body, chunks[0].data);
        return ++attempts < 3 ? failure() : new Response(null, { status: 200 });
      },
      wait: async (ms) => { waits.push(ms); },
      onProgress: (event) => progress.push(event),
    });
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [1000, 2000]);
    assert.equal(progress.at(-1).retries, 2);
    assert.doesNotMatch(JSON.stringify(progress), /secret|signature|https/iu);
  }
});

test('持续超时最多尝试三次，错误只包含固定原因', async () => {
  let attempts = 0;
  await assert.rejects(uploadChunks(fixture(), {
    fetchImpl: async () => {
      attempts += 1;
      throw Object.assign(new Error('https://private.example/?token=private-secret'), { cause: { code: 'ETIMEDOUT' } });
    },
    wait: async () => {},
  }), (error) => {
    assert.ok(error instanceof UosChunkUploadError);
    assert.equal(error.reason, 'network_timeout');
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.stack, /private|token|https/iu);
    return true;
  });
  assert.equal(attempts, 3);
});

test('单分片 deadline 终止请求后才允许重新发送', async () => {
  let active = 0;
  let attempts = 0;
  // 测试计时器保持事件循环存活；生产 fetch 自身持有活动连接。
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(uploadChunks(fixture(), {
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => {
        assert.equal(active, 0);
        active += 1;
        attempts += 1;
        try { await delay(1000, undefined, { signal }); }
        finally { active -= 1; }
      },
      wait: async () => {},
    }), (error) => error.reason === 'deadline');
  } finally { clearInterval(keepAlive); }
  assert.equal(attempts, 3);
  assert.equal(active, 0);
});

test('TLS、DNS 不存在、重定向和普通 4xx 均不重试', async () => {
  for (const [failure, reason] of [
    [() => { throw Object.assign(new Error('private'), { cause: { code: 'CERT_HAS_EXPIRED' } }); }, 'tls'],
    [() => { throw Object.assign(new Error('private'), { cause: { code: 'ENOTFOUND' } }); }, 'dns'],
    [() => new Response(null, { status: 302 }), 'redirect'],
    [() => new Response(null, { status: 403 }), 'http_rejected'],
    [() => { throw new Error('private'); }, 'network_other'],
  ]) {
    let attempts = 0;
    await assert.rejects(uploadChunks(fixture(), {
      fetchImpl: async () => { attempts += 1; return failure(); },
      wait: async () => { assert.fail('不应重试'); },
    }), (error) => error.reason === reason && error.retryable === false);
    assert.equal(attempts, 1);
  }
});

test('不可恢复错误会取消其余在途分片、等待清理且不启动新分片', async () => {
  let active = 0;
  const started = [];
  await assert.rejects(uploadChunks(fixture(10), {
    fetchImpl: async (url, { signal }) => {
      const index = Number(new URL(url).pathname.slice(1));
      started.push(index);
      if (index === 0) {
        await delay(5);
        return new Response(null, { status: 403 });
      }
      active += 1;
      try { await delay(1000, undefined, { signal }); }
      finally { active -= 1; }
    },
  }), (error) => error.reason === 'http_rejected');
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(active, 0);
});

test('先校验所有上传 URL，拒绝协议和内嵌凭证时不发送任何分片', async () => {
  for (const url of ['http://uploads.example.test/a', 'https://user:password@uploads.example.test/a', 'invalid']) {
    const chunks = fixture(2);
    chunks[1].url = url;
    await assert.rejects(uploadChunks(chunks, {
      fetchImpl: async () => { assert.fail('URL 校验失败时不应联网'); },
    }), (error) => error.reason === 'invalid_url' && error.retryable === false);
  }
});
