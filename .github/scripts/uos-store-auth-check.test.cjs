#!/usr/bin/env node
// ABOUTME: 验证独立认证检查只读取开发者与应用身份，并锁定日志和工作流权限边界。

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { UosStoreApiClient, UosStoreApiError } = require('./uos-store-api-client.cjs');
const { checkUosAuthentication, runAuthenticationCheck } = require('./uos-store-auth-check.cjs');

const APP_ID = 'com.floatboat.desktop';

function outputCapture() {
  const info = [];
  const errors = [];
  return { info, errors, log: (value) => info.push(value), error: (value) => errors.push(value) };
}

test('商店失败输出具体接口和独立状态码，登录沿用官网 JSON 与同源头', async () => {
  const base = 'https://appstore-dev.uniontech.com';
  const login = 'https://login.uniontech.com/oauth2/authorize?client_id=mock&redirect_uri=https%3A%2F%2Fappstore-dev.uniontech.com&response_type=code&scope=base&state=mock-state';
  for (const [failedPath, operation] of [
    ['/store-dev-auth/login', 'login_callback'],
    ['/store-dev-auth/dev_info', 'developer_info'],
    ['/store-dev-app/app', 'applications'],
  ]) {
    const capture = outputCapture();
    const paths = [];
    const client = new UosStoreApiClient({
      baseUrl: base,
      identityAuthenticator: async () => ({ code: 'private-code', state: 'mock-state' }),
      fetchImpl: async (input, init) => {
        const pathname = new URL(input).pathname.replace('/devprod-api', '');
        paths.push(pathname);
        assert.equal(init.headers.origin, base);
        assert.equal(init.headers.referer, `${base}/`);
        if (pathname === '/store-dev-auth/getLoginPath') return Response.json({ status: 200, datas: login });
        if (pathname === '/store-dev-auth/login') {
          assert.equal(init.method, 'POST');
          assert.equal(init.headers['content-type'], 'application/json;charset=utf-8');
          assert.deepEqual(JSON.parse(init.body), { code: 'private-code', state: 'mock-state' });
        }
        if (pathname === failedPath) return Response.json({ status: 400, code: 10001, desc: 'state private-code private-password https://private.invalid/' });
        if (pathname === '/store-dev-auth/login') return Response.json({ status: 200, datas: {} }, { headers: { 'set-cookie': 'access-token=private-cookie; Secure; HttpOnly' } });
        if (pathname === '/store-dev-auth/dev_info') return Response.json({ status: 200, datas: { dev_type: 0 } });
        assert.fail('失败后不能继续请求');
      },
    });
    assert.equal(await runAuthenticationCheck({ client, credentials: { username: 'private-account', password: 'private-password' }, ...capture }), 1);
    const diagnostic = JSON.parse(capture.errors[0].slice('UOS authentication check failed: '.length));
    assert.deepEqual(diagnostic.storeResponse, { operation, httpStatus: 200, status: 400, code: 10001, reasonClass: 'state' });
    assert.equal(paths.at(-1), failedPath);
    assert.deepEqual(capture.info, []);
    assert.doesNotMatch(capture.errors.join(''), /private-|https?:|mock-state/u);
  }
});

test('商店响应诊断拒绝额外字段、访问器和非法数值，不输出服务端正文', async () => {
  const valid = { operation: 'login_callback', httpStatus: 200, status: 400, code: null, reasonClass: 'unknown' };
  for (const value of [
    { ...valid, desc: 'private-token' }, { ...valid, operation: 'private-token' },
    { ...valid, httpStatus: '200' }, { ...valid, code: 9999999 },
    { ...valid, reasonClass: 'private-token' }, Object.assign(Object.create({}), valid),
    Object.defineProperty({ ...valid }, 'code', { get() { throw new Error('private-token'); } }),
  ]) {
    const capture = outputCapture();
    const client = { authenticate: async () => { throw new UosStoreApiError('UOS_STORE_REQUEST_REJECTED', 'private-token', { storeResponse: value }); } };
    assert.equal(await runAuthenticationCheck({ client, credentials: {}, ...capture }), 1);
    assert.doesNotMatch(capture.errors.join(''), /storeResponse|private-|9999999/u);
  }
});

test('认证成功后只确认目标应用，返回值不包含平台记录', async () => {
  const calls = [];
  const credentials = { username: 'private-account', password: 'private-password' };
  const client = new Proxy({
    async authenticate(value) {
      calls.push('authenticate');
      assert.equal(value, credentials);
    },
    async resolveApplicationRecord(appid) {
      calls.push('resolveApplicationRecord');
      assert.equal(appid, APP_ID);
      return { appId: 'private-app-id', currentVersionId: 'private-version', record: { secret: 'private-record' } };
    },
  }, {
    get(target, property) {
      assert.ok(Object.hasOwn(target, property), `认证检查不允许额外操作：${String(property)}`);
      return target[property];
    },
  });

  const result = await checkUosAuthentication({ client, credentials });

  assert.deepEqual(calls, ['authenticate', 'resolveApplicationRecord']);
  assert.deepEqual(result, { appid: APP_ID, status: 'ready' });
});

test('认证失败时不会读取应用或继续其他操作', async () => {
  const failure = new UosStoreApiError('UOS_AUTH_INTERACTION_REQUIRED', '统信开发者账号需要人工完成身份选择或认证');
  const client = {
    async authenticate() { throw failure; },
    async resolveApplicationRecord() { assert.fail('认证失败后不能读取应用'); },
  };

  await assert.rejects(() => checkUosAuthentication({ client, credentials: {} }), (error) => error === failure);
});

test('应用身份未确认时失败，不输出 ready 或平台记录', async () => {
  const capture = outputCapture();
  const client = {
    async authenticate() {},
    async resolveApplicationRecord() {
      throw new UosStoreApiError('UOS_APPLICATION_IDENTITY_UNCONFIRMED', 'private-app-record private-account');
    },
  };

  assert.equal(await runAuthenticationCheck({ client, credentials: {}, ...capture }), 1);
  assert.deepEqual(capture.info, []);
  assert.equal(capture.errors.length, 1);
  assert.match(capture.errors[0], /UOS_APPLICATION_IDENTITY_UNCONFIRMED/u);
  assert.doesNotMatch(capture.errors[0], /private-app-record|private-account|ready/u);
});

test('未知异常只输出固定失败分类，不泄露异常正文与任意属性', async () => {
  const capture = outputCapture();
  const client = {
    async authenticate() {
      throw Object.assign(new Error('private-password https://example.test/?code=private-code'), {
        code: 'UOS_private-token',
        cookie: 'private-cookie',
        callbackShape: { originClass: 'private-host' },
      });
    },
  };

  assert.equal(await runAuthenticationCheck({ client, credentials: {}, ...capture }), 1);
  assert.deepEqual(capture.info, []);
  assert.equal(capture.errors.length, 1);
  assert.match(capture.errors[0], /UOS_AUTH_CHECK_FAILED/u);
  assert.doesNotMatch(capture.errors[0], /private-|example\.test|callbackShape/u);
});

test('契约错误只输出固定原因与经过校验的回跳分类', async () => {
  const capture = outputCapture();
  const callbackShape = {
    originClass: 'identity_https',
    protocolClass: 'https',
    portClass: 'default',
    pathClass: 'follow',
    hasUserinfo: false,
    hasFragment: false,
  };
  const client = {
    async authenticate() {
      throw Object.assign(new UosStoreApiError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 OAuth 回跳不属于固定开发者平台'), {
        callbackShape,
        token: 'private-token',
      });
    },
  };

  assert.equal(await runAuthenticationCheck({ client, credentials: {}, ...capture }), 1);
  assert.match(capture.errors[0], /统信 OAuth 回跳不属于固定开发者平台/u);
  assert.match(capture.errors[0], /"originClass":"identity_https"/u);
  assert.match(capture.errors[0], /"pathClass":"follow"/u);
  assert.doesNotMatch(capture.errors[0], /private-token/u);
});

test('实际 API 调用验证开发者会话后读取应用，不进入包上传或审核路径', async () => {
  const capture = outputCapture();
  const requests = [];
  const client = new UosStoreApiClient({
    baseUrl: 'https://appstore-dev.uniontech.com',
    identityAuthenticator: async () => ({ code: 'private-code', state: 'private-state' }),
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://appstore-dev.uniontech.com');
      requests.push([options.method, url.pathname]);
      const reply = (datas, headers) => new Response(JSON.stringify({ status: 200, datas }), { headers });
      if (url.pathname === '/devprod-api/store-dev-auth/getLoginPath') {
        return reply('https://login.uniontech.com/oauth2/authorize?state=private-state');
      }
      if (url.pathname === '/devprod-api/store-dev-auth/login') {
        return reply({}, { 'set-cookie': 'access-token=private-session; Secure; HttpOnly' });
      }
      if (url.pathname === '/devprod-api/store-dev-auth/dev_info') {
        return reply({ dev_type: 1, name: 'private-developer' });
      }
      if (url.pathname === '/devprod-api/store-dev-app/app' && options.method === 'GET') {
        return reply({ total: 1, rows: [{ pkg_name: APP_ID, app_id: 'private-app', id: 'private-version' }] });
      }
      assert.fail('认证检查触发了非预期平台操作');
    },
  });

  const result = await runAuthenticationCheck({
    client,
    credentials: { username: 'private-account', password: 'private-password' },
    ...capture,
  });

  assert.equal(result, 0);
  assert.deepEqual(requests, [
    ['GET', '/devprod-api/store-dev-auth/getLoginPath'],
    ['POST', '/devprod-api/store-dev-auth/login'],
    ['GET', '/devprod-api/store-dev-auth/dev_info'],
    ['GET', '/devprod-api/store-dev-app/app'],
  ]);
  assert.deepEqual(capture.info, ['UOS authentication ready for com.floatboat.desktop']);
  assert.deepEqual(capture.errors, []);
});

test('独立 workflow 仅从受保护 main 手动运行，Secret 只注入认证步骤', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'uos-auth-check.yml'), 'utf8');
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^  (push|pull_request|workflow_call|schedule):/mu);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /environment: uos-app-store-production/u);
  assert.match(workflow, /group: uos-app-store-production\n\s+cancel-in-progress: false/u);
  assert.match(workflow, /timeout-minutes: 10/u);
  assert.match(workflow, /permissions:\n  contents: read\n/u);
  assert.equal((workflow.match(/permissions:/gu) || []).length, 1);
  assert.equal((workflow.match(/uses:/gu) || []).length, 2);
  assert.match(workflow, /uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /sparse-checkout: \.github\/scripts/u);
  assert.equal((workflow.match(/- name:/gu) || []).length, 4);
  assert.match(workflow, /pnpm\/action-setup@[0-9a-f]{40}/u);
  assert.match(workflow, /install --frozen-lockfile --ignore-scripts/u);
  assert.match(workflow, /playwright install --with-deps --only-shell chromium/u);
  assert.ok(workflow.indexOf('Install pinned UOS authentication browser') < workflow.indexOf('secrets.UOS_STORE_USERNAME'));
  const authStep = workflow.slice(workflow.indexOf('      - name: Check UOS authentication'));
  assert.match(authStep, /UOS_STORE_USERNAME: \$\{\{ secrets\.UOS_STORE_USERNAME \}\}\n\s+UOS_STORE_PASSWORD: \$\{\{ secrets\.UOS_STORE_PASSWORD \}\}/u);
  assert.match(authStep, /DEBUG: ''\n\s+PWDEBUG: ''/u);
  assert.equal((workflow.match(/secrets\./gu) || []).length, 2);
  assert.match(authStep, /node \.github\/scripts\/uos-store-auth-check\.cjs/u);
  assert.doesNotMatch(workflow, /upload-artifact|download-artifact|actions\/cache|uos-store-publisher|tee |>>|\$GITHUB_OUTPUT|\$GITHUB_ENV/u);
});
