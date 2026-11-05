#!/usr/bin/env node
// ABOUTME: 让真实 Chromium 只访问本机假页面，验收统信登录的 DOM、跳转拦截和商店 API 衔接。

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { authenticateUnionTechBrowser } = require('./uniontech-browser-authenticator.cjs');
const { UosStoreApiClient, UosStoreApiError, describeUosAuthenticationFailure } = require('./uos-store-api-client.cjs');
const { runAuthenticationCheck } = require('./uos-store-auth-check.cjs');

const integration = process.env.UOS_BROWSER_OFFLINE_TEST === 'true' ? test : test.skip;
const IDENTITY = 'https://login.uniontech.com';
const STORE = 'https://appstore-dev.uniontech.com';
const USERNAME = 'offline-user@example.test';
const PASSWORD = 'offline-only-password';
const STATE = 'offline-state';
const CALLBACK = `${STORE}/?code=offline-code&state=${STATE}`;
const LOGIN = `${IDENTITY}/oauth2/authorize?client_id=offline-client&redirect_uri=${encodeURIComponent(STORE)}&response_type=code&scope=base&state=${STATE}`;
const UNTRUSTED_QR_CODE = 'http://untrusted.invalid/qr.png';

function loginPage(mode) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
    <app-login-web><form class="login-form">
      <input formcontrolname="userName" autocomplete="off">
      <input formcontrolname="password" type="password" autocomplete="off">
      <button class="login-form-button login-form-margin" type="submit">登录</button>
    </form></app-login-web>
    <script>
      const mode = ${JSON.stringify(mode)};
      const oauth = new URLSearchParams(location.search);
      const ready = Promise.all([
        fetch('/assets/config/config.json').then(r => r.json()),
        fetch('/api/key').then(r => r.json()),
        fetch('/api/oauth2/client', {method:'POST',body:oauth}).then(r => r.json())
      ]);
      document.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault();
        await ready;
        const form = new URLSearchParams(oauth);
        // 假密文保留填表结果供本机断言；这里不模拟或声称验证官方 RSA 实现。
        form.set('account', btoa(document.querySelector('[formcontrolname="userName"]').value + ':' + 'x'.repeat(128)));
        form.set('password', btoa(document.querySelector('[formcontrolname="password"]').value + ':' + 'x'.repeat(128)));
        form.set('token', 'has'); form.set('validate', 'random_hdh'); form.set('user_oauth', 'o_base');
        const send = () => fetch('/api/oauth2/authorize', {method:'POST',body:form}).then(r => r.json());
        try {
          const authorized = await send();
          if (mode === 'repeat-password') { await send(); return; }
          if (mode === 'unknown-host') { location.assign('https://untrusted.invalid/collect'); return; }
          const intermediate = await fetch('/api/oauth2/authorize/registerlogin', {
            method:'POST',headers:{'content-type':'application/json'},body:'{}'
          }).then(r => r.json());
          location.assign(intermediate.data.redirect || authorized.data.redirect);
        } catch {}
      });
    </script></body></html>`;
}

function followPage(mode) {
  const label = mode === 'consent-button' ? '授权并登录' : '我已了解，立即登录';
  const dynamicQrCode = ['untrusted-image', 'untrusted-http-document'].includes(mode);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
    <app-follow><h1>欢迎加入统信官方社群</h1><p>获取使用手册与社群服务</p>
      <button class="know"${dynamicQrCode ? ' hidden' : ''}>${label}</button>
    </app-follow><script>
      const mode = ${JSON.stringify(mode)};
      if (${JSON.stringify(dynamicQrCode)}) {
        fetch('/api/oauth2/qrcodeconfig').then(response => response.json()).then(response => {
          if (mode === 'untrusted-http-document') { location.assign(response.data.url); return; }
          const image = new Image();
          // 等待图片请求结束再开放按钮，确保认证成功不能掩盖遗漏的资源拦截。
          image.onload = image.onerror = () => { document.querySelector('button.know').hidden = false; };
          image.src = response.data.url;
          document.querySelector('app-follow').appendChild(image);
        });
      }
      document.querySelector('button.know').addEventListener('click', async () => {
        try {
          const response = await fetch('/api/oauth2/showqrcode', {
            method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({showQrcode:0})
          }).then(r => r.json());
          location.assign(response.data.redirect);
        } catch {}
      });
    </script></body></html>`;
}

async function createOfflineHarness(context, mode = 'success') {
  const forwarded = [];
  const requested = [];
  const aborted = [];
  const requests = [];
  const unexpectedProxyRequests = [];
  const temporaryDirectories = [];
  const browserEnvironments = [];
  const browserErrors = [];
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'uos-browser-offline-'));
  context.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const server = http.createServer(async (request, response) => {
    if (!request.url.startsWith('/identity/')) {
      unexpectedProxyRequests.push(request.url);
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url.slice('/identity'.length), IDENTITY);
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = Buffer.concat(parts).toString('utf8');
    requests.push({ method: request.method, path: url.pathname, body });
    const json = (data) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    const html = (body) => {
      response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
      response.end(body);
    };
    if (url.pathname === '/oauth2/authorize' && request.method === 'GET') return html(loginPage(mode));
    if (url.pathname === '/assets/config/config.json') return json({ JSEncrypt: true, NECaptcha: mode === 'captcha' });
    if (url.pathname === '/api/key') return json({ code: 200, data: 'offline-public-key' });
    if (url.pathname === '/api/oauth2/client') return json({ code: 200, data: {} });
    if (url.pathname === '/api/oauth2/authorize' && request.method === 'POST') {
      if (mode === 'redirect-307' || mode === 'redirect-308') {
        response.writeHead(mode === 'redirect-307' ? 307 : 308, { location: 'https://untrusted.invalid/collect-password' }).end();
        return;
      }
      return json({ code: 200, data: { redirect: `${IDENTITY}/oauth2/follow` } });
    }
    if (url.pathname === '/api/oauth2/authorize/registerlogin') {
      return json({ code: 200, data: { redirect: `${IDENTITY}/oauth2/${mode === 'redirected-path' ? 'transit' : 'follow'}` } });
    }
    if (url.pathname === '/oauth2/transit') {
      response.writeHead(302, { location: `${IDENTITY}/oauth2/follow` }).end();
      return;
    }
    if (url.pathname === '/oauth2/follow') {
      if (mode === 'redirected-path') {
        return html(`<!doctype html><html><body><script>
          if (location.pathname === '/oauth2/follow') location.assign(${JSON.stringify(CALLBACK)});
        </script></body></html>`);
      }
      return html(followPage(mode));
    }
    if (url.pathname === '/api/oauth2/qrcodeconfig') {
      return json({ code: 200, data: { switch: true, url: UNTRUSTED_QR_CODE } });
    }
    if (url.pathname === '/api/oauth2/showqrcode') {
      if (mode === 'slow-follow') await new Promise((resolve) => setTimeout(resolve, 200));
      return json({ code: 200, data: { redirect: CALLBACK } });
    }
    if (url.pathname === '/favicon.ico') return response.writeHead(204).end();
    response.writeHead(404).end();
  });
  // Chromium 的背景流量即使绕过页面路由，也只能到此本机代理，不能建立外部隧道。
  server.on('connect', (request, socket) => {
    unexpectedProxyRequests.push(request.url);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const loopback = `http://127.0.0.1:${server.address().port}`;
  const playwright = require('./uos-browser-runtime/node_modules/playwright');
  const chromium = {
    async launch(options) {
      browserEnvironments.push(options.env);
      const browser = await playwright.chromium.launch({
        ...options,
        // 仅此离线场景关闭图片自动升级，确保拦截器实际收到待验证的 HTTP 请求。
        args: mode === 'untrusted-image' ? [...options.args, '--disable-features=AutoupgradeMixedContent'] : options.args,
        proxy: { server: loopback, bypass: '127.0.0.1,localhost' },
      });
      return new Proxy(browser, {
        get(target, property) {
          if (property !== 'newContext') {
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (options) => {
            const browserContext = await target.newContext(options);
            return new Proxy(browserContext, {
              get(target, property) {
                if (property === 'newPage') return async () => {
                  const page = await target.newPage();
                  const wrapLocator = (locator) => new Proxy(locator, {
                    get(target, property) {
                      const value = target[property];
                      if (typeof value !== 'function') return value;
                      return (...args) => {
                        const result = value.apply(target, args);
                        if (property === 'first') return wrapLocator(result);
                        if (result && typeof result.catch === 'function') return result.catch((error) => {
                          browserErrors.push(`${String(property)}: ${error.message}`);
                          throw error;
                        });
                        return result;
                      };
                    },
                  });
                  return new Proxy(page, {
                    get(target, property) {
                      if (property === 'locator') return (...args) => wrapLocator(target.locator(...args));
                      if (property === 'goto') return (...args) => target.goto(...args).catch((error) => {
                        browserErrors.push(`goto: ${error.message}`);
                        throw error;
                      });
                      const value = target[property];
                      return typeof value === 'function' ? value.bind(target) : value;
                    },
                  });
                };
                if (property !== 'route') {
                  const value = target[property];
                  return typeof value === 'function' ? value.bind(target) : value;
                }
                return (pattern, handler) => target.route(pattern, async (route) => {
                  requested.push(route.request().url());
                  const wrapped = new Proxy(route, {
                    get(target, property) {
                      if (property === 'abort') return async (...args) => {
                        aborted.push({ url: target.request().url(), resourceType: target.request().resourceType() });
                        return target.abort(...args);
                      };
                      if (property === 'continue') return async () => {
                        await target.abort('blockedbyclient');
                        assert.fail('离线验收禁止任何未经本机映射的浏览器网络请求');
                      };
                      if (property === 'fetch') return async (options) => {
                        const original = new URL(options.url || target.request().url());
                        assert.equal(original.origin, IDENTITY, '非 Identity 请求不能到达本机转发器');
                        assert.equal(options.maxRedirects, 0, '转发不得自动追踪跳转');
                        assert.equal(options.maxRetries, 0, '转发不得自动重试');
                        forwarded.push(original.href);
                        return target.fetch({ ...options, url: `${loopback}/identity${original.pathname}${original.search}` });
                      };
                      const value = target[property];
                      return typeof value === 'function' ? value.bind(target) : value;
                    },
                  });
                  await handler(wrapped);
                });
              },
            });
          };
        },
      });
    },
  };
  const runtime = {
    platform: 'linux',
    env: { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', PATH: process.env.PATH, UOS_STORE_USERNAME: USERNAME, UOS_STORE_PASSWORD: PASSWORD, GH_TOKEN: 'offline-github-token' },
    fs: {
      // 仅离线测试映射生产 tmpfs 前置条件；生产代码仍校验真实 Linux /dev/shm。
      async lstat(target) { assert.equal(target, '/dev/shm'); return { isDirectory: () => true, isSymbolicLink: () => false }; },
      async statfs(target) { assert.equal(target, '/dev/shm'); return { type: 0x01021994 }; },
      async mkdtemp(prefix) {
        assert.equal(prefix, '/dev/shm/uniontech-browser-');
        const directory = await fs.mkdtemp(path.join(runtimeRoot, 'session-'));
        temporaryDirectories.push(directory);
        return directory;
      },
      chmod: fs.chmod,
      rm: fs.rm,
    },
  };
  const authenticate = (options = {}) => authenticateUnionTechBrowser({
    loginUrl: LOGIN, username: USERNAME, password: PASSWORD, timeoutMs: 15_000, ...options, chromium, runtime,
  });
  const assertClean = async () => {
    assert.equal(temporaryDirectories.length, 1);
    for (const directory of temporaryDirectories) {
      await assert.rejects(fs.access(directory), (error) => error.code === 'ENOENT');
    }
    assert.equal(browserEnvironments.length, 1);
    assert.doesNotMatch(JSON.stringify(browserEnvironments), /offline-user|offline-only-password|offline-github-token/u);
    assert.ok(forwarded.every((url) => new URL(url).origin === IDENTITY));
  };
  return { authenticate, requested, aborted, forwarded, requests, unexpectedProxyRequests, browserErrors, assertClean };
}

integration('离线真实 Chromium 完成填表、普通宣传提示和商店 API 身份衔接', async (context) => {
  const harness = await createOfflineHarness(context);
  const apiRequests = [];
  const client = new UosStoreApiClient({
    baseUrl: STORE,
    identityAuthenticator: harness.authenticate,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      assert.equal(url.origin, STORE);
      apiRequests.push({ method: options.method, path: url.pathname, body: options.body });
      const json = (datas, headers) => new Response(JSON.stringify({ status: 200, datas }), { headers });
      if (url.pathname.endsWith('/getLoginPath')) return json(LOGIN);
      if (url.pathname.endsWith('/login')) return json({}, { 'set-cookie': 'access-token=offline-session; Secure; HttpOnly' });
      if (url.pathname.endsWith('/dev_info')) return json({ dev_type: 1 });
      if (url.pathname === '/devprod-api/store-dev-app/app' && options.method === 'GET') {
        return json({ total: 1, rows: [{ pkg_name: 'com.floatboat.desktop', app_id: 'offline-app', id: 'offline-version' }] });
      }
      assert.fail('认证检查不能触发其他商店操作');
    },
  });
  const logs = [];
  const errors = [];
  const exitCode = await runAuthenticationCheck({
    client, credentials: { username: USERNAME, password: PASSWORD }, log: (line) => logs.push(line), error: (line) => errors.push(line),
  });
  assert.equal(exitCode, 0, JSON.stringify(errors));
  assert.deepEqual(logs, ['UOS authentication ready for com.floatboat.desktop']);
  assert.deepEqual(errors, []);
  const loginPosts = harness.requests.filter((item) => item.path === '/api/oauth2/authorize');
  assert.equal(loginPosts.length, 1);
  const submitted = new URLSearchParams(loginPosts[0].body);
  assert.equal(Buffer.from(submitted.get('account'), 'base64').toString().split(':')[0], USERNAME);
  assert.equal(Buffer.from(submitted.get('password'), 'base64').toString().split(':')[0], PASSWORD);
  const follow = harness.requests.filter((item) => item.path === '/api/oauth2/showqrcode');
  assert.equal(follow.length, 1);
  assert.deepEqual(JSON.parse(follow[0].body), { showQrcode: 0 });
  assert.ok(harness.requested.includes(CALLBACK));
  assert.ok(!harness.forwarded.includes(CALLBACK));
  assert.deepEqual(apiRequests.map(({ method, path }) => [method, path]), [
    ['GET', '/devprod-api/store-dev-auth/getLoginPath'],
    ['POST', '/devprod-api/store-dev-auth/login'],
    ['GET', '/devprod-api/store-dev-auth/dev_info'],
    ['GET', '/devprod-api/store-dev-app/app'],
  ]);
  assert.deepEqual(JSON.parse(apiRequests[1].body), { code: 'offline-code', state: STATE });
  await harness.assertClean();
});

integration('离线真实 Chromium 等待普通宣传提示的慢响应，按钮只点击一次', async (context) => {
  const harness = await createOfflineHarness(context, 'slow-follow');
  assert.deepEqual(await harness.authenticate(), { code: 'offline-code', state: STATE });
  assert.equal(harness.requests.filter((item) => item.path === '/api/oauth2/showqrcode').length, 1);
  await harness.assertClean();
});

integration('离线真实 Chromium 拦截宣传页动态 HTTP 图片后仍完成认证并清理会话', async (context) => {
  const harness = await createOfflineHarness(context, 'untrusted-image');
  assert.deepEqual(await harness.authenticate(), { code: 'offline-code', state: STATE });
  assert.ok(harness.requests.some((item) => item.path === '/api/oauth2/qrcodeconfig'));
  assert.deepEqual(harness.aborted.filter(({ url }) => new URL(url).hostname === 'untrusted.invalid'), [
    { url: UNTRUSTED_QR_CODE, resourceType: 'image' },
  ]);
  assert.ok(!harness.forwarded.some((url) => url.includes('untrusted.invalid')));
  assert.ok(!harness.unexpectedProxyRequests.some((url) => url.includes('untrusted.invalid')));
  assert.equal(harness.requests.filter((item) => item.path === '/api/oauth2/showqrcode').length, 1);
  assert.ok(harness.requested.includes(CALLBACK));
  assert.ok(!harness.forwarded.includes(CALLBACK));
  await harness.assertClean();
});

integration('离线真实 Chromium 仍拒绝宣传页跳转到同一陌生 HTTP 地址', async (context) => {
  const harness = await createOfflineHarness(context, 'untrusted-http-document');
  await assert.rejects(harness.authenticate(), (error) => {
    assert.equal(error.code, 'UOS_AUTH_CONTRACT_UNVERIFIED');
    assert.match(error.message, /未受信/u);
    return true;
  });
  assert.ok(harness.aborted.some(({ url, resourceType }) => url === UNTRUSTED_QR_CODE && resourceType === 'document'));
  assert.ok(!harness.forwarded.some((url) => url.includes('untrusted.invalid')));
  assert.ok(!harness.unexpectedProxyRequests.some((url) => url.includes('untrusted.invalid')));
  assert.equal(harness.requests.filter((item) => item.path === '/api/oauth2/showqrcode').length, 0);
  assert.ok(!harness.requested.includes(CALLBACK));
  await harness.assertClean();
});

integration('离线真实 Chromium 同源 GET 中转后更新真实页面路径再捕获商店回跳', async (context) => {
  const harness = await createOfflineHarness(context, 'redirected-path');
  const result = await harness.authenticate({ timeoutMs: 3000 }).catch((error) => {
    assert.fail(`${error.message}\n${harness.browserErrors.join('\n')}`);
  });
  assert.deepEqual(result, { code: 'offline-code', state: STATE });
  const transit = harness.requests.filter((item) => ['/oauth2/transit', '/oauth2/follow'].includes(item.path));
  assert.deepEqual(transit.map(({ method, path }) => [method, path]), [
    ['GET', '/oauth2/transit'],
    ['GET', '/oauth2/follow'],
  ]);
  assert.ok(harness.requested.includes(CALLBACK));
  assert.ok(!harness.forwarded.includes(CALLBACK));
  await harness.assertClean();
});

for (const [mode, expectedReason] of [
  ['unknown-host', '未受信请求'],
  ['redirect-307', '不受支持的重定向'],
  ['redirect-308', '不受支持的重定向'],
  ['repeat-password', '重复密码提交'],
  ['consent-button', '人工验证或授权'],
  ['captcha', '人工验证或授权'],
]) {
  integration(`离线真实 Chromium 拒绝 ${mode}，不会发出额外认证请求`, async (context) => {
    const harness = await createOfflineHarness(context, mode);
    await assert.rejects(harness.authenticate(), (error) => {
      const diagnostic = describeUosAuthenticationFailure(new UosStoreApiError(error.code, error.message.slice(`${error.code}: `.length)));
      assert.match(error.message, new RegExp(expectedReason));
      assert.doesNotMatch(JSON.stringify(diagnostic), /offline-user|offline-only-password|offline-code|offline-state|untrusted\.invalid/u);
      return true;
    });
    assert.equal(harness.requests.filter((item) => item.path === '/api/oauth2/authorize').length, mode === 'captcha' ? 0 : 1);
    assert.equal(harness.requests.filter((item) => item.path === '/api/oauth2/showqrcode').length, 0);
    assert.ok(!harness.forwarded.some((url) => url.includes('untrusted.invalid')));
    assert.ok(!harness.unexpectedProxyRequests.some((url) => url.includes('untrusted.invalid')));
    await harness.assertClean();
  });
}
