// ABOUTME: 验证声纹依赖缓存隔离、输入失效和原生库加载门禁，不依赖模型下载或真实安装。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SHERPA_LIBRARIES, createCacheKey, verifyInstalled, runNativeCheck, main } = require('./speaker-runtime-cache.cjs');

function fixture(t, platform = 'darwin', arch = 'arm64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-runtime-cache-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { name: 'floatboat', version: '0.6.2', packageManager: 'pnpm@10.22.0',
    dependencies: { 'sherpa-onnx-node': '2.0.1', 'onnxruntime-node': '1.21.0' }, devDependencies: { electron: '39.4.0' } };
  const write = (relative, contents) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  const writeJson = (relative, data) => write(relative, `${JSON.stringify(data)}\n`);
  writeJson('package.json', source);
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  write('pnpm-workspace.yaml', 'nodeLinker: hoisted\n');
  write('.npmrc', 'verify-store-integrity=true\n');
  write('patches/nested/runtime.patch', 'patch fixture\n');
  const env = { TARGET_PLATFORM: platform, TARGET_ARCH: arch, PNPM_VERSION: '10.22.0', PNPM_STORE_PATH: path.join(root, 'store/v10') };
  const runtime = { platform, arch, version: 'v20.19.0', versions: { modules: '115' } };
  const loads = [];
  const nativeCheck = (input) => { loads.push(input); };
  const options = { sourceRoot: root, env, runtime, nativeCheck, log: () => {} };
  const nativeName = `sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${arch}`;
  const sherpaRoot = `node_modules/${nativeName}`;
  const onnxRoot = `node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}`;
  function install() {
    writeJson('node_modules/sherpa-onnx-node/package.json', { name: 'sherpa-onnx-node', version: '2.0.1', license: 'Apache-2.0',
      main: 'sherpa-onnx.js', optionalDependencies: { [nativeName]: '2.0.1' } });
    for (const name of ['sherpa-onnx.js', 'addon.js', 'speaker-identification.js']) write(`node_modules/sherpa-onnx-node/${name}`, 'fixture js');
    writeJson(`${sherpaRoot}/package.json`, { name: nativeName, version: '2.0.1', license: 'Apache-2.0', os: [platform], cpu: [arch] });
    for (const name of ['index.js', 'sherpa-onnx.node', ...SHERPA_LIBRARIES[platform]]) write(`${sherpaRoot}/${name}`, `fixture ${name}`);
    writeJson('node_modules/onnxruntime-node/package.json', { name: 'onnxruntime-node', version: '1.21.0', license: 'MIT', os: ['darwin', 'win32', 'linux'] });
    writeJson('node_modules/onnxruntime-common/package.json', { name: 'onnxruntime-common', version: '1.21.0', license: 'MIT' });
    write('node_modules/onnxruntime-node/dist/index.js', 'fixture js');
    for (const name of ['onnxruntime_binding.node', ...(platform === 'darwin' ? ['libonnxruntime.1.21.0.dylib'] : ['onnxruntime.dll', 'DirectML.dll'])]) {
      write(`${onnxRoot}/${name}`, `fixture ${name}`);
    }
  }
  return { root, source, env, runtime, options, loads, write, writeJson, install, nativeName, sherpaRoot, onnxRoot };
}

test('应用名、版本、源码与发行变体变化仍复用同一个依赖缓存', (t) => {
  const f = fixture(t);
  const first = createCacheKey(f.options);
  f.writeJson('package.json', { ...f.source, name: 'deepseek-agent', version: '99.0.0-test.42', description: 'updated app', scripts: { build: 'changed app script' } });
  f.write('src/main/app.ts', 'changed app source');
  Object.assign(f.env, { GITHUB_SHA: 'new-source-commit', DESKTOP_RELEASE_VARIANT: 'deepseek-agent' });
  assert.deepEqual(createCacheKey(f.options), first);
  assert.match(first.key, /^speaker-pnpm-v1-darwin-arm64-[a-f0-9]{64}$/);
  assert.equal(first.store_path, f.env.PNPM_STORE_PATH);
});

for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'patches/nested/runtime.patch']) {
  test(`依赖输入变化使 key 失效：${name}`, (t) => {
    const f = fixture(t);
    const before = createCacheKey(f.options).key;
    f.write(name, 'changed dependency input');
    assert.notEqual(createCacheKey(f.options).key, before);
  });
}

test('依赖、工具链和 ABI 变化分别隔离，JSON 字段排序不影响 key', (t) => {
  const f = fixture(t);
  const before = createCacheKey(f.options).key;
  f.writeJson('package.json', { ...f.source, dependencies: { 'onnxruntime-node': '1.21.0', 'sherpa-onnx-node': '2.0.1' } });
  assert.equal(createCacheKey(f.options).key, before);
  for (const update of [
    { dependencies: { ...f.source.dependencies, 'sherpa-onnx-node': '2.0.2' } },
    { dependencies: { ...f.source.dependencies, 'onnxruntime-node': '1.22.0' } },
    { devDependencies: { electron: '40.0.0' } },
    { packageManager: 'pnpm@10.23.0' },
  ]) {
    f.writeJson('package.json', { ...f.source, ...update });
    assert.notEqual(createCacheKey(f.options).key, before);
  }
  f.writeJson('package.json', f.source);
  assert.notEqual(createCacheKey({ ...f.options, env: { ...f.env, PNPM_VERSION: '10.23.0' } }).key, before);
  assert.notEqual(createCacheKey({ ...f.options, runtime: { ...f.runtime, version: 'v20.20.0' } }).key, before);
  assert.notEqual(createCacheKey({ ...f.options, runtime: { ...f.runtime, versions: { modules: '127' } } }).key, before);
});

test('缺少锁文件、无效 store 路径、未支持或交叉目标必须拒绝', (t) => {
  const f = fixture(t);
  for (const target of [{ TARGET_PLATFORM: 'linux' }, { TARGET_ARCH: 'x64' }, { TARGET_PLATFORM: 'win32', TARGET_ARCH: 'arm64' }]) {
    assert.throws(() => createCacheKey({ ...f.options, env: { ...f.env, ...target } }), /不支持|构建机/);
  }
  for (const store of ['relative/store', f.root, path.join(f.root, 'node_modules')]) {
    assert.throws(() => createCacheKey({ ...f.options, env: { ...f.env, PNPM_STORE_PATH: store } }), /绝对路径|不能缓存/);
  }
  assert.throws(() => createCacheKey({ ...f.options, env: { ...f.env, PNPM_VERSION: '' } }), /PNPM_VERSION/);
  fs.unlinkSync(path.join(f.root, 'pnpm-lock.yaml'));
  assert.throws(() => createCacheKey(f.options), /pnpm-lock/);
});

test('允许 pnpm action 安装目录内的独立 store，不能误把路径中的 node_modules 当项目依赖', (t) => {
  const f = fixture(t);
  const storePath = path.resolve(f.root, '..', 'setup-pnpm/node_modules/.bin/store/v10');
  const values = createCacheKey({ ...f.options, env: { ...f.env, PNPM_STORE_PATH: storePath } });
  assert.equal(values.store_path, storePath);
  assert.equal(values.key, createCacheKey(f.options).key);
});

test('拒绝把源码祖先或项目依赖目录当 store，但允许项目自己的独立 store', (t) => {
  const f = fixture(t);
  for (const storePath of [
    path.dirname(f.root),
    path.parse(f.root).root,
    path.join(f.root, 'node_modules/.pnpm/store/v10'),
    path.join(f.root, 'packages/example/node_modules/store'),
    path.resolve(f.root, '..', 'setup-pnpm/node_modules'),
  ]) {
    assert.throws(() => createCacheKey({ ...f.options, env: { ...f.env, PNPM_STORE_PATH: storePath } }), /不能缓存/);
  }
  const storePath = path.join(f.root, '.pnpm-store/v10');
  assert.equal(createCacheKey({ ...f.options, env: { ...f.env, PNPM_STORE_PATH: storePath } }).store_path, storePath);
});

for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
  test(`${platform}/${arch} 安装后直接验证 Sherpa 与 ONNX binding 可加载`, (t) => {
    const f = fixture(t, platform, arch);
    f.install();
    assert.deepEqual(verifyInstalled(f.options), ['sherpa-onnx-node@2.0.1', 'onnxruntime-node@1.21.0']);
    assert.deepEqual(f.loads, [
      { modulePath: fs.realpathSync(path.join(f.root, 'node_modules/sherpa-onnx-node/sherpa-onnx.js')), requiredExport: 'SpeakerEmbeddingExtractor' },
      { modulePath: fs.realpathSync(path.join(f.root, f.onnxRoot, 'onnxruntime_binding.node')) },
    ]);
  });
}

test('兼容 pnpm 非顶层提升平台包，按 wrapper 相邻依赖解析', (t) => {
  const f = fixture(t);
  f.install();
  const destination = path.join(f.root, 'node_modules/sherpa-onnx-node/node_modules', f.nativeName);
  fs.mkdirSync(path.dirname(destination));
  fs.renameSync(path.join(f.root, f.sherpaRoot), destination);
  assert.deepEqual(verifyInstalled(f.options), ['sherpa-onnx-node@2.0.1', 'onnxruntime-node@1.21.0']);
});

test('通过公开入口找到 exports 隐藏的 onnxruntime-common 清单', (t) => {
  const f = fixture(t);
  f.install();
  f.writeJson('node_modules/onnxruntime-common/package.json', {
    name: 'onnxruntime-common', version: '1.21.0', license: 'MIT', exports: { '.': './dist/cjs/index.js' },
  });
  f.write('node_modules/onnxruntime-common/dist/cjs/index.js', 'module.exports = {};');
  assert.deepEqual(verifyInstalled(f.options), ['sherpa-onnx-node@2.0.1', 'onnxruntime-node@1.21.0']);
});

test('历史源码无 Sherpa 时跳过它但仍验证 ONNX，均未声明时不要求安装', (t) => {
  const f = fixture(t);
  f.install();
  fs.rmSync(path.join(f.root, 'node_modules/sherpa-onnx-node'), { recursive: true });
  f.writeJson('package.json', { dependencies: { 'onnxruntime-node': '1.21.0' } });
  assert.deepEqual(verifyInstalled(f.options), ['onnxruntime-node@1.21.0']);
  f.writeJson('package.json', {});
  assert.deepEqual(verifyInstalled(f.options), []);
});

for (const broken of ['wrapper-version', 'native-version', 'native-platform', 'native-architecture', 'native-dependency', 'native-license', 'empty-license', 'missing-native', 'empty-dylib', 'onnx-version', 'onnx-common-version', 'missing-onnx-binding', 'empty-onnx-library']) {
  test(`已安装依赖不满足契约时阻断：${broken}`, (t) => {
    const f = fixture(t);
    f.install();
    const editPackage = (name, update) => {
      const file = `node_modules/${name}/package.json`;
      const pkg = JSON.parse(fs.readFileSync(path.join(f.root, file), 'utf8'));
      f.writeJson(file, { ...pkg, ...update });
    };
    if (broken === 'wrapper-version') editPackage('sherpa-onnx-node', { version: '2.0.2' });
    if (broken === 'native-version') editPackage(f.nativeName, { version: '2.0.2' });
    if (broken === 'native-platform') editPackage(f.nativeName, { os: ['win32'] });
    if (broken === 'native-architecture') editPackage(f.nativeName, { cpu: ['x64'] });
    if (broken === 'native-dependency') editPackage('sherpa-onnx-node', { optionalDependencies: { [f.nativeName]: '2.0.2' } });
    if (broken === 'native-license') editPackage(f.nativeName, { license: 'unknown' });
    if (broken === 'empty-license') f.write(`${f.sherpaRoot}/LICENSE`, '');
    if (broken === 'missing-native') fs.unlinkSync(path.join(f.root, f.sherpaRoot, 'sherpa-onnx.node'));
    if (broken === 'empty-dylib') f.write(`${f.sherpaRoot}/libonnxruntime.dylib`, '');
    if (broken === 'onnx-version') editPackage('onnxruntime-node', { version: '1.22.0' });
    if (broken === 'onnx-common-version') editPackage('onnxruntime-common', { version: '1.22.0' });
    if (broken === 'missing-onnx-binding') fs.unlinkSync(path.join(f.root, f.onnxRoot, 'onnxruntime_binding.node'));
    if (broken === 'empty-onnx-library') f.write(`${f.onnxRoot}/libonnxruntime.1.21.0.dylib`, '');
    assert.throws(() => verifyInstalled(f.options), /不匹配|不一致|缺失|为空|ENOENT/);
  });
}

test('任何组件的独立动态加载失败都向上传播，不能只看文件存在', (t) => {
  const f = fixture(t, 'win32', 'x64');
  f.install();
  for (const failedFile of ['sherpa-onnx.js', 'onnxruntime_binding.node']) {
    assert.throws(() => verifyInstalled({ ...f.options, nativeCheck: (input) => {
      if (input.modulePath.endsWith(failedFile)) throw new Error('native ABI or DLL load failed');
      return f.options.nativeCheck(input);
    } }), /ABI or DLL/);
  }
});

test('真实 Node 子进程逐次隔离模块状态，两个组件使用不同进程且不污染父进程', (t) => {
  const f = fixture(t);
  const pidFile = path.join(f.root, 'child-pids.jsonl');
  const body = `const fs = require('node:fs');\nif (globalThis.__speakerCacheLoaded) throw new Error('shared process');\nglobalThis.__speakerCacheLoaded = true;\nfs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');\nmodule.exports = { SpeakerEmbeddingExtractor() {} };\n`;
  f.write('sherpa-fixture.cjs', body);
  f.write('onnx-fixture.cjs', body);
  runNativeCheck({ modulePath: path.join(f.root, 'sherpa-fixture.cjs'), requiredExport: 'SpeakerEmbeddingExtractor' });
  runNativeCheck({ modulePath: path.join(f.root, 'onnx-fixture.cjs') });
  const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
  assert.equal(pids.length, 2);
  assert.notEqual(pids[0], pids[1]);
  assert.ok(pids.every((pid) => pid !== process.pid));
  assert.equal(globalThis.__speakerCacheLoaded, undefined);
});

test('真实子进程拒绝缺失接口、require 失败及非零退出，不泄露 stdout', (t) => {
  const f = fixture(t);
  f.write('missing-export.cjs', 'module.exports = {};');
  assert.throws(() => runNativeCheck({ modulePath: path.join(f.root, 'missing-export.cjs'), requiredExport: 'SpeakerEmbeddingExtractor' }), /Missing required export: SpeakerEmbeddingExtractor/);
  assert.throws(() => runNativeCheck({ modulePath: path.join(f.root, 'missing-module.cjs') }), /独立加载失败.*missing-module/s);
  f.write('load-failure.cjs', "console.log('private stdout payload'); console.error('fixture DLL failure'); process.exit(7);");
  assert.throws(() => runNativeCheck({ modulePath: path.join(f.root, 'load-failure.cjs') }), (error) => {
    assert.match(error.message, /fixture DLL failure/);
    assert.equal(error.message.includes('private stdout payload'), false);
    return true;
  });
});

test('CLI key 输出实际 store 路径，verify 不写 key、不下载模型', (t) => {
  const f = fixture(t);
  f.env.GITHUB_OUTPUT = path.join(f.root, 'github-output');
  const values = main('key', f.options);
  assert.equal(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), `key=${values.key}\nstore_path=${values.store_path}\n`);
  f.install();
  main('verify', f.options);
  assert.equal(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), `key=${values.key}\nstore_path=${values.store_path}\n`);
  assert.equal(fs.existsSync(path.join(f.root, 'resources/speaker-models')), false);
  assert.throws(() => main('unknown', f.options), /用法/);
});
