#!/usr/bin/env node
// ABOUTME: 用纯 mock 固定统信 Identity 的 RSA、OAuth、验证码和回跳安全边界。

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  UnionTechIdentityError,
  authenticateUnionTechIdentity,
  validateOAuthLoginUrl,
} = require('./uniontech-identity-authenticator.cjs');

function json(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status || 200,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
}

function createHarness(options = {}) {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  let publicPem = options.publicPem ?? publicKey.export({ type: options.keyType || 'pkcs1', format: 'pem' });
  if (options.identityPublicKeyLabel) {
    publicPem = publicPem.replace('BEGIN PUBLIC KEY', 'BEGIN RSA Public Key').replace('END PUBLIC KEY', 'END RSA Public Key');
  }
  const events = [];
  const loginUrl = options.loginUrl || 'https://login.uniontech.com/oauth2/authorize?client_id=client-id&redirect_uri=https%3A%2F%2Fappstore-dev.uniontech.com&response_type=code&scope=base%2Cuser%3Aread&state=expected-state&theme=dark&lang=zh';
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? String(init.body) : '';
    events.push({ url: url.href, path: url.pathname, init, body });
    if (url.href === loginUrl) return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/assets/config/config.json') {
      return json({ JSEncrypt: true, NECaptcha: Boolean(options.captcha) });
    }
    if (url.pathname === '/api/key') {
      return json({ result: true, code: 200, data: Buffer.from(publicPem, 'utf8').toString('base64') });
    }
    if (url.pathname === '/api/oauth2/client') {
      return json({ result: true, code: 200, data: { Name: 'UOS Store', IsGrunt: Boolean(options.consent), Scopes: [1, 2] } });
    }
    if (url.pathname === '/api/oauth2/authorize') {
      return json({
        result: true,
        code: 200,
        data: options.authorizeData || {
          redirect: 'https://appstore-dev.uniontech.com/?code=oauth-code&state=expected-state',
        },
      });
    }
    throw new Error(`unexpected request: ${url.href}`);
  };
  return { events, fetchImpl, loginUrl };
}

for (const [label, keyOptions] of [
  ['PKCS#1', {}],
  ['SPKI', { keyType: 'spki' }],
  ['统信非标准 SPKI 边框', { keyType: 'spki', identityPublicKeyLabel: true }],
]) {
  test(`Identity 使用 ${label} 按公开前端契约初始化 OAuth，并只发送 RSA 密文`, async () => {
    const harness = createHarness(keyOptions);
    const callback = await authenticateUnionTechIdentity({
      loginUrl: harness.loginUrl,
      username: 'release-user@example.com',
      password: 'release-password',
      fetchImpl: harness.fetchImpl,
    });

    assert.deepEqual(callback, { code: 'oauth-code', state: 'expected-state' });
    assert.deepEqual(harness.events.map((event) => event.path), [
      '/oauth2/authorize',
      '/assets/config/config.json',
      '/api/key',
      '/api/oauth2/client',
      '/api/oauth2/authorize',
    ]);
    const initialize = new URLSearchParams(harness.events.find((event) => event.path === '/api/oauth2/client').body);
    assert.equal(initialize.get('client_id'), 'client-id');
    assert.equal(initialize.get('redirect_uri'), 'https://appstore-dev.uniontech.com');
    assert.equal(initialize.get('theme'), 'dark');
    assert.equal(initialize.get('lang'), 'zh');
    const authorize = new URLSearchParams(harness.events.at(-1).body);
    assert.equal(authorize.get('token'), 'has');
    assert.equal(authorize.get('validate'), 'random_hdh');
    assert.equal(authorize.get('user_oauth'), 'o_base');
    assert.equal(authorize.get('theme'), 'dark');
    assert.match(authorize.get('account'), /^[A-Za-z0-9+/]+={0,2}$/u);
    assert.match(authorize.get('password'), /^[A-Za-z0-9+/]+={0,2}$/u);
    assert.notEqual(authorize.get('account'), 'release-user@example.com');
    assert.notEqual(authorize.get('password'), 'release-password');
    assert.doesNotMatch(JSON.stringify(harness.events), /release-user@example\.com|release-password/u);
  });
}

test('Identity 拒绝非 RSA、公钥损坏和未知边框，且不提交凭证', async () => {
  const { publicKey: ecKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { publicKey: rsaKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = rsaKey.export({ type: 'spki', format: 'pem' });
  for (const publicPem of [
    ecKey.export({ type: 'spki', format: 'pem' }),
    '-----BEGIN RSA Public Key-----\ninvalid\n-----END RSA Public Key-----',
    spki.replaceAll('PUBLIC KEY', 'UNKNOWN KEY'),
    spki.replace('BEGIN PUBLIC KEY', 'BEGIN RSA Public Key'),
  ]) {
    const harness = createHarness({ publicPem });
    await assert.rejects(
      () => authenticateUnionTechIdentity({
        loginUrl: harness.loginUrl,
        username: 'release-user',
        password: 'release-password',
        fetchImpl: harness.fetchImpl,
      }),
      (error) => error.code === 'UOS_AUTH_CONTRACT_UNVERIFIED',
    );
    assert.equal(harness.events.some((event) => event.init.method === 'POST'), false);
  }
});

test('Identity 开启验证码、出现授权确认或账户绑定时一律要求人工交互', async () => {
  const cases = [
    createHarness({ captcha: true }),
    createHarness({ consent: true }),
    createHarness({ authorizeData: { need_bind_contact: true } }),
  ];
  for (const harness of cases) {
    await assert.rejects(
      () => authenticateUnionTechIdentity({
        loginUrl: harness.loginUrl,
        username: 'release-user',
        password: 'release-password',
        fetchImpl: harness.fetchImpl,
      }),
      (error) => error instanceof UnionTechIdentityError && error.code === 'UOS_AUTH_INTERACTION_REQUIRED',
    );
  }
});

test('Identity 只接受固定登录域、固定商店回跳和原始 state', async () => {
  assert.throws(
    () => validateOAuthLoginUrl('https://evil.example/oauth2/authorize?client_id=x'),
    (error) => error.code === 'UOS_AUTH_CONTRACT_UNVERIFIED',
  );
  assert.throws(
    () => validateOAuthLoginUrl('https://login.uniontech.com/oauth2/authorize?client_id=x&redirect_uri=https%3A%2F%2Fappstore-dev.uniontech.com&response_type=code&scope=base&state=s&password=injected'),
    (error) => error.code === 'UOS_AUTH_CONTRACT_UNVERIFIED',
  );

  const wrongHost = createHarness({
    authorizeData: { redirect: 'https://evil.example/?code=oauth-code&state=expected-state' },
  });
  await assert.rejects(
    () => authenticateUnionTechIdentity({
      loginUrl: wrongHost.loginUrl,
      username: 'release-user',
      password: 'release-password',
      fetchImpl: wrongHost.fetchImpl,
    }),
    (error) => error.code === 'UOS_AUTH_CONTRACT_UNVERIFIED',
  );

  const wrongState = createHarness({
    authorizeData: { redirect: 'https://appstore-dev.uniontech.com/?code=oauth-code&state=other-state' },
  });
  await assert.rejects(
    () => authenticateUnionTechIdentity({
      loginUrl: wrongState.loginUrl,
      username: 'release-user',
      password: 'release-password',
      fetchImpl: wrongState.fetchImpl,
    }),
    (error) => error.code === 'UOS_AUTH_CONTRACT_UNVERIFIED',
  );
});

test('Identity 网络错误不会把账号密码写入诊断', async () => {
  const loginUrl = 'https://login.uniontech.com/oauth2/authorize?client_id=x&redirect_uri=https%3A%2F%2Fappstore-dev.uniontech.com&response_type=code&scope=base&state=s';
  await assert.rejects(
    () => authenticateUnionTechIdentity({
      loginUrl,
      username: 'release-user',
      password: 'release-password',
      fetchImpl: async () => { throw new Error('release-user release-password'); },
    }),
    (error) => error.code === 'UOS_AUTH_FAILED' && !/release-user|release-password/u.test(error.message),
  );
});
