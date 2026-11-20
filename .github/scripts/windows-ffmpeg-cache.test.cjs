// ABOUTME: 用真实临时文件验证 Windows FFmpeg 缓存身份、损坏拒收和保存门禁，不执行编译。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { BUNDLE_FILES, MANIFEST, RECIPE_FILES, createMetadata, inspect, seal, main } = require('./windows-ffmpeg-cache.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-cache-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of RECIPE_FILES) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name === RECIPE_FILES[0]
      ? `export const FFMPEG_VERSION = '8.1.2';\nexport const FFMPEG_SOURCE = { sha256: '${'a'.repeat(64)}' };\n`
      : `// ${name}\n`);
  }
  const bundle = path.join(root, 'bundle');
  const env = { MSYSTEM: 'MINGW64', TARGET_PLATFORM: 'win32', TARGET_ARCH: 'x64', RUNNER_TEMP: root,
    GITHUB_OUTPUT: path.join(root, 'github-output'), FFMPEG_BUNDLE_SOURCE_DIR: bundle };
  const calls = [];
  function run(command, args) {
    calls.push([command, args]);
    if (command === 'gcc') return args[0] === '-dumpmachine' ? 'x86_64-w64-mingw32' : '15.2.0';
    if (command === 'ld') return 'GNU ld (GNU Binutils) 2.45\nCopyright';
    if (command === 'pacman') return 'mingw-w64-x86_64-gcc 15.2.0-1\nmake 4.4.1-3\nmsys2-runtime 3.6.6-1\n';
    const tool = path.basename(command, '.exe');
    assert.ok(['ffmpeg', 'ffprobe'].includes(tool), `意外执行 ${command}`);
    assert.deepEqual(args, ['-version']);
    return `${tool} version 8.1.2 Copyright (c) FFmpeg developers\n`;
  }
  function populate() {
    for (const name of BUNDLE_FILES) {
      const file = path.join(bundle, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (name.endsWith('.exe')) {
        const bytes = Buffer.alloc(256);
        bytes.write('MZ');
        bytes.writeUInt32LE(0x80, 0x3c);
        bytes.write('PE\0\0', 0x80, 'ascii');
        bytes.writeUInt16LE(0x8664, 0x84);
        fs.writeFileSync(file, bytes);
      } else fs.writeFileSync(file, `License fixture: ${name}\n`);
    }
  }
  return { root, bundle, env, calls, run, populate, metadata: () => createMetadata({ sourceRoot: root, env, run }) };
}

const silent = () => {};

test('相同源码与实际工具链稳定命中，应用 SHA、版本和 secrets 不进入身份', async (t) => {
  const f = fixture(t);
  const first = await f.metadata();
  Object.assign(f.env, { GITHUB_SHA: 'unrelated-commit', VERSION: '99.0.0-test.1', SOURCE_REPO_TOKEN: 'secret-value' });
  const second = await f.metadata();
  assert.deepEqual(first, second);
  assert.match(first.key, /^ffmpeg-v1-win32-x64-[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(second).includes('secret-value'), false);
  assert.deepEqual(first.inputs.toolchain.packages, ['make 4.4.1-3', 'mingw-w64-x86_64-gcc 15.2.0-1', 'msys2-runtime 3.6.6-1']);
});

for (const name of RECIPE_FILES) {
  test(`编译输入变更使缓存失效：${name}`, async (t) => {
    const f = fixture(t);
    const before = await f.metadata();
    fs.appendFileSync(path.join(f.root, name), '// changed recipe\n');
    assert.notEqual((await f.metadata()).key, before.key);
  });
}

test('源码版本、摘要和工具链升级各自改变缓存 key', async (t) => {
  const f = fixture(t);
  const before = await f.metadata();
  const modulePath = path.join(f.root, RECIPE_FILES[0]);
  const original = fs.readFileSync(modulePath, 'utf8');
  for (const replacement of [original.replace('8.1.2', '8.1.3'), original.replace('a'.repeat(64), 'b'.repeat(64))]) {
    fs.writeFileSync(modulePath, replacement);
    assert.notEqual((await f.metadata()).key, before.key);
  }
  fs.writeFileSync(modulePath, original);
  for (const command of ['gcc', 'ld', 'pacman']) {
    const updated = await createMetadata({ sourceRoot: f.root, env: f.env, run: (cmd, args) => {
      const originalOutput = f.run(cmd, args);
      return cmd === command && args[0] !== '-dumpmachine' ? originalOutput.replace(/15\.2\.0|2\.45|4\.4\.1/g, '99.0.0') : originalOutput;
    } });
    assert.notEqual(updated.key, before.key, `${command} 变化必须失效`);
  }
});

test('错误平台、非 MINGW64、错误 GCC target 或不完整工具链拒绝生成 key', async (t) => {
  const f = fixture(t);
  for (const env of [{ MSYSTEM: 'UCRT64' }, { TARGET_PLATFORM: 'darwin' }, { TARGET_ARCH: 'arm64' }]) {
    await assert.rejects(createMetadata({ sourceRoot: f.root, env: { ...f.env, ...env }, run: f.run }), /要求/);
  }
  await assert.rejects(createMetadata({ sourceRoot: f.root, env: f.env, run: () => 'aarch64-w64-mingw32' }), /目标不匹配/);
  await assert.rejects(createMetadata({ sourceRoot: f.root, env: f.env, run: (cmd, args) => cmd === 'pacman' ? '' : f.run(cmd, args) }), /身份不完整/);
});

test('显式编译环境改变 key，只保存合并摘要，不泄露编译参数原文', async (t) => {
  const f = fixture(t);
  const before = await f.metadata();
  for (const name of ['CFLAGS', 'CPPFLAGS', 'CXXFLAGS', 'LDFLAGS', 'CC', 'CXX', 'AR', 'RANLIB', 'STRIP']) {
    const changed = await createMetadata({ sourceRoot: f.root, env: { ...f.env, [name]: 'private-compiler-config' }, run: f.run });
    assert.notEqual(changed.key, before.key, `${name} 变化必须失效`);
    assert.match(changed.inputs.compilerEnvironmentSha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(changed).includes('private-compiler-config'), false);
  }
});

test('完整成品 seal 后可复用，记录所有文件摘要并验证两个程序', async (t) => {
  const f = fixture(t);
  f.populate();
  const metadata = await f.metadata();
  seal(f.bundle, metadata, { run: f.run });
  // 命中后 workflow 仍会 seal；Node rename 会替换已有普通文件，不能遗留临时清单。
  seal(f.bundle, metadata, { run: f.run });
  const manifest = JSON.parse(fs.readFileSync(path.join(f.bundle, MANIFEST), 'utf8'));
  assert.deepEqual(fs.readdirSync(f.bundle).sort(), ['bin', MANIFEST, 'licenses'].sort());
  assert.deepEqual(Object.keys(manifest.files), BUNDLE_FILES);
  assert.ok(Object.values(manifest.files).every((value) => /^[a-f0-9]{64}$/.test(value)));
  f.calls.length = 0;
  assert.equal(inspect(f.bundle, metadata, { run: f.run, log: silent }), true);
  assert.deepEqual(f.calls.map(([file]) => path.basename(file)), ['ffmpeg.exe', 'ffprobe.exe']);
});

for (const failure of ['missing', 'invalid-json', 'wrong-key', 'wrong-inputs', 'missing-hashes', 'extra-file', 'missing-license', 'empty-license', 'wrong-architecture', 'truncated-exe', 'corrupted-bytes']) {
  test(`缓存损坏返回未命中，执行前拒收：${failure}`, async (t) => {
    const f = fixture(t);
    f.populate();
    const metadata = await f.metadata();
    seal(f.bundle, metadata, { run: f.run });
    const manifestPath = path.join(f.bundle, MANIFEST);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const exe = path.join(f.bundle, 'bin/ffmpeg.exe');
    if (failure === 'missing') fs.rmSync(f.bundle, { recursive: true });
    else if (failure === 'invalid-json') fs.writeFileSync(manifestPath, '{');
    else if (failure === 'wrong-key') fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, key: 'different' }));
    else if (failure === 'wrong-inputs') fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, inputs: { ...manifest.inputs, arch: 'arm64' } }));
    else if (failure === 'missing-hashes') fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: undefined }));
    else if (failure === 'extra-file') fs.writeFileSync(path.join(f.bundle, 'build.log'), 'not a cache artifact');
    else if (failure === 'missing-license') fs.unlinkSync(path.join(f.bundle, BUNDLE_FILES[2]));
    else if (failure === 'empty-license') fs.writeFileSync(path.join(f.bundle, BUNDLE_FILES[2]), '');
    else if (failure === 'truncated-exe') fs.writeFileSync(exe, 'MZ');
    else {
      const bytes = fs.readFileSync(exe);
      if (failure === 'wrong-architecture') bytes.writeUInt16LE(0xaa64, 0x84);
      else bytes[255] = 7;
      fs.writeFileSync(exe, bytes);
    }
    assert.equal(inspect(f.bundle, metadata, { run: () => assert.fail('不能执行未通过静态检查的缓存'), log: silent }), false);
  });
}

test('错误或无法运行的 ffprobe 不能封存，近似版本不能误判为命中', async (t) => {
  const f = fixture(t);
  f.populate();
  const metadata = await f.metadata();
  for (const version of ['8.1.20', '8.1.3']) {
    assert.throws(() => seal(f.bundle, metadata, { run: (cmd, args) => path.basename(cmd) === 'ffprobe.exe' ? `ffprobe version ${version} Copyright` : f.run(cmd, args) }), /版本不匹配/);
    assert.equal(fs.existsSync(path.join(f.bundle, MANIFEST)), false);
  }
  assert.throws(() => seal(f.bundle, metadata, { run: () => { throw new Error('DLL missing'); } }), /DLL missing/);
  assert.equal(fs.existsSync(path.join(f.bundle, MANIFEST)), false);
});

test('符号链接产物不允许封存，缓存只接收本目录的实体文件', async (t) => {
  const f = fixture(t);
  f.populate();
  const metadata = await f.metadata();
  const license = path.join(f.bundle, BUNDLE_FILES[2]);
  const external = path.join(f.root, 'external-license');
  fs.renameSync(license, external);
  fs.symlinkSync(external, license);
  assert.throws(() => seal(f.bundle, metadata, { run: f.run }), /非正常文件/);
  assert.equal(fs.existsSync(path.join(f.bundle, MANIFEST)), false);
});

test('key → inspect → seal → inspect 工作流输出正确，当前身份存放在恢复目录外', async (t) => {
  const f = fixture(t);
  const options = { sourceRoot: f.root, env: f.env, run: f.run, log: silent };
  await main('key', options);
  const values = Object.fromEntries(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8').trim().split('\n').map((line) => line.split('=')));
  assert.ok(values.key.startsWith('ffmpeg-v1-win32-x64-'));
  assert.equal(path.relative(f.bundle, values.metadata).startsWith('..'), true);
  f.env.FFMPEG_CACHE_METADATA = values.metadata;
  fs.writeFileSync(f.env.GITHUB_OUTPUT, '');
  await main('inspect', options);
  assert.equal(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), 'valid=false\n');
  f.populate();
  fs.writeFileSync(f.env.GITHUB_OUTPUT, '');
  await main('seal', options);
  await main('inspect', options);
  assert.equal(fs.readFileSync(f.env.GITHUB_OUTPUT, 'utf8'), 'valid=true\nvalid=true\n');
});

test('seal 出错不输出可保存标志，非法命令与过期本次身份明确失败', async (t) => {
  const f = fixture(t);
  const metadataPath = path.join(f.root, 'metadata.json');
  const metadata = await f.metadata();
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  f.env.FFMPEG_CACHE_METADATA = metadataPath;
  const options = { env: f.env, run: f.run, log: silent };
  await assert.rejects(main('seal', options), /ENOENT/);
  assert.equal(fs.existsSync(f.env.GITHUB_OUTPUT), false);
  await assert.rejects(main('unknown', options), /用法/);
  fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, key: 'tampered' }));
  await assert.rejects(main('inspect', options), /身份无效/);
});
