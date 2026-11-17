// ABOUTME: 用同版本 Electron Utility 执行最终安装包中的 CAM++ 入口，报告只保留验收元数据。
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MODEL = Object.freeze({
  sha256: 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11',
  bytes: 28_281_138,
  dimensions: 192,
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
});
const UTILITY_ENTRY = '.vite/build/speakerEmbeddingUtility.js';
const RUNTIME_VERSION = '2.0.1';

function validatePackagedConfiguration({ resources, sourceSha, platform, arch }) {
  assert.match(sourceSha || '', /^[a-f0-9]{40}$/u, 'SOURCE_SHA_REQUIRED');
  assert.ok((platform === 'darwin' && ['x64', 'arm64'].includes(arch)) || (platform === 'win32' && arch === 'x64'), 'UNSUPPORTED_TARGET');
  const root = path.resolve(resources);
  const text = fs.readFileSync(path.join(root, '.env'), 'utf8');
  const declarations = text.split(/\r?\n/u).filter((line) => /^\s*(?:export\s+)?AOE_SPEAKER_EMBEDDING_MODEL\s*=/u.test(line));
  assert.equal(declarations.length, 1, 'PACKAGED_MODEL_MUST_BE_UNAMBIGUOUS');
  assert.match(declarations[0], /^\s*(?:export\s+)?AOE_SPEAKER_EMBEDDING_MODEL\s*=\s*(?:campplus|'campplus'|"campplus")\s*(?:#.*)?$/u, 'PACKAGED_MODEL_MUST_BE_CAMPPLUS');
  const identity = JSON.parse(fs.readFileSync(path.join(root, 'evidence', 'build-identity.json'), 'utf8'));
  assert.equal(identity.buildSha, sourceSha, 'SOURCE_SHA_MISMATCH');
  assert.equal(identity.platform, platform, 'PACKAGE_PLATFORM_MISMATCH');
  assert.equal(identity.arch, arch, 'PACKAGE_ARCH_MISMATCH');
  assert.match(identity.electronVersion || '', /^\d+\.\d+\.\d+(?:[-+].+)?$/u, 'ELECTRON_VERSION_REQUIRED');
  assert.ok(fs.statSync(path.join(root, 'app.asar')).isFile(), 'APP_ASAR_REQUIRED');
  return { resources: root, identity };
}

function validateModelBytes(bytes) {
  assert.equal(bytes.length, MODEL.bytes, 'MODEL_SIZE_MISMATCH');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), MODEL.sha256, 'MODEL_SHA256_MISMATCH');
}

function validatePackagedVersion(packageVersion, identityAppVersion) {
  const match = /^(\d+\.\d+\.\d+)-test\.\d+$/u.exec(packageVersion);
  if (!match) throw new Error('PACKAGED_TEST_VERSION_REQUIRED');
  if (match[1] !== identityAppVersion) throw new Error('PACKAGE_IDENTITY_VERSION_MISMATCH');
  return packageVersion;
}

async function verifyBundledModel(resources) {
  const bundledDirectory = path.join(resources, 'speaker-models');
  const modelPath = path.join(bundledDirectory, `${MODEL.sha256}.onnx`);
  const bytes = await fsp.readFile(modelPath);
  validateModelBytes(bytes);
  return { bundledDirectory, modelPath };
}

// 此函数序列化到独立临时 host；不加载应用主入口，也不继承现有用户目录。
function electronHost(configuration) {
  const { app, utilityProcess } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const { createRequire } = require('node:module');
  let worker;
  let finished = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let packageVersion;
  const started = Date.now();
  const stages = [];
  const timer = setTimeout(() => finish(false, 'INFERENCE_TIMEOUT'), configuration.timeoutMs);
  function finish(passed, failure, result = {}) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    const report = {
      passed,
      evidence: 'same-version-electron-utility-with-packaged-entry',
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      sourceSha: configuration.sourceSha,
      packageVersion,
      model: 'campplus',
      modelSha256: configuration.model.sha256,
      modelBytes: configuration.model.bytes,
      utilityEntry: configuration.utilityEntry,
      runtimeVersion: configuration.runtimeVersion,
      elapsedMs: Date.now() - started,
      stdoutBytes,
      stderrBytes,
      networkGuardActive: configuration.offlineGuardActive === true,
      stages,
      ...result,
      ...(failure ? { failure } : {}),
    };
    fs.writeFileSync(configuration.hostReport, `${JSON.stringify(report, null, 2)}\n`);
    const leave = () => app.exit(passed ? 0 : 1);
    if (!worker?.pid) return leave();
    worker.once('exit', leave);
    worker.kill();
    setTimeout(leave, 3000);
  }
  process.once('SIGTERM', () => finish(false, 'HOST_TERMINATED'));
  process.once('uncaughtException', () => finish(false, 'HOST_UNCAUGHT_EXCEPTION'));
  process.once('unhandledRejection', () => finish(false, 'HOST_UNHANDLED_REJECTION'));
  app.setPath('userData', configuration.userData);
  app.setPath('sessionData', path.join(configuration.userData, 'session'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-background-networking');
  app.dock?.hide();
  app.whenReady().then(() => {
    if (process.platform !== configuration.platform || process.arch !== configuration.arch) return finish(false, 'HOST_TARGET_MISMATCH');
    if (process.versions.electron !== configuration.electronVersion) return finish(false, 'HOST_ELECTRON_VERSION_MISMATCH');
    const archive = fs.realpathSync(path.join(configuration.resources, 'app.asar'));
    // Forge 的身份清单记录基础版本，完整测试版本必须从实际 ASAR 内读取。
    const manifest = JSON.parse(fs.readFileSync(path.join(archive, 'package.json'), 'utf8'));
    try {
      packageVersion = validatePackagedVersion(manifest.version, configuration.identityAppVersion);
    } catch (error) {
      return finish(false, error.message);
    }
    const entry = path.join(archive, configuration.utilityEntry);
    if (!fs.existsSync(entry)) return finish(false, 'PACKAGED_UTILITY_MISSING');
    const resolver = createRequire(entry);
    const runtime = resolver.resolve('sherpa-onnx-node');
    const runtimeRelative = path.relative(archive, runtime).replaceAll('\\', '/');
    if (!runtimeRelative.startsWith('node_modules/sherpa-onnx-node/')) return finish(false, 'RUNTIME_RESOLVED_OUTSIDE_PACKAGE');
    const nativeName = `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
    const nativeRoot = path.join(configuration.resources, 'app.asar.unpacked', 'node_modules', nativeName);
    const nativeManifest = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'package.json'), 'utf8'));
    const wrapperManifest = resolver('sherpa-onnx-node/package.json');
    if (nativeManifest.name !== nativeName || nativeManifest.version !== configuration.runtimeVersion || wrapperManifest.version !== configuration.runtimeVersion) return finish(false, 'PACKAGED_RUNTIME_VERSION_MISMATCH');
    if (!fs.statSync(path.join(nativeRoot, 'sherpa-onnx.node')).isFile()) return finish(false, 'PACKAGED_NATIVE_BINDING_MISSING');
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    const bootstrap = path.join(configuration.userData, 'speaker-offline-bootstrap.cjs');
    fs.writeFileSync(bootstrap, `require(${JSON.stringify(configuration.offlineGuard)});\nprocess.argv = ${JSON.stringify([process.execPath, entry, configuration.cache, 'campplus', configuration.bundledDirectory])};\nrequire(${JSON.stringify(entry)});\n`);
    worker = utilityProcess.fork(bootstrap, [], {
      serviceName: 'Floatboat CAM++ Package Verification',
      stdio: 'pipe',
      cwd: configuration.userData,
      env: systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot } : {},
    });
    worker.stdout?.on('data', (chunk) => { stdoutBytes += chunk.length; });
    worker.stderr?.on('data', (chunk) => { stderrBytes += chunk.length; });
    worker.on('error', () => finish(false, 'UTILITY_PROCESS_ERROR'));
    worker.on('exit', (code) => { if (!finished) finish(false, `UTILITY_EXIT_${code}`); });
    worker.on('message', (message) => {
      if (message?.kind === 'speaker-package-offline-guard') {
        configuration.offlineGuardActive = message.active === true;
        return;
      }
      if (message?.kind === 'speaker-embedding-diagnostic') {
        const diagnostic = message.diagnostic;
        if (stages.length < 32 && diagnostic && typeof diagnostic.stage === 'string') {
          stages.push({ stage: diagnostic.stage, status: diagnostic.status, elapsedMs: diagnostic.elapsedMs });
        }
        return;
      }
      if (message?.id !== 1) return;
      if (message.error) return finish(false, 'PACKAGED_INFERENCE_FAILED', { diagnosticCode: String(message.failure?.code || message.error).slice(0, 160) });
      const values = message.result?.embedding;
      const key = message.result?.modelKey;
      const expectedKey = `campplus-zh-cn-16k:${configuration.model.sha256}:sherpa-onnx-${configuration.runtimeVersion}:fbank80-global-mean:l2:192:v1`;
      if (key !== expectedKey || !Array.isArray(values) || values.length !== configuration.model.dimensions || !values.every(Number.isFinite)) return finish(false, 'INFERENCE_CONTRACT_MISMATCH');
      const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
      if (Math.abs(norm - 1) > 0.001) return finish(false, 'EMBEDDING_NORMALIZATION_FAILED');
      if (!configuration.offlineGuardActive) return finish(false, 'OFFLINE_GUARD_NOT_ACTIVE');
      if (stages.some((stage) => stage.stage === 'download')) return finish(false, 'OFFLINE_PROBE_ATTEMPTED_DOWNLOAD');
      if (!stages.some((stage) => stage.stage === 'bundled-copy' && stage.status === 'completed')) return finish(false, 'BUNDLED_COPY_NOT_CONFIRMED');
      finish(true, undefined, { dimensions: values.length, bundledModelVerified: true, offlineInferenceVerified: true, emptyCacheAtStart: true, norm: Number(norm.toFixed(6)), runtimeEntry: runtimeRelative, nativePackage: nativeName });
    });
    worker.on('spawn', () => {
      // 合成信号只用于验证运行库和接口，不能当作真实说话人准确率证据。
      const pcm = new Float32Array(16_000 * 3);
      for (let i = 0; i < pcm.length; i++) {
        const t = i / 16_000;
        pcm[i] = (0.12 * Math.sin(2 * Math.PI * 173 * t) + 0.06 * Math.sin(2 * Math.PI * 347 * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 3 * t));
      }
      worker.postMessage({ id: 1, pcm });
    });
  }).catch(() => finish(false, 'PACKAGED_RUNTIME_RESOLUTION_FAILED'));
}

async function runVerification(options) {
  let scratch;
  const output = path.resolve(options.report);
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.rm(output, { force: true });
  try {
    const { resources, identity } = validatePackagedConfiguration(options);
    scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'floatboat-speaker-package-'));
    const hostReport = path.join(scratch, 'result.json');
    const cache = path.join(scratch, 'models');
    const userData = path.join(scratch, 'profile');
    await fsp.mkdir(userData);
    const { bundledDirectory } = await verifyBundledModel(resources);
    await fsp.mkdir(cache, { mode: 0o700 });
    assert.deepEqual(await fsp.readdir(cache), [], 'PROBE_CACHE_MUST_START_EMPTY');
    const offlineGuard = path.join(scratch, 'offline-guard.cjs');
    await fsp.writeFile(offlineGuard, `
'use strict';
const deny = () => { throw new Error('PACKAGED_SPEAKER_OFFLINE_NETWORK_BLOCKED'); };
globalThis.fetch = deny;
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = deny;
  module.get = deny;
}
const net = require('node:net');
net.connect = deny;
net.createConnection = deny;
const tls = require('node:tls');
tls.connect = deny;
require('node:module').syncBuiltinESMExports();
process.parentPort?.postMessage({ kind: 'speaker-package-offline-guard', active: true });
`);
    const configuration = {
      resources, sourceSha: options.sourceSha, platform: options.platform, arch: options.arch,
      electronVersion: identity.electronVersion, identityAppVersion: identity.appVersion, model: MODEL, runtimeVersion: RUNTIME_VERSION,
      utilityEntry: UTILITY_ENTRY, cache, userData, hostReport, bundledDirectory, offlineGuard, timeoutMs: 120_000,
    };
    const host = path.join(scratch, 'host.cjs');
    await fsp.writeFile(host, `${validatePackagedVersion.toString()}\n(${electronHost.toString()})(${JSON.stringify(configuration)});\n`);
    const env = { ...process.env };
    for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[name];
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(path.resolve(options.electron), [host], { cwd: scratch, env, stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ELECTRON_HOST_TIMEOUT')); }, configuration.timeoutMs + 15_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.ok(fs.existsSync(hostReport), 'ELECTRON_HOST_REPORT_MISSING');
    const report = JSON.parse(await fsp.readFile(hostReport, 'utf8'));
    report.sourceTreeDirty = identity.sourceTreeDirty;
    report.identityAppVersion = identity.appVersion;
    report.packagedConfigurationVerified = true;
    report.appAsarSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(resources, 'app.asar'))).digest('hex');
    report.passed = report.passed === true && exitCode === 0;
    await fsp.mkdir(path.dirname(path.resolve(options.report)), { recursive: true });
    await fsp.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
    assert.ok(report.passed, report.failure || 'PACKAGED_SPEAKER_VERIFICATION_FAILED');
    return report;
  } catch (error) {
    if (!fs.existsSync(output)) {
      await fsp.writeFile(output, `${JSON.stringify({
        passed: false, sourceSha: options.sourceSha, platform: options.platform, arch: options.arch,
        model: 'campplus', failure: String(error.message).slice(0, 512),
      }, null, 2)}\n`);
    }
    throw error;
  } finally {
    if (scratch) await fsp.rm(scratch, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const names = new Map([['resources', 'resources'], ['electron', 'electron'], ['source-sha', 'sourceSha'], ['platform', 'platform'], ['arch', 'arch'], ['report', 'report']]);
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = names.get(argv[i]?.replace(/^--/u, ''));
    assert.ok(argv[i]?.startsWith('--') && key && argv[i + 1] && !argv[i + 1].startsWith('--') && result[key] === undefined, 'INVALID_ARGUMENTS');
    result[key] = argv[i + 1];
  }
  for (const key of ['resources', 'electron', 'sourceSha', 'platform', 'arch', 'report']) assert.ok(result[key], `MISSING_${key.toUpperCase()}`);
  return result;
}

module.exports = { MODEL, RUNTIME_VERSION, validatePackagedConfiguration, validatePackagedVersion, validateModelBytes, verifyBundledModel, parseArguments, runVerification };
if (require.main === module) {
  Promise.resolve().then(() => runVerification(parseArguments(process.argv.slice(2))))
    .then((report) => console.log(`CAM++ packaged runtime verified: ${report.platform}/${report.arch}, ${report.dimensions} dimensions`))
    .catch((error) => { console.error(`CAM++ packaged runtime verification failed: ${error.message}`); process.exitCode = 1; });
}
