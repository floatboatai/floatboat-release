#!/usr/bin/env node
// ABOUTME: 在内存中完成统信 Identity 的 RSA OAuth 登录，只返回一次性回跳 code/state。

'use strict';

const crypto = require('node:crypto');

const IDENTITY_ORIGIN = 'https://login.uniontech.com';
const STORE_ORIGIN = 'https://appstore-dev.uniontech.com';
const REQUIRED_OAUTH_FIELDS = Object.freeze(['client_id', 'redirect_uri', 'response_type', 'scope', 'state']);
const RESERVED_LOGIN_FIELDS = new Set(['account', 'password', 'token', 'validate', 'user_oauth']);
const SAFE_IDENTITY_FAILURE_MESSAGES = new Set([
  '统信 OAuth 登录地址无效',
  '统信 OAuth 登录入口不符合受信契约',
  '统信 OAuth response_type 不是 code',
  '统信 OAuth redirect_uri 无效',
  '统信 OAuth redirect_uri 不是固定开发者平台',
  '统信 Identity 未返回可用 RSA 公钥',
  '统信 Identity RSA 公钥无效',
  '统信 Identity RSA 加密失败',
  '统信 Identity 未启用受支持的 RSA 登录',
  '统信 OAuth 初始化响应无效',
  '统信 Identity 登录响应无效',
  '统信 OAuth 未返回回跳地址',
  '统信 OAuth 回跳地址无效',
  '统信 OAuth 回跳不属于固定开发者平台',
  '统信 OAuth 回跳包含用户信息',
  '统信 OAuth 回跳包含 fragment',
  '统信 OAuth 回跳路径不是商店根路径',
  '统信 OAuth 返回额外登录中转，需要人工处理',
  '统信 OAuth 回跳 code/state 无法确认',
]);

class UnionTechIdentityError extends Error {
  constructor(code, message, options = {}) {
    super(`${code}: ${message}`);
    this.name = 'UnionTechIdentityError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
    const callbackShape = sanitizeCallbackShape(options.callbackShape);
    if (callbackShape) this.callbackShape = callbackShape;
  }
}

function describeIdentityFailure(error) {
  // 只输出源码声明的静态原因，第三方响应和任意异常文本继续隐藏。
  const fallback = '统信 Identity 未能建立自动化会话';
  if (!(error instanceof UnionTechIdentityError) ||
      !['UOS_AUTH_CONTRACT_UNVERIFIED', 'UOS_AUTH_INTERACTION_REQUIRED'].includes(error.code)) return fallback;
  const prefix = `${error.code}: `;
  const message = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : '';
  return sanitizeIdentityFailureReason(message);
}

function sanitizeIdentityFailureReason(message) {
  return SAFE_IDENTITY_FAILURE_MESSAGES.has(message) ? message : '统信 Identity 未能建立自动化会话';
}

function sanitizeCallbackShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const enums = {
    originClass: [
      'store_https', 'store_http', 'identity_https', 'identity_http',
      'account_https', 'account_http', 'identity_center_https', 'identity_center_http',
      'static_cdn_https', 'static_cdn_http', 'other',
    ],
    protocolClass: ['https', 'http', 'other'],
    portClass: ['default', 'nondefault'],
    pathClass: ['root', 'registerlogin', 'follow', 'other'],
  };
  const fields = [...Object.keys(enums), 'hasUserinfo', 'hasFragment'];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))) return undefined;
  if (Object.entries(enums).some(([key, allowed]) => !allowed.includes(value[key]))) return undefined;
  if (typeof value.hasUserinfo !== 'boolean' || typeof value.hasFragment !== 'boolean') return undefined;
  return Object.freeze(Object.fromEntries(fields.map((key) => [key, value[key]])));
}

function classifyCallbackShape(callback) {
  const origins = {
    [STORE_ORIGIN]: 'store_https',
    'http://appstore-dev.uniontech.com': 'store_http',
    [IDENTITY_ORIGIN]: 'identity_https',
    'http://login.uniontech.com': 'identity_http',
    'https://account.uniontech.com': 'account_https',
    'http://account.uniontech.com': 'account_http',
    'https://identity.chinauos.com': 'identity_center_https',
    'http://identity.chinauos.com': 'identity_center_http',
    'https://cdn-nu-common.uniontech.com': 'static_cdn_https',
    'http://cdn-nu-common.uniontech.com': 'static_cdn_http',
  };
  const paths = { '/': 'root', '/api/oauth2/authorize/registerlogin': 'registerlogin', '/oauth2/follow': 'follow' };
  return sanitizeCallbackShape({
    originClass: origins[callback.origin] || 'other',
    protocolClass: callback.protocol === 'https:' ? 'https' : callback.protocol === 'http:' ? 'http' : 'other',
    portClass: callback.port ? 'nondefault' : 'default',
    pathClass: paths[callback.pathname] || 'other',
    hasUserinfo: Boolean(callback.username || callback.password),
    hasFragment: Boolean(callback.hash),
  });
}

class IdentityCookieJar {
  constructor() {
    this.cookies = new Map();
  }

  capture(headers) {
    const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (name && cookieValue) this.cookies.set(name, cookieValue);
    }
  }

  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

function interactionRequired(message, options = {}) {
  return new UnionTechIdentityError('UOS_AUTH_INTERACTION_REQUIRED', message, options);
}

function validateOAuthLoginUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 OAuth 登录地址无效');
  }
  if (url.href.length > 16 * 1024 || url.origin !== IDENTITY_ORIGIN || url.pathname !== '/oauth2/authorize' ||
      url.username || url.password || url.hash) {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 OAuth 登录入口不符合受信契约');
  }
  for (const field of REQUIRED_OAUTH_FIELDS) {
    const values = url.searchParams.getAll(field);
    if (values.length !== 1 || !values[0] || values[0].length > 2048) {
      throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', `统信 OAuth 缺少唯一字段 ${field}`);
    }
  }
  for (const field of url.searchParams.keys()) {
    if (RESERVED_LOGIN_FIELDS.has(field.toLowerCase())) {
      throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', `统信 OAuth 登录地址包含保留字段 ${field}`);
    }
  }
  if (url.searchParams.get('response_type') !== 'code') {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 OAuth response_type 不是 code');
  }
  let redirect;
  try {
    redirect = new URL(url.searchParams.get('redirect_uri'));
  } catch {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 OAuth redirect_uri 无效');
  }
  if (redirect.origin !== STORE_ORIGIN || redirect.pathname !== '/' || redirect.search || redirect.hash) {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 OAuth redirect_uri 不是固定开发者平台');
  }
  return url;
}

function oauthForm(loginUrl) {
  return new URLSearchParams(loginUrl.searchParams);
}

function decodePublicKey(envelope) {
  const encoded = envelope?.data;
  if (typeof encoded !== 'string' || encoded.length > 16 * 1024) {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 Identity 未返回可用 RSA 公钥');
  }
  let pem;
  try {
    pem = Buffer.from(encoded, 'base64').toString('utf8');
    // 统信公开接口以非标准边框包装 SPKI，只规范已确认的整对边框。
    pem = pem.replace(
      /^-----BEGIN RSA Public Key-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END RSA Public Key-----(?:\r?\n)?$/u,
      '-----BEGIN PUBLIC KEY-----\n$1\n-----END PUBLIC KEY-----\n',
    );
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
    return key;
  } catch {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 Identity RSA 公钥无效');
  }
}

function encryptCredential(publicKey, value) {
  try {
    return crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(value, 'utf8')).toString('base64');
  } catch {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 Identity RSA 加密失败');
  }
}

function normalizeIdentityEnvelope(payload, operation) {
  if (!payload || typeof payload !== 'object' || Number(payload.code) !== 200) {
    const description = String(payload?.desc ?? payload?.message ?? '');
    if (/captcha|verify|mfa|bind|contact|consent|验证码|二次验证|绑定|授权|扫码/iu.test(description)) {
      throw interactionRequired(`${operation} 需要人工完成`);
    }
    throw new UnionTechIdentityError('UOS_AUTH_FAILED', `${operation} 未成功`, { retryable: true });
  }
  return payload.data;
}

function validateCallback(rawRedirect, expectedState) {
  if (typeof rawRedirect !== 'string' || rawRedirect.length > 8192) {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 OAuth 未返回回跳地址');
  }
  let callback;
  try {
    callback = new URL(rawRedirect.startsWith('//') ? `https:${rawRedirect}` : rawRedirect);
  } catch {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 OAuth 回跳地址无效');
  }
  const callbackShape = classifyCallbackShape(callback);
  const invalidCallback = (message) => new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', message, { callbackShape });
  if (callback.username || callback.password) {
    throw invalidCallback('统信 OAuth 回跳包含用户信息');
  }
  if (callback.hash) {
    throw invalidCallback('统信 OAuth 回跳包含 fragment');
  }
  if (callback.origin === IDENTITY_ORIGIN && callback.pathname === '/api/oauth2/authorize/registerlogin') {
    throw interactionRequired('统信 OAuth 返回额外登录中转，需要人工处理', { callbackShape });
  }
  // 回跳仅提供 code/state，不访问该 URL；兑换始终走固定 HTTPS 商店 API。
  // 先匹配原始 origin，避免修改协议时吞掉原本不受信的显式端口。
  if (callback.origin === 'http://appstore-dev.uniontech.com') callback.protocol = 'https:';
  if (callback.origin !== STORE_ORIGIN) {
    throw invalidCallback('统信 OAuth 回跳不属于固定开发者平台');
  }
  if (callback.pathname !== '/') {
    throw invalidCallback('统信 OAuth 回跳路径不是商店根路径');
  }
  const codes = callback.searchParams.getAll('code');
  const states = callback.searchParams.getAll('state');
  if (codes.length !== 1 || states.length !== 1 || !codes[0] || states[0] !== expectedState) {
    throw invalidCallback('统信 OAuth 回跳 code/state 无法确认');
  }
  return Object.freeze({ code: codes[0], state: states[0] });
}

class IdentityHttpClient {
  constructor(fetchImpl, referer) {
    this.fetch = fetchImpl;
    this.referer = referer;
    this.cookies = new IdentityCookieJar();
  }

  async request(url, options = {}) {
    const target = new URL(url);
    if (target.origin !== IDENTITY_ORIGIN) {
      throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', 'Identity 请求目标不受信');
    }
    const headers = {
      accept: options.expectJson === false ? 'text/html,*/*' : 'application/json',
      origin: IDENTITY_ORIGIN,
      referer: this.referer,
      ...(options.headers || {}),
    };
    const cookie = this.cookies.header();
    if (cookie) headers.cookie = cookie;
    let response;
    try {
      response = await this.fetch(target, {
        method: options.method || 'GET',
        redirect: 'manual',
        headers,
        body: options.body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new UnionTechIdentityError('UOS_AUTH_FAILED', '统信 Identity 网络请求失败', { retryable: true });
    }
    this.cookies.capture(response.headers);
    if (response.status >= 300 && response.status < 400) throw interactionRequired('统信 Identity 转入了交互登录');
    if (!response.ok) {
      throw new UnionTechIdentityError('UOS_AUTH_FAILED', `统信 Identity HTTP ${response.status}`, {
        retryable: response.status >= 500 || response.status === 408 || response.status === 429,
      });
    }
    if (options.expectJson === false) return null;
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) {
      throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 Identity 响应过大');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw interactionRequired('统信 Identity 返回了交互页面');
    }
  }

  getJson(path) {
    return this.request(new URL(path, IDENTITY_ORIGIN));
  }

  postForm(path, form) {
    return this.request(new URL(path, IDENTITY_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString(),
    });
  }
}

async function authenticateUnionTechIdentity(options) {
  const username = String(options.username || '').trim();
  const password = String(options.password || '');
  if (!username || !password) {
    throw new UnionTechIdentityError('UOS_STORE_CREDENTIALS_MISSING', '缺少 UOS_STORE_USERNAME 或 UOS_STORE_PASSWORD');
  }
  const loginUrl = validateOAuthLoginUrl(options.loginUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '运行环境缺少 fetch');
  const client = new IdentityHttpClient(fetchImpl, loginUrl.href);

  await client.request(loginUrl, { expectJson: false });
  const config = await client.getJson('/assets/config/config.json');
  if (!config || config.NECaptcha !== false) throw interactionRequired('统信 Identity 当前要求验证码');
  if (config.JSEncrypt !== true) {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 Identity 未启用受支持的 RSA 登录');
  }

  const publicKey = decodePublicKey(await client.getJson('/api/key'));
  const initialized = normalizeIdentityEnvelope(await client.postForm('/api/oauth2/client', oauthForm(loginUrl)), '初始化统信 OAuth');
  if (!initialized || typeof initialized !== 'object') {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 OAuth 初始化响应无效');
  }
  if (initialized.IsGrunt === true) throw interactionRequired('统信 OAuth 需要人工确认授权范围');

  const authorizeForm = oauthForm(loginUrl);
  authorizeForm.set('account', encryptCredential(publicKey, username));
  authorizeForm.set('password', encryptCredential(publicKey, password));
  authorizeForm.set('token', 'has');
  authorizeForm.set('validate', 'random_hdh');
  authorizeForm.set('user_oauth', 'o_base');
  const authorized = normalizeIdentityEnvelope(
    await client.postForm('/api/oauth2/authorize', authorizeForm),
    '统信 Identity 登录',
  );
  if (!authorized || typeof authorized !== 'object') {
    throw new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 Identity 登录响应无效');
  }
  if (authorized.need_bind_contact || authorized.cancel_unregister_key || authorized.login_key || authorized.autoLoginKey) {
    throw interactionRequired('统信 Identity 账户需要人工绑定或确认');
  }
  return validateCallback(authorized.redirect, loginUrl.searchParams.get('state'));
}

module.exports = {
  IDENTITY_ORIGIN,
  STORE_ORIGIN,
  UnionTechIdentityError,
  authenticateUnionTechIdentity,
  classifyCallbackShape,
  describeIdentityFailure,
  sanitizeIdentityFailureReason,
  sanitizeCallbackShape,
  normalizeIdentityEnvelope,
  validateCallback,
  validateOAuthLoginUrl,
};
