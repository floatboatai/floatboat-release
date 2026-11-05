#!/usr/bin/env node
// ABOUTME: 仅在内存关联统信导航与公开前端地址变换，输出固定分类及公开词典重建的主机。

'use strict';

const { isIP } = require('node:net');

const FOLLOW_BASE = 'https://login.uniontech.com/oauth2/follow';
const MAX_REDIRECT_LENGTH = 8192;
const PUBLIC_LABELS = new Map([
  'login', 'account', 'identity', 'appstore-dev', 'cdn-nu-common', 'www',
  'login-pre', 'identity-pre', 'deepinid', 'ecology', 'app-store-files',
  'api', 'oauth2', 'auth', 'oauth', 'sso', 'appstore', 'dev',
].map((label) => [label, label]));
const PUBLIC_ROOTS = new Map([
  ['uniontech.com', 'uniontech_other'],
  ['chinauos.com', 'chinauos_other'],
  ['deepin.com', 'deepin_other'],
]);
const HOST_CLASSES = new Set([
  'none', 'invalid', 'uniontech_other', 'chinauos_other', 'deepin_other',
  'external_domain', 'single_label_other', 'ipv4', 'ipv6',
]);
const SOURCES = new Set(['authorize', 'registerlogin', 'none']);
const FORMATS = new Set(['absolute', 'network', 'root', 'queryonly', 'encoded', 'path_relative', 'missing', 'invalid']);
const RELATIONS = new Set(['raw_exact', 'official_follow_exact', 'same_hostname_only', 'different', 'unparseable', 'none']);
const FIELDS = ['requestHost', 'source', 'format', 'sourceHost', 'followHost', 'relation', 'hasAutoLoginKey'];

function classifyHostname(hostname) {
  if (typeof hostname !== 'string' || !hostname || hostname.length > 253) return 'invalid';
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  if (isIP(host) === 4) return 'ipv4';
  if (isIP(host.replace(/^\[|\]$/gu, '')) === 6) return 'ipv6';
  const labels = host.split('.');
  if (labels.some((label) => !/^[a-z0-9-]{1,63}$/u.test(label))) return 'invalid';
  if (labels.length === 1) return ['api', 'oauth2'].find((label) => label === host) || 'single_label_other';
  for (const [root, fallback] of PUBLIC_ROOTS) {
    if (host === root) return root;
    if (!host.endsWith(`.${root}`)) continue;
    const prefix = host.slice(0, -root.length - 1).split('.');
    if (prefix.length > 3 || prefix.some((label) => !PUBLIC_LABELS.has(label))) return fallback;
    // 词典只约束日志内容，不授予这些主机任何联网权限。
    return [...prefix.map((label) => PUBLIC_LABELS.get(label)), root].join('.');
  }
  return 'external_domain';
}

function sanitizeNavigationDiagnostic(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key))) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (FIELDS.some((field) => !Object.hasOwn(descriptors[field], 'value'))) return undefined;
    const result = Object.fromEntries(FIELDS.map((field) => [field, descriptors[field].value]));
    for (const field of ['requestHost', 'sourceHost', 'followHost']) {
      const host = result[field];
      if (typeof host !== 'string' || (!HOST_CLASSES.has(host) && classifyHostname(host) !== host)) return undefined;
    }
    if (!SOURCES.has(result.source) || !FORMATS.has(result.format) || !RELATIONS.has(result.relation) ||
        typeof result.hasAutoLoginKey !== 'boolean') return undefined;
    return Object.freeze(result);
  } catch {
    return undefined;
  }
}

function parseUrl(raw, base) {
  try { return new URL(raw, base); } catch { return undefined; }
}

function prefixFormat(raw) {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) return 'absolute';
  if (raw.startsWith('//')) return 'network';
  if (raw.startsWith('/')) return 'root';
  if (raw.startsWith('?') || /^[a-z_][a-z0-9_.-]*=/iu.test(raw)) return 'queryonly';
  return 'path_relative';
}

function classifyFormat(raw) {
  if (raw === undefined || raw === null || raw === '') return 'missing';
  if (typeof raw !== 'string' || raw.length > MAX_REDIRECT_LENGTH) return 'invalid';
  const direct = prefixFormat(raw);
  if (direct !== 'path_relative' || !raw.includes('%')) return direct;
  try {
    return prefixFormat(decodeURIComponent(raw)) !== 'path_relative' ? 'encoded' : direct;
  } catch {
    return 'invalid';
  }
}

function followUrl(raw, source) {
  try {
    // 只模拟已核查的公开前端字符串行为；结果仅用于比较，不修改响应或发起导航。
    const input = source === 'authorize' && !raw.startsWith('http') ? encodeURIComponent(`http:${raw}`) : raw;
    return parseUrl(decodeURIComponent(input), FOLLOW_BASE);
  } catch {
    return undefined;
  }
}

function compareTargets(request, direct, follow) {
  if (!request || (!direct && !follow)) return 'unparseable';
  // fragment 不进入浏览器网络请求；其余部分保留原值，只在内存作完整相等比较。
  for (const url of [request, direct, follow].filter(Boolean)) url.hash = '';
  if (direct?.href === request.href) return 'raw_exact';
  if (follow?.href === request.href) return 'official_follow_exact';
  if (request.hostname && [direct, follow].some((url) => url?.hostname === request.hostname)) return 'same_hostname_only';
  return 'different';
}

function diagnoseNavigation(url, context) {
  let request;
  let source = 'none';
  let raw;
  try {
    if (url instanceof URL) request = parseUrl(URL.prototype.toString.call(url));
    else if (typeof url === 'string') request = parseUrl(url);
    if (context && typeof context === 'object' && !Array.isArray(context)) {
      const descriptors = Object.getOwnPropertyDescriptors(context);
      const suppliedSource = descriptors.source?.value;
      if (suppliedSource === 'authorize' || suppliedSource === 'registerlogin') {
        source = suppliedSource;
        raw = descriptors.raw?.value;
      }
    }
  } catch {}
  const format = classifyFormat(raw);
  const usable = source !== 'none' && !['missing', 'invalid'].includes(format);
  const direct = usable ? parseUrl(raw, FOLLOW_BASE) : undefined;
  const follow = usable ? followUrl(raw, source) : undefined;
  return sanitizeNavigationDiagnostic({
    requestHost: request ? classifyHostname(request.hostname) : 'invalid',
    source,
    format,
    sourceHost: direct ? classifyHostname(direct.hostname) : format === 'missing' ? 'none' : 'invalid',
    followHost: follow ? classifyHostname(follow.hostname) : format === 'missing' ? 'none' : 'invalid',
    relation: source === 'none' || format === 'missing' ? 'none' : compareTargets(request, direct, follow),
    hasAutoLoginKey: usable && raw.includes('autoLoginKey'),
  });
}

module.exports = { diagnoseNavigation, sanitizeNavigationDiagnostic };
