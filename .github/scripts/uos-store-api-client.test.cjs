#!/usr/bin/env node
// ABOUTME: 用本地 mock server 固定统信公开前端的检测、分片上传与提交协议。

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { UnionTechIdentityError, validateCallback } = require('./uniontech-identity-authenticator.cjs');

const {
  UOS_STORE_CONTRACT,
  UosStoreApiClient,
  UosStoreApiError,
  classifyAuditStatus,
  classifyPublicationStatus,
  digest,
  describeUosAuthenticationFailure,
  redactMessage,
} = require('./uos-store-api-client.cjs');

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('登录检查通过认证适配层保留固定诊断和不含字段值的回跳分类', async () => {
  const client = new UosStoreApiClient({
    baseUrl: 'https://appstore-dev.uniontech.com',
    identityAuthenticator: async () => validateCallback('http://login.uniontech.com/unknown?code=private-code&state=private-state', 'expected-state'),
    fetchImpl: async () => new Response(JSON.stringify({ status: 200, datas: 'https://login.uniontech.com/oauth2/authorize?state=expected-state' })),
  });
  let authenticationError;
  try {
    await client.authenticate({ username: 'private-user', password: 'private-password' });
  } catch (error) {
    authenticationError = error;
  }
  const diagnostic = describeUosAuthenticationFailure(authenticationError);
  assert.deepEqual(diagnostic, {
    code: 'UOS_AUTH_CONTRACT_UNVERIFIED',
    reason: '统信 OAuth 回跳不属于固定开发者平台',
    callbackShape: {
      originClass: 'identity_http', protocolClass: 'http', portClass: 'default', pathClass: 'other',
      hasUserinfo: false, hasFragment: false,
    },
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-code|private-state|private-user|private-password|unknown|login\.uniontech/u);
});

test('登录检查拒绝任意错误内容及带未知字段的回跳分类', () => {
  for (const error of [
    new Error('private-password'),
    new UosStoreApiError('private-code', 'private-password'),
    new UosStoreApiError('UOS_AUTH_FAILED', 'private-password'),
  ]) {
    error.callbackShape = {
      originClass: 'other', protocolClass: 'https', portClass: 'default', pathClass: 'other',
      hasUserinfo: false, hasFragment: false, password: 'private-password',
    };
    const diagnostic = describeUosAuthenticationFailure(error);
    assert.equal(diagnostic.callbackShape, undefined);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-password|private-code/u);
  }
  const error = new UosStoreApiError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 OAuth 回跳不属于固定开发者平台');
  for (const value of [
    { originClass: 'https://private-domain', protocolClass: 'https', portClass: 'default', pathClass: 'other', hasUserinfo: false, hasFragment: false },
    { originClass: 'other', protocolClass: 'https', portClass: 'default', pathClass: 'other', hasUserinfo: false, hasFragment: 'private-token' },
  ]) {
    error.callbackShape = value;
    const diagnostic = describeUosAuthenticationFailure(error);
    assert.equal(diagnostic.callbackShape, undefined);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-domain|private-token/u);
  }
});

test('Identity 失败保留固定契约原因，同时拒绝输出任意异常内容', async () => {
  for (const [identityError, expectedMessage] of [
    [new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 Identity RSA 加密失败'), '统信 Identity RSA 加密失败'],
    [new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 OAuth 回跳 code/state 无法确认'), '统信 OAuth 回跳 code/state 无法确认'],
    [new UnionTechIdentityError('UOS_AUTH_CONTRACT_UNVERIFIED', 'release-user release-password token=private-token'), '统信 Identity 未能建立自动化会话'],
    [Object.assign(new Error('release-user release-password token=private-token'), { code: 'UOS_AUTH_CONTRACT_UNVERIFIED' }), '统信 Identity 未能建立自动化会话'],
  ]) {
    const requests = [];
    const client = new UosStoreApiClient({
      baseUrl: 'https://appstore-dev.uniontech.com',
      identityAuthenticator: async () => { throw identityError; },
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), method: options.method });
        return new Response(JSON.stringify({ status: 200, datas: 'https://login.uniontech.com/oauth2/authorize?state=private-state' }));
      },
    });
    await assert.rejects(
      () => client.authenticate({ username: 'release-user', password: 'release-password' }),
      (error) => {
        assert.equal(error.code, 'UOS_AUTH_CONTRACT_UNVERIFIED');
        assert.equal(error.message, `UOS_AUTH_CONTRACT_UNVERIFIED: ${expectedMessage}`);
        assert.doesNotMatch(error.message, /release-user|release-password|private-token|private-state/u);
        return true;
      },
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
  }
});

async function startServer(handler) {
  const server = http.createServer((request, response) => void handler(request, response));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('兼容 HTTP 商店回跳后只向固定 HTTPS API 兑换 code/state', async () => {
  const requests = [];
  const client = new UosStoreApiClient({
    baseUrl: 'https://appstore-dev.uniontech.com',
    identityAuthenticator: async () => validateCallback('http://appstore-dev.uniontech.com/?code=oauth-code&state=expected-state', 'expected-state'),
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      requests.push({ url: url.href, method: init.method, body: init.body });
      if (url.pathname.endsWith('/getLoginPath')) {
        return new Response(JSON.stringify({ status: 200, datas: 'https://login.uniontech.com/oauth2/authorize?state=expected-state' }));
      }
      if (url.pathname.endsWith('/login')) {
        return new Response(JSON.stringify({ status: 200, datas: {} }), {
          headers: { 'set-cookie': 'access-token=short-session; Secure; HttpOnly' },
        });
      }
      if (url.pathname.endsWith('/dev_info')) {
        return new Response(JSON.stringify({ status: 200, datas: { dev_type: 1 } }));
      }
      throw new Error('unexpected request');
    },
  });
  await client.authenticate({ username: 'release-user', password: 'release-password' });
  assert.ok(requests.every((request) => new URL(request.url).origin === 'https://appstore-dev.uniontech.com'));
  assert.deepEqual(requests[1], {
    url: 'https://appstore-dev.uniontech.com/devprod-api/store-dev-auth/login',
    method: 'POST',
    body: JSON.stringify({ code: 'oauth-code', state: 'expected-state' }),
  });
});

function json(response, payload, statusCode = 200, headers = {}) {
  response.writeHead(statusCode, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}

test('集中契约固定公开前端端点与操作值', () => {
  assert.equal(UOS_STORE_CONTRACT.detectPrefixBytes, 400 * 1024);
  assert.equal(UOS_STORE_CONTRACT.uploadType, 'temppkg');
  assert.equal(UOS_STORE_CONTRACT.submitOperateType, 52);
  assert.equal(UOS_STORE_CONTRACT.endpoints.loginPath, '/store-dev-auth/getLoginPath');
  assert.equal(UOS_STORE_CONTRACT.endpoints.loginCallback, '/store-dev-auth/login');
  assert.equal(UOS_STORE_CONTRACT.endpoints.developerInfo, '/store-dev-auth/dev_info');
  assert.equal(UOS_STORE_CONTRACT.endpoints.applicationHistory('stable-app'), '/store-dev-app/app/stable-app/history');
  assert.equal(UOS_STORE_CONTRACT.endpoints.versionDetail('version/id'), '/store-dev-app/app/version%2Fid/detail');
  assert.equal(UOS_STORE_CONTRACT.endpoints.detectPackage, '/store-dev-pkg-proceses/detect-pkg-info');
  assert.equal(UOS_STORE_CONTRACT.endpoints.submitApplication, '/store-dev-app/app');
});

test('提交模板复用当前版本详情端点', async () => {
  const client = new UosStoreApiClient({ baseUrl: 'http://127.0.0.1' });
  const calls = [];
  client.requestJson = async (...args) => {
    calls.push(args);
    return { app_info: { app_basic_info: { app_id: 'com.floatboat.desktop' } } };
  };

  const template = await client.getApplicationTemplate('version/id');

  assert.equal(template.app_info.app_basic_info.app_id, 'com.floatboat.desktop');
  assert.deepEqual(calls, [[
    'GET',
    '/store-dev-app/app/version%2Fid/detail',
    undefined,
    '读取版本详情',
  ]]);
});

test('API client 只发送 400KiB 检测前缀并按前端 MD5 begin/PUT/end 契约上传', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uos-api-client-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packagePath = path.join(root, 'Floatboat-0.6.3-amd64.deb');
  const packageBytes = Buffer.alloc(400 * 1024 + 123, 0x61);
  fs.writeFileSync(packagePath, packageBytes);
  const events = [];
  let server;
  server = await startServer(async (request, response) => {
    const url = new URL(request.url, server.url);
    const body = await readBody(request);
    events.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: request.headers });
    if (url.pathname === '/devprod-api/store-dev-auth/getLoginPath') {
      return json(response, { status: 200, datas: 'https://login.uniontech.com/oauth2/authorize?client_id=test&state=test' });
    }
    if (url.pathname === '/devprod-api/store-dev-auth/login') {
      return json(response, { status: 200, datas: {} }, 200, { 'set-cookie': 'access-token=short-session; Path=/; Secure; HttpOnly' });
    }
    if (url.pathname === '/devprod-api/store-dev-auth/dev_info') {
      return json(response, { status: 200, datas: { dev_type: 1 } });
    }
    if (url.pathname === '/devprod-api/store-dev-pkg-proceses/detect-pkg-info') {
      return json(response, { status: 200, datas: { pkg_name: 'com.floatboat.desktop', pkg_version: '0.6.3.0', pkg_arch: 'amd64' } });
    }
    if (url.pathname === '/devprod-api/store-file/upload/begin') {
      const payload = JSON.parse(body);
      return json(response, {
        status: 200,
        datas: {
          id: 'record-1', upload_id: 'upload-1', file_save_key: 'file-key',
          upload_infos: payload.chunks.map((_, index) => ({ upload_url: `${server.url}/upload/${index}` })),
        },
      });
    }
    if (url.pathname.startsWith('/upload/')) {
      response.writeHead(200);
      return response.end();
    }
    if (url.pathname === '/devprod-api/store-file/upload/end') {
      return json(response, { status: 200, datas: { file_save_key: 'file-key' } });
    }
    return json(response, { status: 404, desc: 'missing' }, 404);
  });
  context.after(() => server.close());

  const client = new UosStoreApiClient({
    baseUrl: server.url,
    identityAuthenticator: async ({ loginUrl, username, password }) => {
      assert.equal(loginUrl, 'https://login.uniontech.com/oauth2/authorize?client_id=test&state=test');
      assert.equal(username, 'release-user');
      assert.equal(password, 'release-password');
      return { code: 'oauth-code', state: 'test' };
    },
  });
  await client.authenticate({ username: 'release-user', password: 'release-password' });
  const detected = await client.detectPackage(packagePath);
  assert.equal(detected.pkg_name, 'com.floatboat.desktop');
  const uploaded = await client.uploadPackage(packagePath);
  assert.equal(uploaded.file_save_key, 'file-key');

  const detect = events.find((event) => event.path.endsWith('/detect-pkg-info'));
  assert.equal(detect.body.length, 400 * 1024);
  assert.deepEqual(detect.query, { fileName: path.basename(packagePath), pkgInstallMode: '1' });
  const begin = JSON.parse(events.find((event) => event.path.endsWith('/upload/begin')).body);
  assert.deepEqual(Object.keys(begin).sort(), ['chunks', 'fileName', 'uploadType']);
  assert.equal(begin.uploadType, 'temppkg');
  assert.ok(begin.chunks.every((chunk) => /^[0-9a-f]{32}$/u.test(chunk.hash) && chunk.size > 0));
  assert.equal(begin.fileName, path.basename(packagePath));
  const end = JSON.parse(events.find((event) => event.path.endsWith('/upload/end')).body);
  assert.equal(end.hash, digest('md5', packageBytes));
  assert.equal(end.status, 2);
  assert.deepEqual(end.chunks, begin.chunks.map((chunk) => chunk.hash));
  assert.ok(events.filter((event) => event.path.startsWith('/upload/')).every((event) => !event.headers.cookie));
  const callback = events.find((event) => event.path === '/devprod-api/store-dev-auth/login');
  assert.deepEqual(JSON.parse(callback.body), { code: 'oauth-code', state: 'test' });
  const devInfo = events.find((event) => event.path === '/devprod-api/store-dev-auth/dev_info');
  assert.match(devInfo.headers.cookie, /access-token=short-session/u);
});

test('登录重定向或 HTML 响应明确要求人工交互', async (context) => {
  const server = await startServer(async (_request, response) => {
    response.writeHead(302, { location: 'https://identity.chinauos.com/login', 'content-type': 'text/html' });
    response.end('<html>login</html>');
  });
  context.after(() => server.close());
  const client = new UosStoreApiClient({ baseUrl: server.url });
  await assert.rejects(
    () => client.authenticate({ username: 'user', password: 'secret' }),
    (error) => error.code === 'UOS_AUTH_INTERACTION_REQUIRED' && !error.message.includes('secret'),
  );
});

test('生产默认认证发现 OAuth 后失败关闭且不直传账号密码', async (context) => {
  const events = [];
  const server = await startServer(async (request, response) => {
    events.push({ method: request.method, url: request.url, body: await readBody(request) });
    return json(response, {
      status: 200,
      datas: 'https://login.uniontech.com/oauth2/authorize?client_id=test&state=test',
    });
  });
  context.after(() => server.close());
  const client = new UosStoreApiClient({ baseUrl: server.url });

  await assert.rejects(
    () => client.authenticate({ username: 'release-user', password: 'release-password' }),
    (error) => error.code === 'UOS_AUTH_INTERACTION_REQUIRED' && !error.message.includes('release-password'),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].method, 'GET');
  assert.equal(events[0].url, '/devprod-api/store-dev-auth/getLoginPath');
  assert.equal(events[0].body.length, 0);
});

test('日志脱敏会整体移除签名 URL、凭证和值本身', () => {
  const secret = 'release-password';
  const message = 'password=visible https://upload.example/pkg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc&part=1 release-password';
  const redacted = redactMessage(message, [secret]);
  assert.doesNotMatch(redacted, /visible|abc|AWS4|release-password/iu);
  assert.match(redacted, /password=\[REDACTED\]/u);
  assert.match(redacted, /\[REDACTED_URL\]/u);
});

test('审核状态显式区分草稿、已提交、通过、驳回和未知', () => {
  assert.equal(classifyAuditStatus({ audit_status: '审核中' }), 'submitted');
  assert.equal(classifyAuditStatus({ reviewStatus: 'submitted' }), 'submitted');
  assert.equal(classifyAuditStatus({ audit_status: '审核通过' }), 'approved');
  assert.equal(classifyAuditStatus({ audit_status: '草稿' }), 'draft');
  assert.equal(classifyAuditStatus({ audit_status: '已驳回' }), 'rejected');
  assert.equal(classifyAuditStatus({ datas: { reviewStatus: '审核未通过' } }), 'rejected');
  assert.equal(classifyAuditStatus({ audit_status: 7 }), 'unknown');
  assert.equal(
    classifyAuditStatus({ datas: { datas: [{ check_item: '包安全', status: 1 }], submit_time: '2026-11-02' } }),
    'unknown',
  );
  assert.equal(
    classifyPublicationStatus(
      { status: 52, statusStr: '审核中' },
      { datas: { datas: [{ check_item: '包安全', status: 1 }], submit_time: '2026-11-02' } },
    ),
    'submitted',
  );
  assert.equal(classifyPublicationStatus({ status: 0, statusStr: '审核不通过' }, {}), 'rejected');
  assert.equal(classifyPublicationStatus({ status: 52, statusStr: '审核未通过' }, {}), 'unknown');
  assert.equal(classifyPublicationStatus({ status: null }, {}), 'unknown');
  assert.equal(classifyPublicationStatus({ status: '' }, {}), 'unknown');
  assert.equal(classifyPublicationStatus({ status: 'not-a-number' }, {}), 'unknown');
  assert.equal(classifyPublicationStatus({ status: null, statusStr: '审核中' }, {}), 'submitted');
  const numericStates = [
    [-99, 'draft'],
    [0, 'rejected'],
    [1, 'manual-action-required'],
    [-2, 'manual-action-required'],
    [52, 'submitted'],
    [54, 'approved'],
    [101, 'approved'],
    [103, 'manual-action-required'],
    [500, 'rejected'],
    [501, 'rejected'],
    [502, 'rejected'],
  ];
  for (const [status, expected] of numericStates) {
    assert.equal(classifyPublicationStatus({ status }, {}), expected);
  }
  assert.equal(classifyPublicationStatus({ status: 101, statusStr: '上架' }, {}), 'approved');
  assert.equal(classifyPublicationStatus({ status: -99, statusStr: '草稿' }, {}), 'draft');
  assert.equal(classifyPublicationStatus({ status: 103, statusStr: '下架待审核' }, {}), 'manual-action-required');
});

test('审核结论通过 app_id 历史精确绑定唯一版本 id 与双架构详情', async () => {
  const hash = { amd64: 'a'.repeat(64), arm64: 'b'.repeat(64) };
  const manifest = {
    appid: 'com.floatboat.desktop',
    packageVersion: '0.6.3.0',
    packages: Object.entries(hash).map(([arch, sha256]) => ({ arch, sha256 })),
  };
  const row = (arch, versionId = 'version-current') => ({
    pkg_version: '0.6.3.0', pkg_arch: arch, sha256: hash[arch], file_save_key: `key-${arch}`, version_id: versionId,
  });
  const client = new UosStoreApiClient({ baseUrl: 'http://127.0.0.1' });

  const setRemote = ({
    history = [{ id: 'version-current', pkg_version: '0.6.3.0' }],
    detail = { app_info: { app_basic_info: { app_id: 'com.floatboat.desktop' }, app_origin_pkgs: [row('amd64')] } },
    audit = { audit_status: '草稿' },
  } = {}) => {
    client.listApplicationHistory = async () => history;
    client.getVersionDetail = async () => detail;
    client.requestJson = async (_method, endpoint) => {
      if (endpoint.endsWith('/audit_status')) return audit;
      throw new Error(`unexpected endpoint: ${endpoint}`);
    };
  };

  setRemote({ history: [
    { id: 'version-old', pkg_version: '0.6.2.0' },
    { id: 'version-current', pkg_version: '0.6.3.0' },
  ] });
  assert.equal((await client.inspectPublication('app', manifest)).state, 'partial-uploaded');

  setRemote({
    history: [{ id: 'version-current', pkg_version: '0.6.3.0', status: 52, statusStr: '审核中' }],
    detail: { app_info: { app_basic_info: { app_id: 'com.floatboat.desktop' }, app_origin_pkgs: [row('amd64'), row('arm64')] } },
    audit: { datas: { datas: [{ check_item: '包安全', status: 1 }], submit_time: '2026-11-02' } },
  });
  assert.equal((await client.inspectPublication('app', manifest)).state, 'submitted');

  setRemote({
    detail: { app_info: { app_basic_info: { app_id: 'com.floatboat.desktop' }, app_origin_pkgs: [row('amd64'), row('arm64')] } },
    audit: { audit_status: '审核通过' },
  });
  assert.equal((await client.inspectPublication('app', manifest)).state, 'submitted');

  setRemote({
    history: [{ pkg_version: '0.6.3.0' }],
  });
  assert.equal((await client.inspectPublication('app', manifest)).state, 'unconfirmed');

  setRemote({
    detail: { app_info: { app_basic_info: { app_id: 'com.floatboat.desktop' }, app_origin_pkgs: [row('amd64'), row('amd64')] } },
  });
  assert.equal((await client.inspectPublication('app', manifest)).state, 'conflict');

  setRemote({
    detail: { app_info: { app_basic_info: { app_id: 'com.floatboat.desktop' }, app_origin_pkgs: [row('amd64'), row('arm64')] } },
    audit: { audit_status: '已驳回' },
  });
  assert.equal((await client.inspectPublication('app', manifest)).state, 'manual-action-required');

  setRemote({
    history: [
      { id: 'version-old', pkg_version: '0.6.2.0', audit_status: '已驳回' },
      { id: 'version-current', pkg_version: '0.6.3.0' },
    ],
    detail: { app_info: { app_basic_info: { app_id: 'com.floatboat.desktop' }, app_origin_pkgs: [row('amd64'), row('arm64')] } },
    audit: { audit_status: '审核中' },
  });
  assert.equal((await client.inspectPublication('app', manifest)).state, 'submitted');

  setRemote({ history: [{ id: 'version-newer', pkg_version: '0.6.3.2' }] });
  assert.equal((await client.inspectPublication('app', manifest)).state, 'version-regression');

  setRemote({
    detail: { app_info: { app_basic_info: { app_id: 'com.floatboat.desktop.deepseek' }, app_origin_pkgs: [] } },
  });
  assert.equal((await client.inspectPublication('app', manifest)).state, 'conflict');
});

test('版本历史有界拉取全部分页，目标版本可位于后页', async () => {
  const hash = { amd64: 'a'.repeat(64), arm64: 'b'.repeat(64) };
  const manifest = {
    appid: 'com.floatboat.desktop',
    packageVersion: '0.6.3.0',
    packages: Object.entries(hash).map(([arch, sha256]) => ({ arch, sha256 })),
  };
  const endpoints = [];
  const client = new UosStoreApiClient({ baseUrl: 'http://127.0.0.1' });
  client.requestJson = async (_method, endpoint) => {
    endpoints.push(endpoint);
    if (endpoint.includes('/history?')) {
      const pageNum = new URL(endpoint, 'http://local').searchParams.get('pageNum');
      return pageNum === '1'
        ? { total: 2, rows: [{ id: 'old-version', app_id: 'stable-app', pkg_version: '0.6.2.0' }] }
        : { total: 2, rows: [{ id: 'target-version', app_id: 'stable-app', pkg_version: '0.6.3.0' }] };
    }
    if (endpoint.endsWith('/detail')) {
      return { app_info: {
        app_basic_info: { app_id: 'com.floatboat.desktop' },
        app_origin_pkgs: [
          { pkg_version: '0.6.3.0', pkg_arch: 'amd64', sha256: hash.amd64, file_save_key: 'amd64-key' },
          { pkg_version: '0.6.3.0', pkg_arch: 'arm64', sha256: hash.arm64, file_save_key: 'arm64-key' },
        ],
      } };
    }
    if (endpoint.endsWith('/audit_status')) return { audit_status: '审核中' };
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };

  assert.equal((await client.inspectPublication('stable-app', manifest)).state, 'submitted');
  const historyEndpoints = endpoints.filter((endpoint) => endpoint.includes('/history?'));
  assert.equal(historyEndpoints.length, 2);
  assert.match(historyEndpoints[0], /pageNum=1&pageSize=100/u);
  assert.match(historyEndpoints[1], /pageNum=2&pageSize=100/u);
  assert.ok(endpoints.some((endpoint) => endpoint.includes('/target-version/detail')));
  assert.ok(endpoints.some((endpoint) => endpoint.includes('/target-version/audit_status')));
});

test('版本历史分页缺失、重复或总数变化时失败关闭', async () => {
  const scenarios = [
    [
      { total: 2, rows: [{ id: 'one', app_id: 'stable-app' }] },
      { total: 2, rows: [] },
    ],
    [
      { total: 2, rows: [{ id: 'one', app_id: 'stable-app' }] },
      { total: 2, rows: [{ id: 'one', app_id: 'stable-app' }] },
    ],
    [
      { total: 2, rows: [{ id: 'one', app_id: 'stable-app' }] },
      { total: 3, rows: [{ id: 'two', app_id: 'stable-app' }] },
    ],
  ];
  for (const pages of scenarios) {
    const client = new UosStoreApiClient({ baseUrl: 'http://127.0.0.1' });
    let index = 0;
    client.requestJson = async () => pages[Math.min(index++, pages.length - 1)];
    await assert.rejects(
      () => client.listApplicationHistory('stable-app'),
      (error) => error.code === 'UOS_REMOTE_STATE_UNCONFIRMED',
    );
  }
});

test('应用列表只按 pkg_name 唯一定位，并分别保留稳定 app_id 与当前版本 id', async () => {
  const client = new UosStoreApiClient({ baseUrl: 'http://127.0.0.1' });
  client.listApplications = async () => [
    { app_id: 1097210, id: 'a85f2dd1', pkg_name: 'com.floatboat.desktop' },
    { app_id: 1097211, id: 'other-version', pkg_name: 'com.example.other' },
  ];
  assert.deepEqual(await client.resolveApplicationRecord('com.floatboat.desktop'), {
    appId: '1097210',
    currentVersionId: 'a85f2dd1',
    record: { app_id: 1097210, id: 'a85f2dd1', pkg_name: 'com.floatboat.desktop' },
  });

  client.listApplications = async () => [
    { app_id: 1097210, id: 'one', pkg_name: 'com.floatboat.desktop' },
    { app_id: 1097210, id: 'two', pkg_name: 'com.floatboat.desktop' },
  ];
  await assert.rejects(
    () => client.resolveApplicationRecord('com.floatboat.desktop'),
    (error) => error.code === 'UOS_APPLICATION_IDENTITY_UNCONFIRMED',
  );
});

test('应用列表有界拉取全部分页并排除后页重复身份', async () => {
  const client = new UosStoreApiClient({ baseUrl: 'http://127.0.0.1' });
  const endpoints = [];
  client.requestJson = async (_method, endpoint) => {
    endpoints.push(endpoint);
    const pageNum = new URL(endpoint, 'http://local').searchParams.get('pageNum');
    return pageNum === '1'
      ? { total: 2, rows: [{ app_id: 1, id: 'other-version', pkg_name: 'com.example.other' }] }
      : { total: 2, rows: [{ app_id: 1097210, id: 'target-version', pkg_name: 'com.floatboat.desktop' }] };
  };
  assert.equal((await client.resolveApplicationRecord('com.floatboat.desktop')).currentVersionId, 'target-version');
  assert.equal(endpoints.length, 2);
  assert.match(endpoints[0], /pageNum=1&pageSize=100/u);
  assert.match(endpoints[1], /pageNum=2&pageSize=100/u);

  const invalidPages = [
    { total: 2, rows: [{ app_id: 1, id: 'one', pkg_name: 'com.example.one' }] },
    { total: 2, rows: [{ app_id: 1, id: 'two', pkg_name: 'com.example.two' }] },
  ];
  let index = 0;
  client.requestJson = async () => invalidPages[Math.min(index++, invalidPages.length - 1)];
  await assert.rejects(
    () => client.listApplications(),
    (error) => error.code === 'UOS_REMOTE_STATE_UNCONFIRMED',
  );

  index = 0;
  client.requestJson = async () => index++ === 0
    ? { total: 2, rows: [{ app_id: 1, id: 'one', pkg_name: 'com.example.one' }] }
    : { total: 2, rows: [] };
  await assert.rejects(
    () => client.listApplications(),
    (error) => error.code === 'UOS_REMOTE_STATE_UNCONFIRMED',
  );
});
