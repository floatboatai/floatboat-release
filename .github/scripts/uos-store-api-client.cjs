#!/usr/bin/env node
// ABOUTME: 集中封装统信开发平台公开前端所使用的包检测、分片上传和提交契约。

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const UOS_STORE_CONTRACT = Object.freeze({
  basePath: '/devprod-api',
  detectPrefixBytes: 400 * 1024,
  uploadChunkBytes: 5 * 1024 * 1024,
  uploadType: 'temppkg',
  submitOperateType: 52,
  draftOperateType: -99,
  endpoints: Object.freeze({
    loginPath: '/store-dev-auth/getLoginPath',
    loginCallback: '/store-dev-auth/login',
    developerInfo: '/store-dev-auth/dev_info',
    applications: '/store-dev-app/app',
    applicationHistory: (appId) => `/store-dev-app/app/${encodeURIComponent(appId)}/history`,
    versionDetail: (id) => `/store-dev-app/app/${encodeURIComponent(id)}/detail`,
    auditStatus: (id) => `/store-dev-app/app/${encodeURIComponent(id)}/audit_status`,
    detectPackage: '/store-dev-pkg-proceses/detect-pkg-info',
    uploadBegin: '/store-file/upload/begin',
    uploadEnd: '/store-file/upload/end',
    submitApplication: '/store-dev-app/app',
  }),
});
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 100;
const MAX_LIST_RECORDS = LIST_PAGE_SIZE * MAX_LIST_PAGES;
const APPLICATION_STATUS = Object.freeze({
  '-99': 'draft',
  0: 'rejected',
  1: 'manual-action-required',
  '-2': 'manual-action-required',
  52: 'submitted',
  54: 'approved',
  101: 'approved',
  103: 'manual-action-required',
  500: 'rejected',
  501: 'rejected',
  502: 'rejected',
});

class UosStoreApiError extends Error {
  constructor(code, message, options = {}) {
    super(`${code}: ${message}`);
    this.name = 'UosStoreApiError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.outcomeUnknown = Boolean(options.outcomeUnknown);
  }
}

function digest(algorithm, value) {
  return crypto.createHash(algorithm).update(value).digest('hex');
}

function redactMessage(value, sensitiveValues = []) {
  let output = String(value || '')
    .replace(/(authorization|cookie|set-cookie|password|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
      try {
        const url = new URL(candidate);
        const sensitive = [...url.searchParams.keys()].some((key) => /^(token|signature|x-(?:amz|goog)-)/iu.test(key));
        return sensitive ? '[REDACTED_URL]' : candidate;
      } catch {
        return '[REDACTED_URL]';
      }
    });
  for (const sensitive of sensitiveValues) {
    if (typeof sensitive === 'string' && sensitive.length >= 4) output = output.split(sensitive).join('[REDACTED]');
  }
  return output.slice(0, 1000);
}

function normalizeEnvelope(payload, operation) {
  if (!payload || typeof payload !== 'object') {
    throw new UosStoreApiError('UOS_STORE_RESPONSE_INVALID', `${operation} 返回非对象`);
  }
  const status = Number(payload.status ?? payload.code);
  if (status !== 200) {
    const description = String(payload.desc ?? payload.message ?? `${operation} failed`);
    if (/captcha|verify|验证码|mfa|二次验证|扫码|登录/iu.test(description)) {
      throw new UosStoreApiError('UOS_AUTH_INTERACTION_REQUIRED', `${operation} 需要人工认证`);
    }
    throw new UosStoreApiError('UOS_STORE_REQUEST_REJECTED', `${operation} 被统信平台拒绝`);
  }
  return payload.datas ?? payload.data ?? payload;
}

function collectPackageRows(value, rows = []) {
  if (!value || typeof value !== 'object') return rows;
  if (Array.isArray(value)) {
    for (const item of value) collectPackageRows(item, rows);
    return rows;
  }
  if (typeof value.pkg_version === 'string' && typeof value.sha256 === 'string') rows.push(value);
  for (const item of Object.values(value)) collectPackageRows(item, rows);
  return rows;
}

function collectApplicationRecords(value, appid, records = new Map()) {
  if (!value || typeof value !== 'object') return records;
  if (Array.isArray(value)) {
    for (const item of value) collectApplicationRecords(item, appid, records);
    return records;
  }
  if (value.pkg_name === appid && ('app_id' in value || 'id' in value)) {
    records.set(`${String(value.app_id ?? '')}:${String(value.id ?? '')}`, value);
  }
  for (const item of Object.values(value)) collectApplicationRecords(item, appid, records);
  return records;
}

function classifyStatusText(value) {
  const status = String(value ?? '').trim();
  if (!status) return 'unknown';
  if (/下架待审核|老版本下线|已下架|^下架$|delist|offline/iu.test(status)) return 'manual-action-required';
  if (/驳回|拒绝|未通过|不通过|审核失败|上架失败|上传失败|推仓失败|撤销|rejected|failed|revoked|withdrawn/iu.test(status)) return 'rejected';
  if (/审核通过|已上架|^上架$|上架中|通过审核|approved|published|passed/iu.test(status)) return 'approved';
  if (/审核中|待审核|已提交|under.?review|pending.?review|submitted/iu.test(status)) return 'submitted';
  if (/草稿|未提交|draft/iu.test(status)) return 'draft';
  return 'unknown';
}

function collectNamedAuditStates(value, states = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return states;
  if (Array.isArray(value)) {
    for (const item of value) collectNamedAuditStates(item, states, depth + 1);
    return states;
  }
  for (const [key, field] of Object.entries(value)) {
    if (/^(audit_status|auditStatus|review_status|reviewStatus|status_name|statusName|status_str|statusStr)$/u.test(key)) {
      if (field && typeof field === 'object') collectNamedAuditStates(field, states, depth + 1);
      else {
        const state = classifyStatusText(field);
        if (state !== 'unknown') states.push(state);
      }
    } else if (field && typeof field === 'object') {
      collectNamedAuditStates(field, states, depth + 1);
    }
  }
  return states;
}

function classifyAuditStatus(value) {
  const states = new Set(collectNamedAuditStates(value));
  return states.size === 1 ? [...states][0] : 'unknown';
}

function classifyPublicationStatus(versionRecord, audit) {
  const versionStates = new Set();
  const rawStatus = versionRecord?.status;
  const numericStatus = typeof rawStatus === 'number'
    ? rawStatus
    : typeof rawStatus === 'string' && /^-?\d+$/u.test(rawStatus.trim())
      ? Number(rawStatus)
      : null;
  const numericState = Number.isSafeInteger(numericStatus) ? APPLICATION_STATUS[String(numericStatus)] : undefined;
  if (numericState) versionStates.add(numericState);
  const textualVersionState = classifyAuditStatus(versionRecord);
  if (textualVersionState !== 'unknown') versionStates.add(textualVersionState);
  if (versionStates.size > 1) return 'unknown';
  const versionState = versionStates.size === 1 ? [...versionStates][0] : 'unknown';
  const auditState = classifyAuditStatus(audit);
  if (versionState !== 'unknown' && auditState !== 'unknown' && versionState !== auditState) return 'unknown';
  return versionState !== 'unknown' ? versionState : auditState;
}

function collectHistoryVersionRecords(value, packageVersion, records = new Map()) {
  if (!value || typeof value !== 'object') return records;
  if (Array.isArray(value)) {
    for (const item of value) collectHistoryVersionRecords(item, packageVersion, records);
    return records;
  }
  const packageKeys = ['app_origin_pkgs', 'packages', 'pkg_list', 'package_list'];
  const version = value.pkg_version ?? value.version ?? value.app_version;
  if (version === packageVersion) {
    const hasId = typeof value.id === 'string' || typeof value.id === 'number';
    records.set(hasId ? String(value.id) : `__missing_version_id_${records.size}`, value);
  }
  for (const [key, item] of Object.entries(value)) {
    if (!packageKeys.includes(key)) collectHistoryVersionRecords(item, packageVersion, records);
  }
  return records;
}

function collectPackageVersions(value, versions = []) {
  if (!value || typeof value !== 'object') return versions;
  if (Array.isArray(value)) {
    for (const item of value) collectPackageVersions(item, versions);
    return versions;
  }
  for (const key of ['pkg_version', 'version', 'app_version']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && /^\d+\.\d+\.\d+\.\d+$/u.test(candidate)) versions.push(candidate);
  }
  for (const item of Object.values(value)) collectPackageVersions(item, versions);
  return versions;
}

function comparePackageVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 4; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

class UosStoreApiClient {
  constructor(options) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(baseUrl.hostname))) {
      throw new UosStoreApiError('UOS_STORE_CONFIGURATION_INVALID', '统信 API 必须使用 HTTPS');
    }
    this.baseUrl = new URL(UOS_STORE_CONTRACT.basePath.replace(/^\//u, ''), `${baseUrl.origin}/`);
    this.fetch = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new UosStoreApiError('UOS_STORE_CONFIGURATION_INVALID', '缺少 fetch');
    this.identityAuthenticator = options.identityAuthenticator || null;
    this.cookies = new Map();
    this.sensitiveValues = [];
  }

  async authenticate(credentials) {
    const username = String(credentials.username || '').trim();
    const password = String(credentials.password || '');
    if (!username || !password) throw new UosStoreApiError('UOS_STORE_CREDENTIALS_MISSING', '缺少 UOS_STORE_USERNAME 或 UOS_STORE_PASSWORD');
    this.sensitiveValues.push(username, password);

    const discovered = await this.requestJson('GET', UOS_STORE_CONTRACT.endpoints.loginPath, undefined, '发现统信登录入口');
    const rawLoginUrl = typeof discovered === 'string' ? discovered : discovered?.login_url ?? discovered?.loginUrl;
    let loginUrl;
    try {
      loginUrl = new URL(rawLoginUrl);
    } catch {
      throw new UosStoreApiError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信登录入口不是有效 URL');
    }
    if (loginUrl.origin !== 'https://login.uniontech.com') {
      throw new UosStoreApiError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信登录入口不属于受信 Identity 域名');
    }
    if (typeof this.identityAuthenticator !== 'function') {
      throw new UosStoreApiError(
        'UOS_AUTH_INTERACTION_REQUIRED',
        '统信 Identity 使用 OAuth 与验证码能力，真实联调前不允许把账号密码直接提交到回调接口',
      );
    }

    let callback;
    try {
      callback = await this.identityAuthenticator({ loginUrl: loginUrl.href, username, password, fetchImpl: this.fetch });
    } catch (error) {
      if (error instanceof UosStoreApiError) throw error;
      if (typeof error?.code === 'string' && error.code.startsWith('UOS_')) {
        throw new UosStoreApiError(error.code, '统信 Identity 未能建立自动化会话', { retryable: error.retryable });
      }
      throw new UosStoreApiError('UOS_AUTH_FAILED', '统信 Identity 未能建立自动化会话', { retryable: true });
    }
    const expectedState = loginUrl.searchParams.get('state');
    if (!callback || typeof callback.code !== 'string' || !callback.code || callback.code.length > 4096 ||
        typeof callback.state !== 'string' || !callback.state || callback.state.length > 2048 ||
        !expectedState || callback.state !== expectedState) {
      throw new UosStoreApiError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信 Identity 未返回有效 code/state');
    }
    await this.requestJson('POST', UOS_STORE_CONTRACT.endpoints.loginCallback, callback, '完成统信商店登录');
    if (!this.cookies.has('access-token')) {
      throw new UosStoreApiError('UOS_AUTH_FAILED', '统信商店回调未建立短期会话');
    }
    const developer = await this.requestJson('GET', UOS_STORE_CONTRACT.endpoints.developerInfo, undefined, '验证统信开发者会话');
    if (!developer || typeof developer !== 'object' || developer.dev_type === undefined) {
      throw new UosStoreApiError('UOS_AUTH_CONTRACT_UNVERIFIED', '统信开发者会话身份无法确认');
    }
    if ([2, 3, '2', '3'].includes(developer.dev_type)) {
      throw new UosStoreApiError('UOS_AUTH_INTERACTION_REQUIRED', '统信开发者账号需要人工完成身份选择或认证');
    }
  }

  async getApplicationTemplate(versionId) {
    if (!versionId) throw new UosStoreApiError('UOS_STORE_CONFIGURATION_INVALID', '缺少统信应用版本 ID');
    return this.getVersionDetail(versionId);
  }

  async resolveApplicationRecord(appid) {
    const applications = await this.listApplications();
    const records = [...collectApplicationRecords(applications, appid).values()];
    if (records.length !== 1) {
      throw new UosStoreApiError(
        'UOS_APPLICATION_IDENTITY_UNCONFIRMED',
        records.length === 0 ? `未找到 ${appid}` : `${appid} 匹配到多个应用记录`,
      );
    }
    const record = records[0];
    if ((typeof record.app_id !== 'string' && typeof record.app_id !== 'number') ||
        (typeof record.id !== 'string' && typeof record.id !== 'number')) {
      throw new UosStoreApiError('UOS_APPLICATION_IDENTITY_UNCONFIRMED', `${appid} 缺少 app_id 或当前版本 id`);
    }
    return Object.freeze({ appId: String(record.app_id), currentVersionId: String(record.id), record });
  }

  async listApplications() {
    const records = [];
    const applicationIds = new Set();
    const versionIds = new Set();
    let expectedTotal = null;
    for (let pageNum = 1; pageNum <= MAX_LIST_PAGES; pageNum += 1) {
      const query = new URLSearchParams({ pageNum: String(pageNum), pageSize: String(LIST_PAGE_SIZE) });
      const page = await this.requestJson(
        'GET',
        `${UOS_STORE_CONTRACT.endpoints.applications}?${query}`,
        undefined,
        '查询已有应用',
      );
      const total = Number(page?.total);
      if (!page || !Array.isArray(page.rows) || !Number.isSafeInteger(total) || total < 0 || total > MAX_LIST_RECORDS ||
          page.rows.length > LIST_PAGE_SIZE) {
        throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '应用列表分页响应无效');
      }
      if (expectedTotal === null) expectedTotal = total;
      if (total !== expectedTotal) {
        throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '读取应用列表期间总数发生变化');
      }
      for (const record of page.rows) {
        if (!record || typeof record !== 'object' || typeof record.pkg_name !== 'string' || !record.pkg_name ||
            (typeof record.app_id !== 'string' && typeof record.app_id !== 'number') || String(record.app_id).trim() === '' ||
            (typeof record.id !== 'string' && typeof record.id !== 'number') || String(record.id).trim() === '') {
          throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '应用列表包含无法确认的应用身份');
        }
        const applicationId = String(record.app_id);
        const versionId = String(record.id);
        if (applicationIds.has(applicationId) || versionIds.has(versionId)) {
          throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '应用列表包含重复应用或版本身份');
        }
        applicationIds.add(applicationId);
        versionIds.add(versionId);
        records.push(record);
      }
      if (records.length === expectedTotal) return Object.freeze(records);
      if (records.length > expectedTotal || page.rows.length === 0) {
        throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '应用列表分页不完整');
      }
    }
    throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '应用列表超过安全分页上限');
  }

  async getVersionDetail(versionId) {
    return this.requestJson('GET', UOS_STORE_CONTRACT.endpoints.versionDetail(versionId), undefined, '读取版本详情');
  }

  async listApplicationHistory(applicationId) {
    const records = [];
    const recordIds = new Set();
    let expectedTotal = null;
    for (let pageNum = 1; pageNum <= MAX_LIST_PAGES; pageNum += 1) {
      const query = new URLSearchParams({ pageNum: String(pageNum), pageSize: String(LIST_PAGE_SIZE) });
      const page = await this.requestJson(
        'GET',
        `${UOS_STORE_CONTRACT.endpoints.applicationHistory(applicationId)}?${query}`,
        undefined,
        '读取应用版本历史',
      );
      const total = Number(page?.total);
      if (!page || !Array.isArray(page.rows) || !Number.isSafeInteger(total) || total < 0 || total > MAX_LIST_RECORDS ||
          page.rows.length > LIST_PAGE_SIZE) {
        throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '应用版本历史分页响应无效');
      }
      if (expectedTotal === null) expectedTotal = total;
      if (total !== expectedTotal) {
        throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '读取应用版本历史期间总数发生变化');
      }
      for (const record of page.rows) {
        if (!record || typeof record !== 'object' ||
            (typeof record.id !== 'string' && typeof record.id !== 'number') || String(record.id).trim() === '' ||
            (record.app_id !== undefined && String(record.app_id) !== String(applicationId))) {
          throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '应用版本历史包含无法确认的版本身份');
        }
        const recordId = String(record.id);
        if (recordIds.has(recordId)) {
          throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '应用版本历史包含重复版本身份');
        }
        recordIds.add(recordId);
        records.push(record);
      }
      if (records.length === expectedTotal) return Object.freeze(records);
      if (records.length > expectedTotal || page.rows.length === 0) {
        throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '应用版本历史分页不完整');
      }
    }
    throw new UosStoreApiError('UOS_REMOTE_STATE_UNCONFIRMED', '应用版本历史超过安全分页上限');
  }

  async inspectPublication(applicationId, manifest) {
    const history = await this.listApplicationHistory(applicationId);
    const highestVersion = collectPackageVersions(history).sort(comparePackageVersions).at(-1) || null;
    if (highestVersion && comparePackageVersions(manifest.packageVersion, highestVersion) < 0) {
      return Object.freeze({ state: 'version-regression', history, highestVersion });
    }
    const versions = [...collectHistoryVersionRecords(history, manifest.packageVersion).entries()];
    if (versions.length === 0) return Object.freeze({ state: 'absent', history });
    if (versions.length !== 1) return Object.freeze({ state: 'conflict', history });
    const [versionId, versionRecord] = versions[0];
    if (versionId.startsWith('__missing_version_id_')) {
      return Object.freeze({ state: 'unconfirmed', history, versionRecord });
    }
    if (versionRecord.app_id !== undefined && String(versionRecord.app_id) !== String(applicationId)) {
      return Object.freeze({ state: 'conflict', history, versionRecord });
    }
    const detail = await this.getVersionDetail(versionId);
    const detailRoot = detail?.app_info ? detail : detail?.datas?.app_info ? detail.datas : null;
    if (!detailRoot || detailRoot.app_info?.app_basic_info?.app_id !== manifest.appid) {
      return Object.freeze({ state: 'conflict', history, versionId, versionRecord });
    }
    const audit = await this.requestJson('GET', UOS_STORE_CONTRACT.endpoints.auditStatus(versionId), undefined, '读取审核状态');
    const rows = collectPackageRows(detailRoot.app_info.app_origin_pkgs).filter((row) => row.pkg_version === manifest.packageVersion);
    const expected = new Map(manifest.packages.map((item) => [item.arch, item.sha256]));
    const observed = new Map();
    for (const row of rows) {
      const arch = normalizeRemoteArch(row.pkg_arch ?? row.pkgArch);
      if (!arch || observed.has(arch)) return Object.freeze({ state: 'conflict', audit, history });
      const hash = String(row.sha256).toLowerCase();
      if (expected.get(arch) !== hash) return Object.freeze({ state: 'conflict', audit, history });
      observed.set(arch, hash);
    }
    const reusablePackages = rows.filter((row) => {
      const arch = normalizeRemoteArch(row.pkg_arch ?? row.pkgArch);
      return arch && expected.get(arch) === String(row.sha256).toLowerCase() && typeof row.file_save_key === 'string';
    });
    const auditState = classifyPublicationStatus(versionRecord, audit);
    if (auditState === 'rejected' || auditState === 'manual-action-required') {
      return Object.freeze({ state: 'manual-action-required', audit, versionId, versionRecord });
    }
    if (auditState === 'unknown') return Object.freeze({ state: 'unconfirmed', audit, versionId, versionRecord });
    if ((auditState === 'submitted' || auditState === 'approved') && observed.size === 2) {
      return Object.freeze({ state: 'submitted', audit, versionId, versionRecord });
    }
    if (auditState === 'submitted' || auditState === 'approved') {
      return Object.freeze({ state: 'unconfirmed', audit, versionId, versionRecord });
    }
    return Object.freeze({
      state: observed.size === 0 ? 'unconfirmed' : observed.size === 2 ? 'uploaded' : 'partial-uploaded',
      audit,
      versionId,
      versionRecord,
      packages: Object.freeze(reusablePackages),
    });
  }

  async detectPackage(filePath) {
    const handle = fs.openSync(filePath, 'r');
    let prefix;
    try {
      const size = fs.fstatSync(handle).size;
      prefix = Buffer.alloc(Math.min(UOS_STORE_CONTRACT.detectPrefixBytes, size));
      fs.readSync(handle, prefix, 0, prefix.length, 0);
    } finally {
      fs.closeSync(handle);
    }
    const query = new URLSearchParams({ fileName: filePath.split(/[\\/]/u).pop(), pkgInstallMode: '1' });
    return this.requestJson(
      'POST',
      `${UOS_STORE_CONTRACT.endpoints.detectPackage}?${query}`,
      prefix,
      '检测安装包',
      { 'content-type': 'application/octet-stream' },
    );
  }

  async uploadPackage(filePath) {
    const file = fs.readFileSync(filePath);
    const chunks = [];
    for (let offset = 0; offset < file.length; offset += UOS_STORE_CONTRACT.uploadChunkBytes) {
      const data = file.subarray(offset, Math.min(offset + UOS_STORE_CONTRACT.uploadChunkBytes, file.length));
      chunks.push(Object.freeze({ data, hash: digest('md5', data), size: data.length }));
    }
    const begin = await this.requestJson('POST', UOS_STORE_CONTRACT.endpoints.uploadBegin, {
      uploadType: UOS_STORE_CONTRACT.uploadType,
      chunks: chunks.map(({ hash, size }) => ({ hash, size })),
      fileName: filePath.split(/[\\/]/u).pop(),
    }, '开始分片上传');
    const uploadInfos = begin.upload_infos;
    if (!Array.isArray(uploadInfos) || uploadInfos.length !== chunks.length) {
      throw new UosStoreApiError('UOS_UPLOAD_CONTRACT_MISMATCH', '分片上传 URL 数量不匹配');
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const uploadUrl = uploadInfos[index]?.upload_url;
      await this.putChunk(uploadUrl, chunks[index].data);
    }
    const result = await this.requestJson('POST', UOS_STORE_CONTRACT.endpoints.uploadEnd, {
      chunks: chunks.map(({ hash }) => hash),
      hash: digest('md5', file),
      file_upload_record_id: begin.id,
      size: file.length,
      upload_id: begin.upload_id,
      file_save_key: begin.file_save_key,
      status: 2,
    }, '完成分片上传');
    return Object.freeze({ ...result, file_save_key: result.file_save_key || begin.file_save_key });
  }

  prepareSubmission(template, packages) {
    const root = template?.app_info ? template : template?.datas?.app_info ? template.datas : null;
    if (!root || !root.app_info || typeof root.app_info !== 'object') {
      throw new UosStoreApiError('UOS_SUBMISSION_TEMPLATE_INVALID', '只读详情未返回 app_info 模板');
    }
    const cloned = structuredClone(root.app_info);
    const basic = cloned.app_basic_info;
    if (!basic || basic.app_id !== 'com.floatboat.desktop') {
      throw new UosStoreApiError('UOS_SUBMISSION_TEMPLATE_INVALID', '应用模板不是 com.floatboat.desktop');
    }
    cloned.app_origin_pkgs = packages.map((item) => ({ ...item }));
    return Object.freeze({ operate_type: UOS_STORE_CONTRACT.submitOperateType, app_info: cloned });
  }

  async submitApplication(payload) {
    try {
      return await this.requestJson('POST', UOS_STORE_CONTRACT.endpoints.submitApplication, payload, '提交审核');
    } catch (error) {
      if (error instanceof UosStoreApiError && error.retryable) {
        throw new UosStoreApiError('UOS_SUBMISSION_OUTCOME_UNKNOWN', '提交响应不确定，必须先回读审核状态', {
          retryable: true,
          outcomeUnknown: true,
        });
      }
      throw error;
    }
  }

  async putChunk(rawUrl, data) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new UosStoreApiError('UOS_UPLOAD_CONTRACT_MISMATCH', '分片上传 URL 无效');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new UosStoreApiError('UOS_UPLOAD_CONTRACT_MISMATCH', '分片上传 URL 必须使用 HTTPS');
    }
    let response;
    try {
      response = await this.fetch(url, {
        method: 'PUT',
        redirect: 'error',
        headers: { 'content-type': 'application/octet-stream' },
        body: data,
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new UosStoreApiError('UOS_UPLOAD_FAILED', '分片上传网络失败', { retryable: true });
    }
    if (!response.ok) throw new UosStoreApiError('UOS_UPLOAD_FAILED', `分片上传失败 HTTP ${response.status}`, { retryable: true });
  }

  async requestJson(method, endpoint, body, operation, extraHeaders = {}) {
    const headers = { accept: 'application/json', ...extraHeaders };
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    let encodedBody = body;
    if (body !== undefined && !Buffer.isBuffer(body)) {
      headers['content-type'] = 'application/json;charset=utf-8';
      encodedBody = JSON.stringify(body);
    }
    let response;
    try {
      response = await this.fetch(this.resolve(endpoint), {
        method,
        redirect: 'manual',
        headers,
        body: encodedBody,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new UosStoreApiError('UOS_STORE_NETWORK_FAILED', redactMessage(error.message, this.sensitiveValues), { retryable: true });
    }
    this.captureCookies(response.headers);
    if (response.status >= 300 && response.status < 400) {
      throw new UosStoreApiError('UOS_AUTH_INTERACTION_REQUIRED', `${operation} 被重定向到交互登录`);
    }
    const payload = await this.readJson(response, operation);
    if (!response.ok) {
      throw new UosStoreApiError('UOS_STORE_HTTP_FAILED', `${operation} HTTP ${response.status}`, {
        retryable: response.status >= 500 || response.status === 408 || response.status === 429,
      });
    }
    return normalizeEnvelope(payload, operation);
  }

  async readJson(response, operation) {
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new UosStoreApiError('UOS_STORE_RESPONSE_INVALID', `${operation} 响应过大`);
    try {
      return JSON.parse(text);
    } catch {
      throw new UosStoreApiError('UOS_AUTH_INTERACTION_REQUIRED', `${operation} 返回非 JSON，可能需要交互认证`);
    }
  }

  captureCookies(headers) {
    const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
    for (const value of values) {
      const pair = value.split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (name && cookieValue) {
        this.cookies.set(name, cookieValue);
        this.sensitiveValues.push(cookieValue);
      }
    }
  }

  resolve(endpoint) {
    const relative = endpoint.replace(/^\//u, '');
    return new URL(relative, `${this.baseUrl.href.replace(/\/$/u, '')}/`);
  }
}

function normalizeRemoteArch(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['amd64', 'x86_64', 'x86-64', '0'].includes(normalized)) return 'amd64';
  if (['arm64', 'aarch64', 'arm', '3'].includes(normalized)) return 'arm64';
  return null;
}

module.exports = {
  UOS_STORE_CONTRACT,
  UosStoreApiClient,
  UosStoreApiError,
  collectApplicationRecords,
  collectHistoryVersionRecords,
  collectPackageRows,
  classifyAuditStatus,
  classifyPublicationStatus,
  digest,
  normalizeEnvelope,
  normalizeRemoteArch,
  redactMessage,
};
