#!/usr/bin/env node
// ABOUTME: 验证导航诊断能关联公开前端的地址变换，且不会输出地址中的私密数据。

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { diagnoseNavigation, sanitizeNavigationDiagnostic } = require('./uniontech-navigation-diagnostic.cjs');

test('root-relative 响应经官方前端变换成为单标签 api 主机', () => {
  const result = diagnoseNavigation(new URL('http://api/oauth2/authorize/step?code=private-code'), {
    source: 'authorize', raw: '/api/oauth2/authorize/step?code=private-code',
  });
  assert.deepEqual(result, {
    requestHost: 'api', source: 'authorize', format: 'root', sourceHost: 'login.uniontech.com',
    followHost: 'api', relation: 'official_follow_exact', hasAutoLoginKey: false,
  });
  assert.ok(Object.isFrozen(result));
  assert.doesNotMatch(JSON.stringify(result), /private-code|\/oauth2|\?/u);
});

test('完整 HTTPS 回跳精确关联原始响应，不输出用户信息、路径、查询或 fragment', () => {
  const raw = 'https://private-user:private-password@appstore-dev.uniontech.com/private-path?code=private-code&state=private-state#private-fragment';
  const request = new URL(raw);
  request.hash = '';
  const result = diagnoseNavigation(request, { source: 'registerlogin', raw });
  assert.equal(result.requestHost, 'appstore-dev.uniontech.com');
  assert.equal(result.sourceHost, 'appstore-dev.uniontech.com');
  assert.equal(result.followHost, 'appstore-dev.uniontech.com');
  assert.equal(result.format, 'absolute');
  assert.equal(result.relation, 'raw_exact');
  assert.doesNotMatch(JSON.stringify(result), /private-|https:|\?|#|@/u);
});

test('protocol-relative 响应与官方强制 HTTP 的目标关联', () => {
  const result = diagnoseNavigation('http://sso.uniontech.com/continue?state=private-state', {
    source: 'authorize', raw: '//sso.uniontech.com/continue?state=private-state',
  });
  assert.equal(result.format, 'network');
  assert.equal(result.requestHost, 'sso.uniontech.com');
  assert.equal(result.relation, 'official_follow_exact');
});

test('query-only 和 autoLoginKey 只记录格式，不推测或生成注册请求', () => {
  for (const raw of ['?autoLoginKey=private-key', 'autoLoginKey=private-key']) {
    const result = diagnoseNavigation('http://api/unrelated', { source: 'authorize', raw });
    assert.equal(result.format, 'queryonly');
    assert.equal(result.hasAutoLoginKey, true);
    assert.equal(result.relation, 'different');
    assert.doesNotMatch(JSON.stringify(result), /private-key|autoLoginKey=/u);
  }
});

test('整串编码的地址只解码一次，保留 query 语义用于内存关联', () => {
  const target = 'https://appstore-dev.uniontech.com/?code=a%2Bb&state=s%26x';
  for (const source of ['authorize', 'registerlogin']) {
    const result = diagnoseNavigation(target, { source, raw: encodeURIComponent(target) });
    assert.equal(result.format, 'encoded');
    assert.equal(result.followHost, 'appstore-dev.uniontech.com');
    assert.equal(result.relation, 'official_follow_exact');
  }
});

test('只按 hostname 相等和完全不同分别报告，不能误称精确关联', () => {
  const context = { source: 'registerlogin', raw: 'https://appstore-dev.uniontech.com/?state=private-state' };
  assert.equal(diagnoseNavigation('https://appstore-dev.uniontech.com/?state=other-state', context).relation, 'same_hostname_only');
  assert.equal(diagnoseNavigation('http://api/unknown', context).relation, 'different');
});

test('只输出公开词典重建的主机，未知标签、外域和 IP 全部分类', () => {
  const cases = [
    ['https://account.deepinid.deepin.com/', 'account.deepinid.deepin.com'],
    ['https://identity-pre.chinauos.com/', 'identity-pre.chinauos.com'],
    ['https://ecology.uniontech.com/', 'ecology.uniontech.com'],
    ['https://app-store-files.uniontech.com/', 'app-store-files.uniontech.com'],
    ['https://API.SSO.Uniontech.com./', 'api.sso.uniontech.com'],
    ['http://oauth2/authorize', 'oauth2'],
    ['https://private-token.uniontech.com/', 'uniontech_other'],
    ['https://private-token.chinauos.com/', 'chinauos_other'],
    ['https://private-token.deepin.com/', 'deepin_other'],
    ['https://login.uniontech.com.private-token.invalid/', 'external_domain'],
    ['https://private-token-uniontech.com/', 'external_domain'],
    ['http://private-token/', 'single_label_other'],
    ['http://127.0.0.1/', 'ipv4'],
    ['http://[::1]/', 'ipv6'],
    [`https://${'a'.repeat(64)}.uniontech.com/`, 'invalid'],
    ['https://api.api.api.api.uniontech.com/', 'uniontech_other'],
  ];
  for (const [target, expected] of cases) {
    const result = diagnoseNavigation(target, { source: 'registerlogin', raw: target });
    assert.equal(result.requestHost, expected, target);
    assert.equal(result.sourceHost, expected, target);
    assert.equal(result.followHost, expected, target);
    assert.doesNotMatch(JSON.stringify(result), /private-token|127\.0\.0\.1|::1|a{64}/u);
  }
});

test('raw 长度严格限制 8192，错误对象和畸形编码不泄露也不抛异常', () => {
  const prefix = 'https://login.uniontech.com/?value=';
  const exact = prefix + 'x'.repeat(8192 - prefix.length);
  assert.equal(diagnoseNavigation('http://api/', { source: 'authorize', raw: exact }).format, 'absolute');
  for (const raw of [exact + 'x', {}, 42, { toString() { throw new Error('private-error'); } }]) {
    const result = diagnoseNavigation('http://api/', { source: 'authorize', raw });
    assert.equal(result.format, 'invalid');
    assert.equal(result.relation, 'unparseable');
    assert.doesNotMatch(JSON.stringify(result), /private-error|x{20}/u);
  }
  const malformed = diagnoseNavigation('http://api/', { source: 'authorize', raw: '%ZZprivate' });
  assert.equal(malformed.format, 'invalid');
  assert.doesNotMatch(JSON.stringify(malformed), /private|%ZZ/u);
  assert.equal(diagnoseNavigation({ toString() { throw new Error('private-error'); } }).requestHost, 'invalid');
  assert.equal(diagnoseNavigation('http://api/', { source: 'private-source', raw: exact }).source, 'none');
});

test('sanitizer 只重建七个声明字段，拒绝外部值、访问器、错误对象和额外字段', () => {
  const valid = diagnoseNavigation('http://api/', { source: 'authorize', raw: '/api/' });
  assert.deepEqual(sanitizeNavigationDiagnostic(valid), valid);
  assert.notEqual(sanitizeNavigationDiagnostic(valid), valid);
  for (const value of [null, [], new Error('private-error'), { ...valid, raw: 'private-token' }, { ...valid, requestHost: 'private-token.uniontech.com' },
    { ...valid, source: 'private-source' }, { ...valid, format: 'private-format' }, { ...valid, relation: 'private-relation' },
    { ...valid, hasAutoLoginKey: 'private-value' }, { ...valid, sourceHost: 'api.api.api.api.uniontech.com' }]) {
    assert.equal(sanitizeNavigationDiagnostic(value), undefined);
  }
  const accessor = { ...valid };
  Object.defineProperty(accessor, 'requestHost', { enumerable: true, get() { throw new Error('private-getter'); } });
  assert.equal(sanitizeNavigationDiagnostic(accessor), undefined);
  const hidden = { ...valid };
  Object.defineProperty(hidden, 'private-extra', { value: 'private-token' });
  assert.equal(sanitizeNavigationDiagnostic(hidden), undefined);
  assert.equal(sanitizeNavigationDiagnostic({ ...valid, [Symbol('private-extra')]: 'private-token' }), undefined);
  assert.equal(sanitizeNavigationDiagnostic(new Proxy({}, { ownKeys() { throw new Error('private-proxy'); } })), undefined);
});
