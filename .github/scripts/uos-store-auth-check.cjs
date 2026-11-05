#!/usr/bin/env node
// ABOUTME: 只在内存中验证统信开发者会话和目标应用身份，输出固定的认证诊断。

'use strict';

const { UosStoreApiClient, describeUosAuthenticationFailure } = require('./uos-store-api-client.cjs');
const { authenticateUnionTechBrowser } = require('./uniontech-browser-authenticator.cjs');

const APP_ID = 'com.floatboat.desktop';

async function checkUosAuthentication({ client, credentials }) {
  await client.authenticate(credentials);
  await client.resolveApplicationRecord(APP_ID);
  return Object.freeze({ appid: APP_ID, status: 'ready' });
}

async function runAuthenticationCheck(options) {
  const log = options.log || console.log;
  const logError = options.error || console.error;
  try {
    const client = options.client || new UosStoreApiClient({
      baseUrl: 'https://appstore-dev.uniontech.com',
      identityAuthenticator: authenticateUnionTechBrowser,
    });
    await checkUosAuthentication({ client, credentials: options.credentials });
    log(`UOS authentication ready for ${APP_ID}`);
    return 0;
  } catch (error) {
    // 仅序列化统一诊断器返回的静态白名单，异常对象与平台记录不进入日志。
    const diagnostic = describeUosAuthenticationFailure(error);
    logError(`UOS authentication check failed: ${JSON.stringify(diagnostic)}`);
    return 1;
  }
}

async function main() {
  process.exitCode = await runAuthenticationCheck({
    credentials: { username: process.env.UOS_STORE_USERNAME, password: process.env.UOS_STORE_PASSWORD },
  });
}

if (require.main === module) void main();

module.exports = { checkUosAuthentication, runAuthenticationCheck };
