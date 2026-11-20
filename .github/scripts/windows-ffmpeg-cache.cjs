// ABOUTME: 按源码配方和 MinGW 工具链缓存 Windows FFmpeg 成品，复用前校验完整性与可执行性。
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const SCHEMA = 1;
const MANIFEST = 'ffmpeg-cache.json';
const RECIPE_FILES = [
  'scripts/bundle-ffmpeg.mjs',
  'scripts/build-windows-ffmpeg.mjs',
  'scripts/runtime-toolchain/build-ffmpeg.sh',
  'scripts/packaging/bundledToolDownload.mjs',
];
const BUNDLE_FILES = [
  'bin/ffmpeg.exe',
  'bin/ffprobe.exe',
  'licenses/COPYING.LGPLv2.1',
  'licenses/LICENSE.md',
];
const COMPILER_ENVIRONMENT = [
  'CFLAGS', 'CPPFLAGS', 'CXXFLAGS', 'LDFLAGS', 'CC', 'CPP', 'CXX', 'LD', 'AS', 'AR', 'NM', 'RANLIB', 'STRIP', 'WINDRES',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function execute(command, args, env = process.env) {
  return execFileSync(command, args, {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, LANG: 'C', LC_ALL: 'C' },
  }).trim();
}

function cacheKey(inputs) {
  return `ffmpeg-v${SCHEMA}-win32-x64-${sha256(JSON.stringify(inputs))}`;
}

async function createMetadata({ sourceRoot = process.cwd(), env = process.env, run = execute } = {}) {
  if (env.MSYSTEM !== 'MINGW64' || (env.TARGET_PLATFORM && env.TARGET_PLATFORM !== 'win32') ||
      (env.TARGET_ARCH && env.TARGET_ARCH !== 'x64') || (env.ARCH && env.ARCH !== 'x64')) {
    throw new Error('FFmpeg 缓存要求 MINGW64 / win32 / x64');
  }
  const recipe = Object.fromEntries(RECIPE_FILES.map((name) => [name, sha256(fs.readFileSync(path.join(sourceRoot, name)))]));
  const moduleUrl = pathToFileURL(path.join(sourceRoot, RECIPE_FILES[0]));
  moduleUrl.searchParams.set('recipe', recipe[RECIPE_FILES[0]]);
  const { FFMPEG_VERSION: version, FFMPEG_SOURCE: source } = await import(moduleUrl.href);
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[a-f0-9]{64}$/.test(source?.sha256 || '')) {
    throw new Error('FFmpeg 固定版本或源码摘要无效');
  }
  const gccTarget = run('gcc', ['-dumpmachine'], env).trim();
  if (gccTarget !== 'x86_64-w64-mingw32') throw new Error(`FFmpeg GCC 目标不匹配：${gccTarget}`);
  const toolchain = {
    gccTarget,
    gccVersion: run('gcc', ['-dumpfullversion', '-dumpversion'], env).trim(),
    linker: run('ld', ['--version'], env).trim().split(/\r?\n/)[0],
    packages: run('pacman', ['-Q'], env).trim().split(/\r?\n/)
      .filter((line) => /^(?:mingw-w64-x86_64-\S+|bash|make|diffutils|tar|xz|msys2-runtime) /.test(line))
      .sort(),
  };
  if (!toolchain.gccVersion || !toolchain.linker || !toolchain.packages.some((line) => line.startsWith('mingw-w64-x86_64-gcc '))) {
    throw new Error('FFmpeg MinGW 工具链身份不完整');
  }
  // 编译配置可能改变产物；只保存白名单的合并摘要，不能把环境值写进缓存或日志。
  const compilerEnvironmentSha256 = sha256(JSON.stringify(
    Object.fromEntries(COMPILER_ENVIRONMENT.map((name) => [name, env[name] || ''])),
  ));
  const inputs = { platform: 'win32', arch: 'x64', version, sourceSha256: source.sha256, recipe, toolchain, compilerEnvironmentSha256 };
  return { schema: SCHEMA, key: cacheKey(inputs), inputs };
}

function assertRegular(filePath, directory = false) {
  const stat = fs.lstatSync(filePath);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.size === 0) {
    throw new Error(`FFmpeg 缓存包含非正常${directory ? '目录' : '文件'}：${filePath}`);
  }
}

function verifyDirectory(directory, metadata, run = execute, expectedFiles) {
  assertRegular(directory, true);
  for (const [name, allowed] of [
    ['', ['bin', 'licenses', MANIFEST]],
    ['bin', ['ffmpeg.exe', 'ffprobe.exe']],
    ['licenses', ['COPYING.LGPLv2.1', 'LICENSE.md']],
  ]) {
    const folder = path.join(directory, name);
    assertRegular(folder, true);
    if (fs.readdirSync(folder).some((entry) => !allowed.includes(entry))) {
      throw new Error(`FFmpeg 缓存包含额外文件：${name || '.'}`);
    }
  }
  const files = {};
  for (const name of BUNDLE_FILES) {
    const filePath = path.join(directory, name);
    assertRegular(filePath);
    const bytes = fs.readFileSync(filePath);
    if (name.endsWith('.exe')) {
      const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
      if (bytes.toString('ascii', 0, 2) !== 'MZ' || offset < 64 || offset + 6 > bytes.length ||
          bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0' || bytes.readUInt16LE(offset + 4) !== 0x8664) {
        throw new Error(`FFmpeg 不是 Windows x64 PE：${name}`);
      }
    }
    files[name] = sha256(bytes);
  }
  // 先验证所有字节，再执行恢复的二进制，损坏的缓存不能进入版本探测。
  if (expectedFiles && JSON.stringify(expectedFiles) !== JSON.stringify(files)) throw new Error('成品摘要不匹配');
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const output = run(path.join(directory, 'bin', `${tool}.exe`), ['-version']);
    if (!output.startsWith(`${tool} version ${metadata.inputs.version} `)) {
      throw new Error(`${tool} 版本不匹配`);
    }
  }
  return files;
}

function readMetadata(filePath) {
  const metadata = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (metadata.schema !== SCHEMA || metadata.inputs?.platform !== 'win32' || metadata.inputs?.arch !== 'x64' ||
      metadata.key !== cacheKey(metadata.inputs)) throw new Error('FFmpeg 本次构建身份无效');
  return metadata;
}

function inspect(directory, metadata, { run = execute, log = console.log } = {}) {
  try {
    assertRegular(path.join(directory, MANIFEST));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST), 'utf8'));
    if (manifest.schema !== SCHEMA || manifest.key !== metadata.key ||
        JSON.stringify(manifest.inputs) !== JSON.stringify(metadata.inputs)) {
      throw new Error('构建身份不匹配');
    }
    if (!manifest.files || typeof manifest.files !== 'object') throw new Error('成品摘要缺失');
    verifyDirectory(directory, metadata, run, manifest.files);
    log('[FFmpeg Cache] 成品校验通过，复用已有编译结果');
    return true;
  } catch (error) {
    log(`[FFmpeg Cache] 未命中：${error.message}`);
    return false;
  }
}

function seal(directory, metadata, { run = execute } = {}) {
  const files = verifyDirectory(directory, metadata, run);
  const temporary = path.join(directory, `${MANIFEST}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ ...metadata, files }, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, path.join(directory, MANIFEST));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function output(values, env) {
  const text = Object.entries(values).map(([name, value]) => {
    if (/[\r\n]/.test(String(value))) throw new Error('FFmpeg workflow 输出不能包含换行');
    return `${name}=${value}\n`;
  }).join('');
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

async function main(command, { env = process.env, sourceRoot = process.cwd(), run = execute, log = console.log } = {}) {
  if (command === 'key') {
    const metadata = await createMetadata({ sourceRoot, env, run });
    const folder = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'ffmpeg-cache-inputs-'));
    const metadataPath = path.join(folder, 'metadata.json');
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
    output({ key: metadata.key, metadata: metadataPath }, env);
    log(`[FFmpeg Cache] ${metadata.key}`);
    return;
  }
  if (command !== 'inspect' && command !== 'seal') throw new Error('用法：windows-ffmpeg-cache.cjs key|inspect|seal');
  if (!env.FFMPEG_BUNDLE_SOURCE_DIR || !env.FFMPEG_CACHE_METADATA) throw new Error('缺少 FFmpeg 缓存目录或本次构建身份');
  const metadata = readMetadata(env.FFMPEG_CACHE_METADATA);
  const directory = path.resolve(env.FFMPEG_BUNDLE_SOURCE_DIR);
  if (command === 'inspect') output({ valid: inspect(directory, metadata, { run, log }) }, env);
  else {
    seal(directory, metadata, { run });
    output({ valid: true }, env);
    log('[FFmpeg Cache] 编译成品已验证，可保存缓存');
  }
}

module.exports = { BUNDLE_FILES, MANIFEST, RECIPE_FILES, createMetadata, inspect, seal, main };

if (require.main === module) {
  main(process.argv[2]).catch((error) => {
    console.error(`[FFmpeg Cache] ${error.message}`);
    process.exitCode = 1;
  });
}
