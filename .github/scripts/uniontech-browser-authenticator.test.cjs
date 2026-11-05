#!/usr/bin/env node
// ABOUTME: 用纯内存浏览器替身验证统信网页登录的请求边界、回跳、人工分支和清理。

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  authenticateUnionTechBrowser,
  BROWSER_FAILURE_MESSAGES,
  BROWSER_SELECTORS,
} = require('./uniontech-browser-authenticator.cjs');
const { UosStoreApiClient } = require('./uos-store-api-client.cjs');
const { runAuthenticationCheck } = require('./uos-store-auth-check.cjs');

const IDENTITY = 'https://login.uniontech.com';
const STORE = 'https://appstore-dev.uniontech.com';
const LOGIN_URL = `${IDENTITY}/oauth2/authorize?client_id=mock-client&redirect_uri=${encodeURIComponent(STORE)}&response_type=code&scope=base&state=expected-state`;
const CALLBACK_URL = `${STORE}/?code=mock-oauth-code&state=expected-state`;
const PRIVATE_USER = 'private-user@example.invalid';
const PRIVATE_PASSWORD = 'private-password';
const PRIVATE_TOKEN = 'private-session-token';
const TEMP_DIRECTORY = '/dev/shm/uniontech-browser-test';

function response(status = 200, payload = {}, headers = {}) {
  return {
    status: () => status,
    headers: () => headers,
    json: async () => payload,
  };
}

function createHarness(options = {}) {
  const events = [];
  const pageHandlers = new Map();
  const contextHandlers = new Map();
  const fields = new Map();
  const frame = {};
  let routeHandler;
  let webSocketHandler;
  let currentUrl = 'about:blank';
  let followVisible = false;
  let manualVisible = Boolean(options.manualBeforeSubmit);

  const emit = async (handlers, name, value) => {
    for (const handler of handlers.get(name) || []) await handler(value);
  };
  const register = (handlers, name, handler) => {
    handlers.set(name, [...(handlers.get(name) || []), handler]);
  };

  function authorizeBody() {
    const form = new URLSearchParams(new URL(LOGIN_URL).searchParams);
    form.set('account', Buffer.alloc(256, 7).toString('base64'));
    form.set('password', Buffer.alloc(256, 8).toString('base64'));
    form.set('token', 'has');
    form.set('validate', 'random_hdh');
    form.set('user_oauth', 'o_base');
    if (options.consent) form.set('grunt', 'true');
    if (options.changeAuthorizeBody) options.changeAuthorizeBody(form);
    return form.toString();
  }

  function resolveResponse(url, request) {
    if (options.responses?.[url]) return options.responses[url];
    const target = new URL(url);
    if (target.pathname === '/assets/config/config.json') {
      return response(200, options.config || { JSEncrypt: true, NECaptcha: false });
    }
    if (target.pathname === '/api/key') return response(200, { code: 200, data: 'mock-public-key' });
    if (target.pathname === '/api/oauth2/client') {
      return response(200, { code: 200, data: { IsGrunt: Boolean(options.consent), Scopes: [1] } });
    }
    if (target.pathname === '/api/oauth2/authorize' && request.method === 'POST') {
      return response(options.authorizeStatus || 200, {
        code: 200,
        data: { redirect: options.authorizeRedirect || options.callbackUrl || CALLBACK_URL },
      }, options.authorizeHeaders || {});
    }
    if (target.pathname === '/api/oauth2/showqrcode') return response(200, { code: 200, data: {} });
    return response(200, {});
  }

  async function request(url, requestOptions = {}) {
    const description = {
      url,
      method: requestOptions.method || 'GET',
      resourceType: requestOptions.resourceType || 'xhr',
      navigation: Boolean(requestOptions.navigation),
      body: requestOptions.body || null,
    };
    let disposition;
    const route = {
      request: () => ({
        url: () => description.url,
        method: () => description.method,
        resourceType: () => description.resourceType,
        isNavigationRequest: () => description.navigation,
        frame: () => requestOptions.frame || frame,
        postData: () => description.body,
        headers: () => ({ 'content-type': requestOptions.contentType || 'application/x-www-form-urlencoded;charset=UTF-8' }),
      }),
      fetch: async (fetchOptions) => {
        const fetchUrl = fetchOptions.url || description.url;
        events.push({ kind: 'fetch', ...description, url: fetchUrl, options: fetchOptions });
        if (options.fetchFailure) throw new Error(`${PRIVATE_USER} ${PRIVATE_PASSWORD} ${PRIVATE_TOKEN}`);
        if (options.duringAuthorizeRequest && description.method === 'POST' && new URL(fetchUrl).pathname === '/api/oauth2/authorize') {
          await request(options.duringAuthorizeRequest.url, options.duringAuthorizeRequest);
        }
        return resolveResponse(fetchUrl, description);
      },
      fulfill: async () => {
        disposition = 'fulfilled';
        events.push({ kind: 'fulfill', ...description });
      },
      abort: async () => {
        disposition = 'aborted';
        events.push({ kind: 'abort', ...description });
      },
    };
    events.push({ kind: 'request', ...description });
    await routeHandler(route);
    if (description.navigation && disposition === 'fulfilled') {
      currentUrl = url;
      await emit(pageHandlers, 'framenavigated', frame);
    }
    return disposition;
  }

  async function callback() {
    return request(options.callbackUrl || CALLBACK_URL, { navigation: true, resourceType: 'document' });
  }

  async function submit() {
    if (options.beforeAuthorizeRequest) {
      await request(options.beforeAuthorizeRequest.url, options.beforeAuthorizeRequest);
      return;
    }
    const disposition = await request(`${IDENTITY}/api/oauth2/authorize`, { method: 'POST', body: authorizeBody() });
    if (options.duplicateAuthorize) {
      await request(`${IDENTITY}/api/oauth2/authorize`, { method: 'POST', body: authorizeBody() });
      return;
    }
    if (disposition !== 'fulfilled' || (options.authorizeStatus && options.authorizeStatus !== 200)) return;
    if (options.manualAfterAuthorize) {
      manualVisible = true;
      currentUrl = `${IDENTITY}/oauth2/bind/phone`;
      await emit(pageHandlers, 'framenavigated', frame);
      return;
    }
    if (options.afterAuthorizeRequest) {
      await request(options.afterAuthorizeRequest.url, options.afterAuthorizeRequest);
      if (!options.continueAfterAuthorizeRequest) return;
    }
    if (options.noCallback) return;
    if (options.follow) {
      followVisible = true;
      currentUrl = `${IDENTITY}/oauth2/follow`;
      await emit(pageHandlers, 'framenavigated', frame);
      return;
    }
    await callback();
  }

  const page = {
    on: (name, handler) => register(pageHandlers, name, handler),
    mainFrame: () => frame,
    url: () => currentUrl,
    setDefaultTimeout: (timeout) => events.push({ kind: 'default-timeout', timeout }),
    close: async () => events.push({ kind: 'page-close' }),
    locator: (selector) => {
      const visible = () => {
        if ([BROWSER_SELECTORS.username, BROWSER_SELECTORS.password, BROWSER_SELECTORS.submit].includes(selector)) return true;
        if (selector === BROWSER_SELECTORS.follow) return followVisible;
        if (selector === 'app-login-web .explain') return Boolean(options.consent);
        return manualVisible && BROWSER_SELECTORS.manual.includes(selector);
      };
      const locator = {
        first: () => locator,
        count: async () => visible() ? 1 : 0,
        isVisible: async () => visible(),
        innerText: async () => options.followLabel || '我已了解，立即登录',
        fill: async (value) => {
          fields.set(selector, value);
          events.push({ kind: 'fill', selector });
        },
        click: async () => {
          events.push({ kind: 'click', selector });
          if (selector === BROWSER_SELECTORS.submit) await submit();
          if (selector === BROWSER_SELECTORS.follow) {
            followVisible = false;
            await request(`${IDENTITY}/api/oauth2/showqrcode`, {
              method: 'POST',
              body: JSON.stringify({ showQrcode: 0 }),
              contentType: 'application/json',
            });
            await callback();
          }
        },
      };
      return locator;
    },
    goto: async (url) => {
      events.push({ kind: 'goto', url });
      currentUrl = url;
      await request(url, { navigation: true, resourceType: 'document' });
      await request(`${IDENTITY}/assets/config/config.json`);
      await request(`${IDENTITY}/api/key`);
      await request(`${IDENTITY}/api/oauth2/client`, {
        method: 'POST', body: new URLSearchParams(new URL(LOGIN_URL).searchParams).toString(),
      });
      if (options.beforeSubmitRequest) await request(options.beforeSubmitRequest.url, options.beforeSubmitRequest);
      if (options.webSocket) {
        await webSocketHandler({
          close: async () => events.push({ kind: 'websocket-close' }),
          connectToServer: () => { events.push({ kind: 'websocket-connect' }); throw new Error('unexpected websocket'); },
        });
      }
      if (options.pageEvent) await emit(pageHandlers, options.pageEvent, { cancel: async () => {}, dismiss: async () => {} });
      if (options.popup) await emit(contextHandlers, 'page', { close: async () => events.push({ kind: 'popup-close' }) });
    },
  };
  const context = {
    on: (name, handler) => register(contextHandlers, name, handler),
    route: async (pattern, handler) => { events.push({ kind: 'route', pattern }); routeHandler = handler; },
    routeWebSocket: async (pattern, handler) => { events.push({ kind: 'websocket-route', pattern }); webSocketHandler = handler; },
    newPage: async () => { events.push({ kind: 'new-page' }); await emit(contextHandlers, 'page', page); return page; },
    close: async () => events.push({ kind: 'context-close' }),
  };
  const browser = {
    newContext: async (contextOptions) => { events.push({ kind: 'new-context', options: contextOptions }); return context; },
    close: async () => events.push({ kind: 'browser-close' }),
  };
  const fs = {
    lstat: async (path) => { events.push({ kind: 'lstat', path }); return { isDirectory: () => true, isSymbolicLink: () => false }; },
    statfs: async (path) => { events.push({ kind: 'statfs', path }); return { type: options.fsType ?? 0x01021994 }; },
    mkdtemp: async (prefix) => { events.push({ kind: 'mkdtemp', prefix }); return TEMP_DIRECTORY; },
    chmod: async (path, mode) => events.push({ kind: 'chmod', path, mode }),
    rm: async (path, rmOptions) => {
      events.push({ kind: 'rm', path, options: rmOptions });
      if (options.cleanupFailure) throw new Error(`${PRIVATE_PASSWORD} ${PRIVATE_TOKEN}`);
    },
  };
  const chromium = {
    launch: async (launchOptions) => {
      events.push({ kind: 'launch', options: launchOptions, tmpdir: process.env.TMPDIR });
      if (options.launchFailure) throw new Error(`${PRIVATE_USER} ${PRIVATE_PASSWORD} ${PRIVATE_TOKEN}`);
      return browser;
    },
  };
  const run = () => authenticateUnionTechBrowser({
    loginUrl: options.loginUrl || LOGIN_URL,
    username: PRIVATE_USER,
    password: PRIVATE_PASSWORD,
    chromium,
    runtime: { platform: options.platform || 'linux', env: { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', ...(options.env || {}) }, fs },
    timeoutMs: options.timeoutMs || 500,
  });
  return { events, fields, run };
}

function assertSafeError(error, expectedCode) {
  assert.equal(error.name, 'UnionTechIdentityError');
  if (expectedCode) assert.equal(error.code, expectedCode);
  assert.match(error.code, /^UOS_/u);
  assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, /private-user|private-password|private-session-token|private-callback-secret/u);
  return true;
}

function assertCleaned(events, launched = true) {
  assert.ok(events.some((event) => event.kind === 'rm' && event.path === TEMP_DIRECTORY));
  if (launched) {
    const contextClose = events.findIndex((event) => event.kind === 'context-close');
    const browserClose = events.findIndex((event) => event.kind === 'browser-close');
    const remove = events.findIndex((event) => event.kind === 'rm');
    assert.ok(contextClose >= 0 && browserClose > contextClose && remove > browserClose);
  }
}

test('网页登录先完成初始化，再填表提交；仅提取商店回跳，最后关闭浏览器并清理内存目录', async () => {
  const harness = createHarness();
  assert.deepEqual(await harness.run(), { code: 'mock-oauth-code', state: 'expected-state' });
  assert.equal(harness.fields.get(BROWSER_SELECTORS.username), PRIVATE_USER);
  assert.equal(harness.fields.get(BROWSER_SELECTORS.password), PRIVATE_PASSWORD);
  const fetched = harness.events.filter((event) => event.kind === 'fetch');
  assert.deepEqual(fetched.map((event) => new URL(event.url).pathname), [
    '/oauth2/authorize', '/assets/config/config.json', '/api/key', '/api/oauth2/client', '/api/oauth2/authorize',
  ]);
  assert.ok(fetched.every((event) => event.options.maxRedirects === 0 && event.options.maxRetries === 0));
  assert.ok(harness.events.findIndex((event) => event.kind === 'fill') > harness.events.findIndex((event) => event.kind === 'fetch' && event.url.endsWith('/api/oauth2/client')));
  assert.ok(harness.events.some((event) => event.kind === 'abort' && event.url === CALLBACK_URL));
  assert.equal(harness.events.filter((event) => event.kind === 'click' && event.selector === BROWSER_SELECTORS.submit).length, 1);
  const contextOptions = harness.events.find((event) => event.kind === 'new-context').options;
  assert.equal(contextOptions.acceptDownloads, false);
  assert.equal(contextOptions.serviceWorkers, 'block');
  assertCleaned(harness.events);
});

test('HTTP 商店根回跳仍只在内存解析，不发起 HTTP 请求', async () => {
  const harness = createHarness({ callbackUrl: CALLBACK_URL.replace('https:', 'http:') });
  assert.deepEqual(await harness.run(), { code: 'mock-oauth-code', state: 'expected-state' });
  assert.ok(harness.events.filter((event) => event.kind === 'fetch').every((event) => event.url.startsWith(`${IDENTITY}/`)));
  assertCleaned(harness.events);
});

test('未知目标与提交前商店回跳均被拦截且不会填入凭据', async () => {
  for (const url of ['https://untrusted.invalid/?token=private-callback-secret', CALLBACK_URL]) {
    const harness = createHarness({ beforeSubmitRequest: { url, navigation: true, resourceType: 'document' } });
    await assert.rejects(harness.run, (error) => assertSafeError(error));
    assert.equal(harness.events.some((event) => event.kind === 'fetch' && event.url === url), false);
    assert.equal(harness.events.some((event) => event.kind === 'fill'), false);
    assertCleaned(harness.events);
  }
});

test('密码请求最多转发一次，重复请求在联网前拒绝', async () => {
  const harness = createHarness({ duplicateAuthorize: true });
  await assert.rejects(harness.run, (error) => assertSafeError(error));
  assert.equal(harness.events.filter((event) => event.kind === 'fetch' && event.method === 'POST' && event.url.endsWith('/api/oauth2/authorize')).length, 1);
  assert.equal(harness.events.filter((event) => event.kind === 'abort' && event.method === 'POST' && event.url.endsWith('/api/oauth2/authorize')).length, 1);
  assertCleaned(harness.events);
});

test('密码请求的 302、307、308 均不跟随或重放', async () => {
  for (const status of [302, 307, 308]) {
    const redirect = `${IDENTITY}/private-replay?token=private-callback-secret`;
    const harness = createHarness({ authorizeStatus: status, authorizeHeaders: { location: redirect } });
    await assert.rejects(harness.run, (error) => assertSafeError(error));
    const passwordRequests = harness.events.filter((event) => event.kind === 'fetch' && event.method === 'POST' && event.url.endsWith('/api/oauth2/authorize'));
    assert.equal(passwordRequests.length, 1);
    assert.equal(passwordRequests[0].options.maxRedirects, 0);
    assert.equal(harness.events.some((event) => event.kind === 'fetch' && event.url === redirect), false);
    assertCleaned(harness.events);
  }
});

test('验证码、授权和账户绑定流程要求人工处理', async () => {
  for (const options of [{ config: { JSEncrypt: true, NECaptcha: true } }, { consent: true, manualBeforeSubmit: true }, { manualBeforeSubmit: true }, { manualAfterAuthorize: true }]) {
    const harness = createHarness(options);
    await assert.rejects(harness.run, (error) => assertSafeError(error, 'UOS_AUTH_INTERACTION_REQUIRED'));
    if (!options.manualAfterAuthorize) assert.equal(harness.events.some((event) => event.kind === 'fill'), false);
    assertCleaned(harness.events);
  }
});

test('follow 宣传提示只点击一次，随后精确提交关闭提示请求并拦截最终回跳', async () => {
  const harness = createHarness({ follow: true, followLabel: ' 我已了解，立即登录 ' });
  assert.deepEqual(await harness.run(), { code: 'mock-oauth-code', state: 'expected-state' });
  assert.equal(harness.events.filter((event) => event.kind === 'click' && event.selector === BROWSER_SELECTORS.follow).length, 1);
  const dismiss = harness.events.filter((event) => event.kind === 'fetch' && event.url.endsWith('/api/oauth2/showqrcode'));
  assert.equal(dismiss.length, 1);
  assert.equal(dismiss[0].method, 'POST');
  assert.deepEqual(JSON.parse(dismiss[0].body), { showQrcode: 0 });
  assertCleaned(harness.events);
});

test('相同 follow 选择器但不同文案不能自动点击', async () => {
  const harness = createHarness({ follow: true, followLabel: '同意新增授权', timeoutMs: 100 });
  await assert.rejects(harness.run, (error) => assertSafeError(error));
  assert.equal(harness.events.some((event) => event.kind === 'click' && event.selector === BROWSER_SELECTORS.follow), false);
  assertCleaned(harness.events);
});

test('请求异常与浏览器启动异常只返回静态错误并清理目录', async () => {
  for (const options of [{ fetchFailure: true }, { launchFailure: true }]) {
    const harness = createHarness(options);
    await assert.rejects(harness.run, (error) => {
      assertSafeError(error);
      assert.ok(BROWSER_FAILURE_MESSAGES.includes(error.message.slice(error.message.indexOf(': ') + 2)));
      return true;
    });
    assertCleaned(harness.events, !options.launchFailure);
  }
});

test('只允许 Linux Actions 与 tmpfs；预检失败时不启动浏览器', async () => {
  for (const options of [{ platform: 'darwin' }, { fsType: 0xEF53 }]) {
    const harness = createHarness(options);
    await assert.rejects(harness.run, (error) => assertSafeError(error));
    assert.equal(harness.events.some((event) => event.kind === 'launch'), false);
    assert.equal(harness.events.some((event) => event.kind === 'fill'), false);
  }
});

test('下载、弹窗和对话框均中止流程，WebSocket 不连接外网', async () => {
  for (const options of [{ pageEvent: 'download' }, { pageEvent: 'dialog' }, { pageEvent: 'crash' }, { popup: true }, { webSocket: true }]) {
    const harness = createHarness(options);
    await assert.rejects(harness.run, (error) => assertSafeError(error));
    assert.equal(harness.events.some((event) => event.kind === 'websocket-connect'), false);
    assert.equal(harness.events.some((event) => event.kind === 'fill'), false);
    assertCleaned(harness.events);
  }
});

test('密码提交的 OAuth 字段、固定参数或密文被篡改时零次转发', async () => {
  for (const changeAuthorizeBody of [
    (form) => form.set('state', 'unexpected-state'),
    (form) => form.append('password', 'second-value'),
    (form) => form.set('account', PRIVATE_USER),
    (form) => form.set('password', PRIVATE_PASSWORD),
    (form) => form.set('validate', 'unexpected-validate'),
    (form) => form.set('user_oauth', 'o_base,o_phone'),
    (form) => form.set('unknown_field', 'private-callback-secret'),
  ]) {
    const harness = createHarness({ changeAuthorizeBody });
    await assert.rejects(harness.run, (error) => assertSafeError(error));
    assert.equal(harness.events.some((event) => event.kind === 'fetch' && event.method === 'POST' && event.url.endsWith('/api/oauth2/authorize')), false);
    assertCleaned(harness.events);
  }
});

test('GET 仅可有限次跟随 Identity 同源重定向，跨域目标零次转发', async () => {
  const bootstrap = `${IDENTITY}/browser-bootstrap`;
  const success = createHarness({ responses: { [LOGIN_URL]: response(302, {}, { location: bootstrap }) } });
  assert.deepEqual(await success.run(), { code: 'mock-oauth-code', state: 'expected-state' });
  assert.ok(success.events.some((event) => event.kind === 'fetch' && event.url === bootstrap));
  assertCleaned(success.events);

  const foreignUrl = 'https://untrusted.invalid/?token=private-callback-secret';
  const foreign = createHarness({ responses: { [LOGIN_URL]: response(302, {}, { location: foreignUrl }) } });
  await assert.rejects(foreign.run, (error) => assertSafeError(error));
  assert.equal(foreign.events.some((event) => event.kind === 'fetch' && event.url === foreignUrl), false);
  assertCleaned(foreign.events);

  const looping = createHarness({ responses: { [LOGIN_URL]: response(302, {}, { location: LOGIN_URL }) } });
  await assert.rejects(looping.run, (error) => assertSafeError(error));
  assert.equal(looping.events.filter((event) => event.kind === 'fetch' && event.url === LOGIN_URL).length, 6);
  assertCleaned(looping.events);
});

test('获准的 CDN 只承载图片，不能作为脚本或提交目标', async () => {
  const url = 'https://cdn-nu-common.uniontech.com/logo/code/uniontech.jpg';
  const image = createHarness({ beforeSubmitRequest: { url, resourceType: 'image' } });
  assert.deepEqual(await image.run(), { code: 'mock-oauth-code', state: 'expected-state' });
  assert.ok(image.events.some((event) => event.kind === 'fetch' && event.url === url));
  assertCleaned(image.events);

  for (const request of [{ url, resourceType: 'script' }, { url, method: 'POST', body: 'value=private-callback-secret', resourceType: 'image' }]) {
    const harness = createHarness({ beforeSubmitRequest: request });
    await assert.rejects(harness.run, (error) => assertSafeError(error));
    assert.equal(harness.events.some((event) => event.kind === 'fetch' && event.url === url), false);
    assertCleaned(harness.events);
  }
});

test('登录前后的未知图片和字体仅阻止加载，不终止会话，也不联网转发', async () => {
  for (const trigger of ['beforeSubmitRequest', 'afterAuthorizeRequest']) {
    for (const resourceType of ['image', 'font']) {
      for (const method of ['GET', 'HEAD']) {
        const url = `${trigger === 'beforeSubmitRequest' ? 'https' : 'http'}://untrusted.invalid/asset?token=${PRIVATE_TOKEN}`;
        const harness = createHarness({
          [trigger]: { url, resourceType, method },
          continueAfterAuthorizeRequest: true,
        });
        assert.deepEqual(await harness.run(), { code: 'mock-oauth-code', state: 'expected-state' });
        assert.equal(harness.events.some((event) => event.kind === 'fetch' && event.url === url), false);
        assert.ok(harness.events.some((event) => event.kind === 'abort' && event.url === url));
        assertCleaned(harness.events);
      }
    }
  }
});

test('外部 document、script、xhr、fetch 以及伪装为图片的 POST 仍终止登录', async () => {
  for (const request of [
    { resourceType: 'document', navigation: true },
    { resourceType: 'script' },
    { resourceType: 'xhr' },
    { resourceType: 'fetch' },
    { resourceType: 'stylesheet' },
    { resourceType: 'media' },
    { resourceType: 'image', method: 'POST' },
    { resourceType: 'font', method: 'POST' },
    { resourceType: 'image', navigation: true },
  ]) {
    const url = 'http://untrusted.invalid/private-path?token=private-callback-secret';
    const harness = createHarness({ afterAuthorizeRequest: { url, ...request }, continueAfterAuthorizeRequest: true });
    await assert.rejects(harness.run, (error) => assertSafeError(error, 'UOS_AUTH_CONTRACT_UNVERIFIED'));
    assert.equal(harness.events.some((event) => event.kind === 'fetch' && event.url === url), false);
    assertCleaned(harness.events);
  }
});

test('图片重定向到外部或商店仅阻止加载，资源请求不能完成认证', async () => {
  const imageUrl = `${IDENTITY}/assets/qrcode.png`;
  for (const target of ['http://untrusted.invalid/qrcode.png', CALLBACK_URL]) {
    const harness = createHarness({
      beforeSubmitRequest: { url: imageUrl, resourceType: 'image' },
      responses: { [imageUrl]: response(302, {}, { location: target }) },
    });
    assert.deepEqual(await harness.run(), { code: 'mock-oauth-code', state: 'expected-state' });
    assert.equal(harness.events.some((event) => event.kind === 'fetch' && event.url === target), false);
    assert.ok(harness.events.some((event) => event.kind === 'fill'));
    assertCleaned(harness.events);
  }
});

test('登录后回跳仍必须满足固定根路径、无用户信息和 fragment、唯一且一致的 state', async () => {
  for (const callbackUrl of [
    `${STORE}/other?code=mock-oauth-code&state=expected-state`,
    `${STORE}/?code=mock-oauth-code&state=wrong-state`,
    `${STORE}/?code=mock-oauth-code&state=expected-state&state=duplicate`,
    `${STORE}/?code=mock-oauth-code&state=expected-state#private-callback-secret`,
    'https://user:private-callback-secret@appstore-dev.uniontech.com/?code=mock-oauth-code&state=expected-state',
    'http://appstore-dev.uniontech.com:443/?code=mock-oauth-code&state=expected-state',
  ]) {
    const harness = createHarness({ callbackUrl });
    await assert.rejects(harness.run, (error) => assertSafeError(error));
    assert.equal(harness.events.some((event) => event.kind === 'fetch' && event.url === callbackUrl), false);
    assertCleaned(harness.events);
  }
});

test('超时和清理失败不会返回成功或遗留未经包装的错误', async () => {
  const timedOut = createHarness({ noCallback: true, timeoutMs: 100 });
  await assert.rejects(timedOut.run, (error) => assertSafeError(error, 'UOS_AUTH_FAILED'));
  assertCleaned(timedOut.events);
  const cleanup = createHarness({ cleanupFailure: true });
  await assert.rejects(cleanup.run, (error) => assertSafeError(error, 'UOS_AUTH_FAILED'));
  assertCleaned(cleanup.events);
});

test('Chromium 只获得允许的环境字段，临时目录覆盖在启动后恢复', async () => {
  const originalTmpdir = process.env.TMPDIR;
  const harness = createHarness({ env: { PATH: '/mock/bin', PRIVATE_CI_SECRET: PRIVATE_TOKEN } });
  assert.deepEqual(await harness.run(), { code: 'mock-oauth-code', state: 'expected-state' });
  const launch = harness.events.find((event) => event.kind === 'launch');
  assert.equal(launch.tmpdir, TEMP_DIRECTORY);
  assert.equal(launch.options.env.TMPDIR, TEMP_DIRECTORY);
  assert.equal(launch.options.env.PATH, '/mock/bin');
  assert.equal(launch.options.chromiumSandbox, true);
  assert.equal(launch.options.env.PRIVATE_CI_SECRET, undefined);
  assert.equal(process.env.TMPDIR, originalTmpdir);
  assertCleaned(harness.events);
});

test('IsGrunt 和授权说明不替代独立人工按钮，普通密码表单仅提交基础权限', async () => {
  const harness = createHarness({ consent: true });
  assert.deepEqual(await harness.run(), { code: 'mock-oauth-code', state: 'expected-state' });
  const submitted = harness.events.find((event) => event.kind === 'fetch' && event.method === 'POST' && event.url.endsWith('/api/oauth2/authorize'));
  const form = new URLSearchParams(submitted.body);
  assert.equal(form.get('grunt'), 'true');
  assert.equal(form.get('user_oauth'), 'o_base');
  assert.equal(BROWSER_SELECTORS.manual.includes('app-login-web .explain'), false);
  assertCleaned(harness.events);
});

test('DEBUG 与 PWDEBUG 在运行参数或父进程中启用时，填表前拒绝启动', async () => {
  for (const name of ['DEBUG', 'PWDEBUG']) {
    const runtimeDebug = createHarness({ env: { [name]: '1' } });
    await assert.rejects(runtimeDebug.run, (error) => assertSafeError(error));
    assert.equal(runtimeDebug.events.some((event) => event.kind === 'launch'), false);
    const original = process.env[name];
    try {
      process.env[name] = '1';
      const processDebug = createHarness();
      await assert.rejects(processDebug.run, (error) => assertSafeError(error));
      assert.equal(processDebug.events.some((event) => event.kind === 'launch'), false);
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  }
});

test('其他已知 API 的 POST 请求不能夹带字段或变更原 OAuth 参数', async () => {
  for (const [pathname, body] of [
    ['/api/agreement', JSON.stringify({ password: PRIVATE_PASSWORD })],
    ['/api/oauth2/authorize/registerlogin', 'token=private-callback-secret'],
    ['/api/oauth2/client', 'state=wrong-state'],
    ['/api/islogin', 'state=expected-state&password=private-password'],
    ['/api/oauth2/checkoauth', 'unknown=private-callback-secret'],
    ['/api/oauth2/showqrcode', JSON.stringify({ showQrcode: 0, extra: true })],
  ]) {
    const url = `${IDENTITY}${pathname}`;
    const harness = createHarness({ beforeSubmitRequest: { url, method: 'POST', body } });
    await assert.rejects(harness.run, (error) => assertSafeError(error));
    assert.equal(harness.events.some((event) => event.kind === 'fetch' && event.url === url && event.body === body), false);
    assert.equal(harness.events.some((event) => event.kind === 'fill'), false);
    assertCleaned(harness.events);
  }
});

test('拒绝请求的三个登录阶段及固定分类经过真实 API 日志仍不包含 URL 或敏感字段', async () => {
  const cases = [
    {
      trigger: 'beforeSubmitRequest',
      url: 'https://account.uniontech.com/private-path?code=private-callback-secret&state=private-state',
      reason: '统信浏览器在提交登录表单前阻止了未受信请求',
      originClass: 'account_https', protocolClass: 'https', hasUserinfo: false, hasFragment: false,
    },
    {
      trigger: 'beforeAuthorizeRequest',
      url: 'https://account.uniontech.com/private-path?token=private-callback-secret',
      reason: '统信浏览器在提交登录表单前阻止了未受信请求',
      originClass: 'account_https', protocolClass: 'https', hasUserinfo: false, hasFragment: false,
    },
    {
      trigger: 'duringAuthorizeRequest',
      url: 'http://identity.chinauos.com/private-path?token=private-callback-secret',
      reason: '统信浏览器在提交口令后阻止了未受信请求',
      originClass: 'identity_center_http', protocolClass: 'http', hasUserinfo: false, hasFragment: false,
    },
    {
      trigger: 'afterAuthorizeRequest',
      url: 'https://private-user:private-password@cdn-nu-common.uniontech.com/private-path?token=private-callback-secret#private-fragment',
      reason: '统信浏览器在登录响应成功后阻止了未受信请求',
      originClass: 'static_cdn_https', protocolClass: 'https', hasUserinfo: true, hasFragment: true,
    },
  ];
  for (const entry of cases) {
    const kind = entry.trigger === 'afterAuthorizeRequest' ? { resourceType: 'document', navigation: true } :
      entry.trigger === 'duringAuthorizeRequest' ? { resourceType: 'fetch' } : { resourceType: 'script' };
    const label = kind.navigation ? '页面跳转' : kind.resourceType === 'script' ? '脚本' : '接口请求';
    const harness = createHarness({ [entry.trigger]: { url: entry.url, ...kind } });
    const apiRequests = [];
    const client = new UosStoreApiClient({
      baseUrl: STORE,
      identityAuthenticator: harness.run,
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        apiRequests.push({ path: url.pathname, method: init.method });
        assert.equal(url.pathname, '/devprod-api/store-dev-auth/getLoginPath');
        assert.equal(init.method, 'GET');
        return new Response(JSON.stringify({ status: 200, datas: LOGIN_URL }));
      },
    });
    const logs = [];
    const errors = [];
    const exitCode = await runAuthenticationCheck({
      client,
      credentials: { username: PRIVATE_USER, password: PRIVATE_PASSWORD },
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(logs, []);
    assert.equal(errors.length, 1);
    const diagnostic = JSON.parse(errors[0].slice('UOS authentication check failed: '.length));
    assert.deepEqual(diagnostic, {
      code: 'UOS_AUTH_CONTRACT_UNVERIFIED',
      reason: `${entry.reason}（${label}）`,
      callbackShape: {
        originClass: entry.originClass,
        protocolClass: entry.protocolClass,
        portClass: 'default',
        pathClass: 'other',
        hasUserinfo: entry.hasUserinfo,
        hasFragment: entry.hasFragment,
      },
      ...(kind.navigation ? { navigationDiagnostic: {
        requestHost: 'cdn-nu-common.uniontech.com', source: 'authorize', format: 'absolute',
        sourceHost: 'appstore-dev.uniontech.com', followHost: 'appstore-dev.uniontech.com',
        relation: 'different', hasAutoLoginKey: false,
      } } : {}),
    });
    assert.doesNotMatch(errors[0], /https?:|private-|token=|code=|state=/u);
    assert.equal(apiRequests.length, 1);
    assert.equal(harness.events.some((event) => event.kind === 'fetch' && event.url === entry.url), false);
    assertCleaned(harness.events);
  }
});

test('官网将根相对地址拼成伪主机时，API 日志只给出固定导航证据并保留阻断', async () => {
  const raw = '/api/oauth2/authorize/step?code=private-callback-secret&state=private-state';
  const target = `http:${raw}`;
  const harness = createHarness({ authorizeRedirect: raw, afterAuthorizeRequest: { url: target, resourceType: 'document', navigation: true } });
  const client = new UosStoreApiClient({
    baseUrl: STORE, identityAuthenticator: harness.run,
    fetchImpl: async () => new Response(JSON.stringify({ status: 200, datas: LOGIN_URL })),
  });
  const errors = [];
  const result = await runAuthenticationCheck({
    client, credentials: { username: PRIVATE_USER, password: PRIVATE_PASSWORD },
    log: () => assert.fail('未知目标不能认证成功'), error: (line) => errors.push(line),
  });
  assert.equal(result, 1);
  const diagnostic = JSON.parse(errors[0].slice('UOS authentication check failed: '.length));
  assert.deepEqual(diagnostic.navigationDiagnostic, {
    requestHost: 'api', source: 'authorize', format: 'root', sourceHost: 'login.uniontech.com',
    followHost: 'api', relation: 'official_follow_exact', hasAutoLoginKey: false,
  });
  assert.doesNotMatch(errors[0], /private-|https?:|[?&]|\/oauth2/u);
  assert.equal(harness.events.some((event) => event.kind === 'fetch' && event.url === target), false);
  assertCleaned(harness.events);
});
