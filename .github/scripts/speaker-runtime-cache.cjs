// ABOUTME: 为声纹预编译依赖生成隔离的 pnpm store 缓存键，并在安装后验证平台库可实际加载。
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const SCHEMA = 1;
const SHERPA_LIBRARIES = {
  darwin: ['libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib'],
  win32: ['onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll'],
};

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function targetFrom(env, runtime = process) {
  const platform = env.TARGET_PLATFORM;
  const arch = env.TARGET_ARCH;
  if (!((platform === 'darwin' && ['arm64', 'x64'].includes(arch)) || (platform === 'win32' && arch === 'x64'))) {
    throw new Error(`声纹依赖缓存不支持 ${platform}/${arch}`);
  }
  if (runtime.platform !== platform || runtime.arch !== arch) throw new Error('声纹依赖缓存要求构建机与目标平台/架构一致');
  return { platform, arch };
}

function readPackage(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function recipeFiles(sourceRoot) {
  const files = {};
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
    const file = path.join(sourceRoot, name);
    if (fs.existsSync(file)) files[name] = hash(fs.readFileSync(file));
    else if (name === 'pnpm-lock.yaml') throw new Error('缺少 pnpm-lock.yaml，不能生成依赖缓存键');
  }
  function visit(relative) {
    const directory = path.join(sourceRoot, relative);
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) files[name] = hash(fs.readFileSync(path.join(sourceRoot, name)));
      else throw new Error(`依赖补丁必须为实体文件：${name}`);
    }
  }
  visit('patches');
  return files;
}

function createCacheKey({ sourceRoot = process.cwd(), env = process.env, runtime = process } = {}) {
  const target = targetFrom(env, runtime);
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(env.PNPM_VERSION || '')) throw new Error('缺少有效 PNPM_VERSION');
  if (!env.PNPM_STORE_PATH || !path.isAbsolute(env.PNPM_STORE_PATH)) throw new Error('PNPM_STORE_PATH 必须为绝对路径');
  const storePath = path.resolve(env.PNPM_STORE_PATH);
  if (storePath.split(path.sep).includes('node_modules') || storePath === path.resolve(sourceRoot)) {
    throw new Error('只允许缓存 pnpm store，不能缓存源码或 node_modules');
  }
  const pkg = readPackage(sourceRoot);
  const packageInputs = Object.fromEntries(['packageManager', 'dependencies', 'devDependencies', 'optionalDependencies', 'overrides', 'pnpm']
    .filter((key) => pkg[key] !== undefined).map((key) => [key, pkg[key]]));
  const inputs = stable({
    schema: SCHEMA, ...target, node: runtime.version, nodeAbi: runtime.versions.modules,
    pnpm: env.PNPM_VERSION, package: packageInputs, files: recipeFiles(sourceRoot),
  });
  return { key: `speaker-pnpm-v${SCHEMA}-${target.platform}-${target.arch}-${hash(JSON.stringify(inputs))}`, store_path: storePath };
}

function requireFiles(root, names) {
  for (const name of names) {
    const file = path.join(root, name);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) throw new Error(`声纹依赖文件缺失或为空：${file}`);
  }
}

function verifyLicense(root, pkg, expected) {
  if (pkg.license !== expected) throw new Error(`声纹依赖许可证声明不匹配：${pkg.name}`);
  // 上游 npm 包只保证 package.json 的许可证声明；有附带文本时仍必须完整。
  const notices = fs.readdirSync(root).filter((name) => /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\.|$)/i.test(name));
  requireFiles(root, notices);
}

function packageAt(request, name, expectedVersion, expectedLicense) {
  let root;
  try {
    root = path.dirname(request.resolve(`${name}/package.json`));
  } catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    // onnxruntime-common 通过 exports 隐藏 package.json；从公开入口定位所属包，不绕过加载契约。
    root = path.dirname(request.resolve(name));
    while (!fs.existsSync(path.join(root, 'package.json')) || readPackage(root).name !== name) {
      const parent = path.dirname(root);
      if (parent === root) throw new Error(`无法定位依赖清单：${name}`);
      root = parent;
    }
  }
  const pkg = readPackage(root);
  if (pkg.name !== name || pkg.version !== expectedVersion) throw new Error(`声纹依赖版本不匹配：${name}，期望 ${expectedVersion}`);
  verifyLicense(root, pkg, expectedLicense);
  return { root, pkg };
}

function runNativeCheck({ modulePath, requiredExport = '' }) {
  // 两种引擎含同名但不同版本的 onnxruntime.dll，必须分别在全新进程验证，避免 DLL 已加载状态相互污染。
  const script = 'const api = require(process.argv[1]); const name = process.argv[2]; if (name && typeof api[name] !== "function") throw new Error("Missing required export: " + name);';
  try {
    execFileSync(process.execPath, ['-e', script, modulePath, requiredExport], {
      windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
      encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    const reason = String(error.stderr || error.code || error.signal || `exit ${error.status}`).trim().slice(0, 1200);
    throw new Error(`声纹原生库独立加载失败 (${path.basename(modulePath)}): ${reason}`);
  }
}

function verifyInstalled({ sourceRoot = process.cwd(), env = process.env, runtime = process, nativeCheck = runNativeCheck, log = console.log } = {}) {
  const { platform, arch } = targetFrom(env, runtime);
  const source = readPackage(sourceRoot);
  const dependencies = { ...source.devDependencies, ...source.dependencies, ...source.optionalDependencies };
  const request = createRequire(path.join(sourceRoot, 'package.json'));
  const verified = [];
  if (dependencies['sherpa-onnx-node']) {
    const wrapper = packageAt(request, 'sherpa-onnx-node', dependencies['sherpa-onnx-node'], 'Apache-2.0');
    const nativeName = `sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${arch}`;
    if (wrapper.pkg.optionalDependencies?.[nativeName] !== wrapper.pkg.version) throw new Error('Sherpa wrapper 与目标平台库版本不一致');
    const native = packageAt(createRequire(path.join(wrapper.root, 'package.json')), nativeName, wrapper.pkg.version, 'Apache-2.0');
    if (!native.pkg.os?.includes(platform) || !native.pkg.cpu?.includes(arch)) throw new Error(`Sherpa 平台声明不匹配：${nativeName}`);
    requireFiles(wrapper.root, ['sherpa-onnx.js', 'addon.js', 'speaker-identification.js']);
    requireFiles(native.root, ['index.js', 'sherpa-onnx.node', ...SHERPA_LIBRARIES[platform]]);
    nativeCheck({ modulePath: request.resolve('sherpa-onnx-node'), requiredExport: 'SpeakerEmbeddingExtractor' });
    verified.push(`sherpa-onnx-node@${wrapper.pkg.version}`);
  } else log('[Speaker Runtime Cache] 当前源码未声明 Sherpa，跳过该组件验证');

  if (dependencies['onnxruntime-node']) {
    const onnx = packageAt(request, 'onnxruntime-node', dependencies['onnxruntime-node'], 'MIT');
    const onnxRequire = createRequire(path.join(onnx.root, 'package.json'));
    packageAt(onnxRequire, 'onnxruntime-common', onnx.pkg.version, 'MIT');
    if (!onnx.pkg.os?.includes(platform)) throw new Error('ONNX 平台声明不匹配');
    const native = path.join(onnx.root, 'bin', 'napi-v3', platform, arch);
    const libraries = platform === 'darwin' ? [`libonnxruntime.${onnx.pkg.version}.dylib`] : ['onnxruntime.dll', 'DirectML.dll'];
    requireFiles(native, ['onnxruntime_binding.node', ...libraries]);
    requireFiles(onnx.root, ['dist/index.js']);
    // ONNX JS 入口可能延迟加载；直接打开目标 binding 才能暴露缺 DLL 或 ABI 不兼容。
    nativeCheck({ modulePath: path.join(native, 'onnxruntime_binding.node') });
    verified.push(`onnxruntime-node@${onnx.pkg.version}`);
  } else log('[Speaker Runtime Cache] 当前源码未声明 ONNX，跳过该组件验证');
  log(`[Speaker Runtime Cache] ${platform}/${arch} 验证通过：${verified.join(', ') || '无声明组件'}`);
  return verified;
}

function main(command, options = {}) {
  if (command === 'verify') return verifyInstalled(options);
  if (command !== 'key') throw new Error('用法：speaker-runtime-cache.cjs key|verify');
  const env = options.env || process.env;
  const values = createCacheKey(options);
  const lines = Object.entries(values).map(([key, value]) => {
    if (/[\r\n]/.test(value)) throw new Error('声纹依赖缓存输出不能包含换行');
    return `${key}=${value}\n`;
  }).join('');
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
  return values;
}

module.exports = { SHERPA_LIBRARIES, createCacheKey, verifyInstalled, runNativeCheck, main };

if (require.main === module) {
  try { main(process.argv[2]); } catch (error) {
    console.error(`[Speaker Runtime Cache] ${error.message}`);
    process.exitCode = 1;
  }
}
