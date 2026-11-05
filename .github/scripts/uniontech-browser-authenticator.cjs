#!/usr/bin/env node
// ABOUTME: 在 Actions 的临时浏览器中执行统信公开登录流程，只返回经过校验的商店 code/state。

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { diagnoseNavigation } = require('./uniontech-navigation-diagnostic.cjs');
const {
  IDENTITY_ORIGIN,
  STORE_ORIGIN,
  UnionTechIdentityError,
  classifyCallbackShape,
  validateCallback,
  validateOAuthLoginUrl,
} = require('./uniontech-identity-authenticator.cjs');

const BROWSER_SELECTORS = Object.freeze({
  username: 'app-login-web form.login-form input[formcontrolname="userName"]',
  password: 'app-login-web form.login-form input[formcontrolname="password"]',
  submit: 'app-login-web form.login-form button.login-form-button.login-form-margin',
  follow: 'app-follow button.know',
  manual: Object.freeze([
    'app-login-web .auth-btn',
    'input[formcontrolname="valid_code"]',
    '.yidun_panel',
    '.yidun_popup',
  ]),
});

const FAILURE = Object.freeze({
  input: '统信浏览器登录输入不符合固定契约',
  runtime: '统信浏览器登录仅允许 Actions Linux 环境',
  storage: '统信浏览器临时目录必须位于独立内存文件系统',
  launch: '统信浏览器无法启动',
  page: '统信浏览器登录页面无法完成初始化',
  request: '统信浏览器阻止了未受信请求',
  requestBeforeSubmit: '统信浏览器在提交登录表单前阻止了未受信请求',
  requestSubmitted: '统信浏览器在提交口令后阻止了未受信请求',
  requestAuthorized: '统信浏览器在登录响应成功后阻止了未受信请求',
  redirect: '统信浏览器阻止了不受支持的重定向',
  replay: '统信浏览器阻止了重复密码提交',
  password: '统信浏览器密码提交不符合固定契约',
  response: '统信浏览器密码登录未成功',
  passwordResponse: '统信密码接口未返回成功响应',
  registerResponse: '统信登录中转接口未返回成功响应',
  manual: '统信浏览器登录需要人工验证或授权',
  callback: '统信浏览器商店回跳未通过校验',
  timeout: '统信浏览器等待登录完成超时',
  cleanup: '统信浏览器临时会话未能完整清理',
});
const REQUEST_FAILURE = Object.freeze(Object.fromEntries(
  ['requestBeforeSubmit', 'requestSubmitted', 'requestAuthorized'].flatMap((stage) =>
    Object.entries({ Navigation: '页面跳转', Script: '脚本', Data: '接口请求' }).map(([kind, label]) =>
      [`${stage}${kind}`, `${FAILURE[stage]}（${label}）`])),
));
const BROWSER_FAILURE_MESSAGES = Object.freeze([...Object.values(FAILURE), ...Object.values(REQUEST_FAILURE)]);
const POST_PATHS = new Set([
  '/api/oauth2/client',
  '/api/agreement',
  '/api/oauth2/authorize',
  '/api/oauth2/authorize/registerlogin',
  '/api/islogin',
  '/api/oauth2/checkoauth',
  '/api/oauth2/showqrcode',
]);
const OAUTH_FIELDS = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state'];
const TMPFS_MAGIC = 0x01021994;
const LEGACY_IDENTITY_ORIGIN = 'https://login.chinauos.com';
let authenticating = false;

function failure(stage, code = 'UOS_AUTH_CONTRACT_UNVERIFIED', options = {}) {
  return new UnionTechIdentityError(code, FAILURE[stage] || REQUEST_FAILURE[stage], options);
}

function isManualPath(url) {
  return /(?:^|\/)(?:bind|revoke|mfa|captcha|verify|consent)(?:\/|$)/iu.test(url.pathname) ||
    url.pathname.startsWith('/oauth2/client/') || url.pathname.startsWith('/m/');
}

function isAllowedTarget(url, method, resourceType, legacyBridgeConfirmed = false) {
  if (url.username || url.password || url.hash || url.protocol !== 'https:') return false;
  if (url.origin === IDENTITY_ORIGIN) return ['GET', 'HEAD'].includes(method) || (method === 'POST' && POST_PATHS.has(url.pathname));
  if (legacyBridgeConfirmed && url.origin === LEGACY_IDENTITY_ORIGIN) return ['GET', 'HEAD'].includes(method);
  return url.origin === 'https://cdn-nu-common.uniontech.com' && ['GET', 'HEAD'].includes(method) && resourceType === 'image';
}

function confirmedLegacyBridge(url, lastRedirect) {
  if (lastRedirect?.source !== 'authorize' || !lastRedirect.raw.startsWith('//')) return undefined;
  try {
    const expected = new URL(lastRedirect.raw, IDENTITY_ORIGIN);
    if (expected.origin !== LEGACY_IDENTITY_ORIGIN || expected.username || expected.password || expected.hash) return undefined;
    if (!['http://login.chinauos.com', LEGACY_IDENTITY_ORIGIN].includes(url.origin) || url.username || url.password || url.hash) return undefined;
    const target = new URL(url.href);
    target.protocol = 'https:';
    return target.href === expected.href ? target : undefined;
  } catch { return undefined; }
}

function isPasswordForm(request, loginUrl, username, password) {
  const body = request.postData() || '';
  if (body.length > 16 * 1024 || !/^application\/x-www-form-urlencoded(?:;|$)/iu.test(request.headers()['content-type'] || '')) return false;
  const form = new URLSearchParams(body);
  const allowed = new Set([...loginUrl.searchParams.keys(), 'account', 'password', 'token', 'validate', 'user_oauth', 'grunt']);
  if ([...form.keys()].some((name) => !allowed.has(name))) return false;
  for (const name of [...OAUTH_FIELDS, 'account', 'password', 'token', 'validate', 'user_oauth']) {
    if (form.getAll(name).length !== 1) return false;
  }
  if (OAUTH_FIELDS.some((name) => form.get(name) !== loginUrl.searchParams.get(name))) return false;
  if (form.get('token') !== 'has' || form.get('validate') !== 'random_hdh' || form.get('user_oauth') !== 'o_base') return false;
  const account = form.get('account');
  const encryptedPassword = form.get('password');
  return account !== username && encryptedPassword !== password &&
    /^[A-Za-z0-9+/]{128,}={0,2}$/u.test(account) && /^[A-Za-z0-9+/]{128,}={0,2}$/u.test(encryptedPassword);
}

function isInitializationForm(request, loginUrl) {
  const form = new URLSearchParams(request.postData() || '');
  return [...form].every(([name, value]) =>
    (name === 'grunt' && value === 'true') ||
    (loginUrl.searchParams.getAll(name).length === 1 && loginUrl.searchParams.get(name) === value));
}

function isFollowPreference(request) {
  const raw = request.postData() || '';
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === 1 && value.showQrcode === 0;
  } catch {
    const form = new URLSearchParams(raw);
    return [...form].length === 1 && form.get('showQrcode') === '0';
  }
}

function safeBrowserEnvironment(env, directory) {
  const result = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'LD_LIBRARY_PATH', 'DISPLAY']) {
    if (typeof env[name] === 'string') result[name] = env[name];
  }
  return {
    ...result,
    TMPDIR: directory,
    XDG_CACHE_HOME: path.join(directory, 'cache'),
    XDG_CONFIG_HOME: path.join(directory, 'config'),
    XDG_DATA_HOME: path.join(directory, 'data'),
  };
}

async function authenticateUnionTechBrowser(options) {
  options = options || {};
  let loginUrl;
  const username = String(options.username || '').trim();
  const password = String(options.password || '');
  try {
    loginUrl = validateOAuthLoginUrl(options.loginUrl);
  } catch {
    throw failure('input');
  }
  if (!username || !password || username.length > 200 || password.length > 64) throw failure('input');
  const runtime = options.runtime || {};
  const env = runtime.env || process.env;
  const fileSystem = runtime.fs || fs;
  if ((runtime.platform || process.platform) !== 'linux' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'Linux' ||
      env.DEBUG || env.PWDEBUG || process.env.DEBUG || process.env.PWDEBUG || authenticating) {
    throw failure('runtime');
  }
  const timeoutMs = Math.min(120_000, Math.max(100, options.timeoutMs || 90_000));
  authenticating = true;
  let directory;
  let browser;
  let context;
  let page;
  let timer;
  let settled = false;
  let submitted = false;
  let passwordRequests = 0;
  let authorized = false;
  let followClicked = false;
  let followRequests = 0;
  let pendingNavigation;
  let navigationRedirects = 0;
  let lastRedirect;
  let legacyBridgeConfirmed = false;
  let stage = 'storage';
  let flow;
  const ready = { config: false, key: false, client: false };
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // 路由或页面事件可能先于等待者失败，提前安装处理避免未处理的拒绝输出敏感堆栈。
  result.catch(() => {});
  const reject = (reason, code, options) => {
    if (settled) return;
    settled = true;
    rejectResult(failure(reason, code, options));
  };
  const abort = async (route) => { try { await route.abort('blockedbyclient'); } catch {} };
  const scheduleNavigation = async (route, target) => {
    navigationRedirects += 1;
    if (navigationRedirects > 5) { reject('redirect'); return abort(route); }
    pendingNavigation = target.href;
    // 204 保留旧页面，不生成会抢占下一次 goto 的 Chrome 错误页；新导航仍独立经过拦截。
    await route.fulfill({ status: 204, headers: { 'cache-control': 'no-store' }, body: '' });
  };
  const captureCallback = (url, isNavigation) => {
    if (![STORE_ORIGIN, 'http://appstore-dev.uniontech.com'].includes(url.origin)) return false;
    if (!isNavigation || !submitted || !authorized) {
      reject('callback');
      return true;
    }
    try {
      const callback = validateCallback(url.href, loginUrl.searchParams.get('state'));
      if (!settled) { settled = true; resolveResult(callback); }
    } catch {
      reject('callback');
    }
    return true;
  };

  const inspectResponse = async (url, response, method, passwordRequest) => {
    if (url.origin !== IDENTITY_ORIGIN) return;
    if (!['/assets/config/config.json', '/api/key', '/api/oauth2/client', '/api/oauth2/authorize', '/api/oauth2/authorize/registerlogin'].includes(url.pathname)) return;
    // 同名 GET 可能是正常中转页面；它不提供密码授信，也不按 POST 的 JSON 契约读取。
    if (['/api/oauth2/authorize', '/api/oauth2/authorize/registerlogin'].includes(url.pathname) && method !== 'POST') return;
    const authenticationStage = url.pathname === '/api/oauth2/authorize' ? 'password' : url.pathname === '/api/oauth2/authorize/registerlogin' ? 'registerlogin' : undefined;
    const rejectResponse = (payload) => {
      const rawCode = payload?.code;
      const value = typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' && /^(?:0|[1-9]\d{0,5})$/u.test(rawCode) ? Number(rawCode) : NaN;
      reject(authenticationStage === 'password' ? 'passwordResponse' : 'registerResponse', 'UOS_AUTH_FAILED', {
        authenticationResponse: {
          stage: authenticationStage, httpStatus: response.status(),
          code: Number.isInteger(value) && value >= 0 && value <= 999999 ? value : null,
        },
      });
    };
    let payload;
    try { payload = await response.json(); } catch {
      if (authenticationStage) return rejectResponse();
      throw new Error('invalid initialization response');
    }
    if (url.pathname === '/assets/config/config.json') {
      if (payload?.NECaptcha !== false) return reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED');
      if (payload.JSEncrypt !== true) return reject('page');
      ready.config = true;
    } else if (url.pathname === '/api/key') {
      if (Number(payload?.code) !== 200 || typeof payload.data !== 'string') return reject('page');
      ready.key = true;
    } else if (url.pathname === '/api/oauth2/client') {
      if (Number(payload?.code) !== 200 || !payload.data || typeof payload.data !== 'object') return reject('page');
      ready.client = true;
    } else {
      if (response.status() !== 200 ||
          (url.pathname === '/api/oauth2/authorize' ? !passwordRequest : method !== 'POST' || !authorized)) {
        return rejectResponse(payload);
      }
      if (Number(payload?.code) !== 200 || !payload.data || typeof payload.data !== 'object') return rejectResponse(payload);
      if (payload.data.need_bind_contact || payload.data.cancel_unregister_key || payload.data.phone_unbind) {
        return reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED');
      }
      if (url.pathname === '/api/oauth2/authorize') authorized = true;
      if (typeof payload.data.redirect === 'string' && payload.data.redirect.length <= 8192) {
        lastRedirect = { source: url.pathname === '/api/oauth2/authorize' ? 'authorize' : 'registerlogin', raw: payload.data.redirect };
      }
    }
  };

  const handleRoute = async (route) => {
    try {
      if (settled) return abort(route);
      const request = route.request();
      let url = new URL(request.url());
      const method = request.method();
      const resourceType = request.resourceType();
      const isNavigation = method === 'GET' && request.isNavigationRequest() && request.frame() === page.mainFrame();
      if (isNavigation && submitted && authorized && !legacyBridgeConfirmed) {
        const bridge = confirmedLegacyBridge(url, lastRedirect);
        if (bridge) {
          if (isManualPath(bridge)) {
            reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED');
            return abort(route);
          }
          legacyBridgeConfirmed = true;
          if (url.protocol === 'http:') {
            // 官方授权响应给出旧登录域；只在本机升级导航，认证参数不经 HTTP 发送。
            return await scheduleNavigation(route, bridge);
          }
        }
      }
      const optionalAsset = !request.isNavigationRequest() && ['GET', 'HEAD'].includes(method) && ['image', 'font'].includes(resourceType);
      // 社群提示的动态二维码不是认证条件；只阻断资源，避免图片失效误报为登录失败。
      if (optionalAsset && !isAllowedTarget(url, method, resourceType, legacyBridgeConfirmed)) return abort(route);
      if (captureCallback(url, isNavigation)) return abort(route);
      if ([IDENTITY_ORIGIN, LEGACY_IDENTITY_ORIGIN].includes(url.origin) && isManualPath(url)) {
        reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED');
        return abort(route);
      }
      if (!isAllowedTarget(url, method, resourceType, legacyBridgeConfirmed)) {
        // 点击按钮不代表密码请求已发出，阶段以固定密码请求及其响应为准。
        const stage = authorized ? 'requestAuthorized' : passwordRequests > 0 ? 'requestSubmitted' : 'requestBeforeSubmit';
        const kind = request.isNavigationRequest() ? 'Navigation' : resourceType === 'script' ? 'Script' : ['xhr', 'fetch'].includes(resourceType) ? 'Data' : '';
        const reason = `${stage}${kind}`;
        reject(reason, 'UOS_AUTH_CONTRACT_UNVERIFIED', {
          callbackShape: classifyCallbackShape(url),
          ...(request.isNavigationRequest() ? { navigationDiagnostic: diagnoseNavigation(url, lastRedirect) } : {}),
        });
        return abort(route);
      }
      if ([...url.searchParams.keys()].some((name) => /^(?:account|password)$/iu.test(name))) {
        reject('password');
        return abort(route);
      }
      const passwordRequest = url.pathname === '/api/oauth2/authorize' && method === 'POST';
      if (passwordRequest) {
        passwordRequests += 1;
        if (passwordRequests !== 1) { reject('replay'); return abort(route); }
        if (!submitted || !ready.config || !ready.key || !ready.client || !isPasswordForm(request, loginUrl, username, password)) {
          reject('password');
          return abort(route);
        }
      } else if (method === 'POST') {
        if (['/api/oauth2/client', '/api/islogin', '/api/oauth2/checkoauth'].includes(url.pathname) && !isInitializationForm(request, loginUrl)) {
          reject('password');
          return abort(route);
        }
        if (['/api/agreement', '/api/oauth2/authorize/registerlogin'].includes(url.pathname) &&
            !['', '{}'].includes((request.postData() || '').trim())) {
          reject('password');
          return abort(route);
        }
      }
      if (url.pathname === '/api/oauth2/showqrcode') {
        followRequests += 1;
        if (!authorized || !followClicked || followRequests !== 1 || !isFollowPreference(request)) {
          reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED');
          return abort(route);
        }
      }
      // 统一由 APIRequestContext 逐跳获取，浏览器永远收不到能自动重放口令的 3xx。
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        const response = await route.fetch({ url: url.href, maxRedirects: 0, maxRetries: 0, timeout: remaining() });
        const status = response.status();
        if (status >= 300 && status < 400) {
          if (!['GET', 'HEAD'].includes(method)) { reject('redirect'); return abort(route); }
          const location = response.headers().location;
          if (!location || redirects === 5) { reject('redirect'); return abort(route); }
          const next = new URL(location, url);
          if (optionalAsset && (next.origin !== url.origin || !isAllowedTarget(next, method, resourceType, legacyBridgeConfirmed))) return abort(route);
          if (captureCallback(next, isNavigation)) return abort(route);
          if ([IDENTITY_ORIGIN, LEGACY_IDENTITY_ORIGIN].includes(next.origin) && isManualPath(next)) {
            reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED');
            return abort(route);
          }
          const identityOrigins = legacyBridgeConfirmed ? [IDENTITY_ORIGIN, LEGACY_IDENTITY_ORIGIN] : [IDENTITY_ORIGIN];
          if (!identityOrigins.includes(next.origin) || !identityOrigins.includes(url.origin) || !isAllowedTarget(next, method, resourceType, legacyBridgeConfirmed)) {
            reject('redirect');
            return abort(route);
          }
          // 跨域只能交给新主文档导航，避免改写 route.fetch 目标时携带原请求身份头。
          if (next.origin !== url.origin && !(isNavigation && resourceType === 'document')) {
            reject('redirect');
            return abort(route);
          }
          if (isNavigation && resourceType === 'document') {
            // 新导航重新经过完整拦截，且官方脚本看到正确的 pathname 与相对资源基准。
            return await scheduleNavigation(route, next);
          }
          url = next;
          continue;
        }
        if (status >= 400 && (passwordRequest || isNavigation)) {
          reject(passwordRequest ? 'passwordResponse' : 'page', 'UOS_AUTH_FAILED', passwordRequest ? {
            authenticationResponse: { stage: 'password', httpStatus: status, code: null },
          } : {});
          return abort(route);
        }
        await inspectResponse(url, response, method, passwordRequest);
        if (settled) return abort(route);
        await route.fulfill({ response });
        return;
      }
    } catch {
      reject('request', 'UOS_AUTH_FAILED');
      await abort(route);
    }
  };

  try {
    const directoryInfo = await fileSystem.lstat('/dev/shm');
    const mount = await fileSystem.statfs('/dev/shm');
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || Number(mount.type) !== TMPFS_MAGIC) throw failure('storage');
    directory = await fileSystem.mkdtemp('/dev/shm/uniontech-browser-');
    await fileSystem.chmod(directory, 0o700);
    stage = 'launch';
    const chromium = options.chromium || require('./uos-browser-runtime/node_modules/playwright').chromium;
    const previousTmpdir = process.env.TMPDIR;
    try {
      // Playwright 自身在父进程中创建临时 profile，单设 Chromium 子进程环境并不足够。
      process.env.TMPDIR = directory;
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        timeout: remaining(),
        env: safeBrowserEnvironment(env, directory),
        downloadsPath: directory,
        ignoreDefaultArgs: ['--disable-dev-shm-usage'],
        args: ['--disable-breakpad', '--disable-crash-reporter', `--disk-cache-dir=${path.join(directory, 'cache')}`],
      });
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
    context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
    await context.route('**/*', handleRoute);
    await context.routeWebSocket('**/*', async (socket) => {
      reject('request');
      try { await socket.close(); } catch {}
    });
    page = await context.newPage();
    page.setDefaultTimeout(Math.min(10_000, remaining()));
    context.on('page', (popup) => { void popup.close().catch(() => {}); reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED'); });
    page.on('download', (download) => { void download.cancel().catch(() => {}); reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED'); });
    page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED'); });
    page.on('crash', () => reject('page', 'UOS_AUTH_FAILED'));
    timer = setTimeout(() => reject('timeout', 'UOS_AUTH_FAILED'), remaining());
    stage = 'page';
    flow = (async () => {
      const act = async (action) => {
        try { await action(); } catch (error) {
          // 只有已验证的受控导航或最终回跳，可以解释我们主动中止引发的浏览器错误。
          if (!pendingNavigation && !settled) throw error;
        }
      };
      const navigate = (url) => act(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() }));
      await navigate(loginUrl.href);
      while (!settled) {
        try {
          if (pendingNavigation) {
            const target = pendingNavigation;
            pendingNavigation = undefined;
            await navigate(target);
            continue;
          }
          const current = new URL(page.url());
          if (!(current.origin === IDENTITY_ORIGIN || (legacyBridgeConfirmed && current.origin === LEGACY_IDENTITY_ORIGIN)) || isManualPath(current)) {
            reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED');
            break;
          }
          for (const selector of BROWSER_SELECTORS.manual) {
            if (await page.locator(selector).first().isVisible()) {
              reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED');
              break;
            }
          }
          if (settled) break;
          if (!submitted && Object.values(ready).every(Boolean)) {
            const user = page.locator(BROWSER_SELECTORS.username);
            const pass = page.locator(BROWSER_SELECTORS.password);
            const submit = page.locator(BROWSER_SELECTORS.submit);
            if (await user.count() === 1 && await pass.count() === 1 && await submit.count() === 1 &&
                await user.isVisible() && await pass.isVisible()) {
              await user.fill(username);
              await pass.fill(password);
              submitted = true;
              await act(() => submit.click({ timeout: remaining() }));
            }
          }
          if (!settled && authorized && !followClicked && current.pathname === '/oauth2/follow') {
            const button = page.locator(BROWSER_SELECTORS.follow);
            if (await button.count() === 1 && await button.isVisible()) {
              if ((await button.innerText()).trim() !== '我已了解，立即登录') {
                reject('manual', 'UOS_AUTH_INTERACTION_REQUIRED');
                break;
              }
              followClicked = true;
              await act(() => button.click({ timeout: remaining() }));
            }
          }
          if (!settled) await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining())));
        } catch (error) {
          if (!pendingNavigation && !settled) throw error;
        }
      }
    })().catch(() => reject(stage, 'UOS_AUTH_FAILED'));
    return await result;
  } catch (error) {
    if (error instanceof UnionTechIdentityError &&
        ['UOS_AUTH_CONTRACT_UNVERIFIED', 'UOS_AUTH_INTERACTION_REQUIRED', 'UOS_AUTH_FAILED'].includes(error.code) &&
        error.message.startsWith(`${error.code}: `) &&
        BROWSER_FAILURE_MESSAGES.includes(error.message.slice(`${error.code}: `.length))) throw error;
    throw failure(stage, 'UOS_AUTH_FAILED');
  } finally {
    settled = true;
    clearTimeout(timer);
    let cleanupFailed = false;
    try { if (context) await context.close(); } catch { cleanupFailed = true; }
    try { if (browser) await browser.close(); } catch { cleanupFailed = true; }
    try { if (flow) await flow; } catch {}
    try { if (directory) await fileSystem.rm(directory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    authenticating = false;
    if (cleanupFailed) throw failure('cleanup', 'UOS_AUTH_FAILED');
  }
}

module.exports = { BROWSER_FAILURE_MESSAGES, BROWSER_SELECTORS, authenticateUnionTechBrowser };
