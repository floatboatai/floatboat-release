// ABOUTME: 仅供隔离性能 workflow 使用；复用候选已签名载荷，只用固定 dev 安装器实现重包基线。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const BASELINE_SHA = '711698760968280f5ffc3cb62768f6cca39ea371';
const BASELINE_FILES = ['installer.nsh', 'installer-upgrade-temp.nsh', 'setup-progress-monitor.ps1', 'setup-progress-content.json', 'launch-hidden.vbs'];
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function assert(condition, message) { if (!condition) throw new Error(message); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function within(child, parent) { const rel = path.relative(parent, child); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }
function asarVersion(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const prefix = Buffer.alloc(16); assert(fs.readSync(descriptor, prefix, 0, 16, 0) === 16, 'ASAR header incomplete.');
    const headerSize = prefix.readUInt32LE(4); const jsonSize = prefix.readUInt32LE(12);
    assert(jsonSize > 0 && jsonSize < 64 * 1024 * 1024 && headerSize >= jsonSize, 'ASAR header size invalid.');
    const headerBytes = Buffer.alloc(jsonSize); assert(fs.readSync(descriptor, headerBytes, 0, jsonSize, 16) === jsonSize, 'ASAR header truncated.');
    const entry = JSON.parse(headerBytes.toString()).files['package.json'];
    assert(entry && Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size < 1024 * 1024 && /^\d+$/.test(entry.offset), 'ASAR package entry invalid.');
    const data = Buffer.alloc(entry.size);
    assert(fs.readSync(descriptor, data, 0, entry.size, 8 + headerSize + Number(entry.offset)) === entry.size, 'ASAR package entry truncated.');
    return JSON.parse(data.toString()).version;
  } finally { fs.closeSync(descriptor); }
}
function addGeneratedFile(manifest, target, source, projectDir) {
  const data = fs.readFileSync(source);
  const entry = { path: target, bytes: data.length, sha256: hash(data) };
  const existing = manifest.installedFiles.find((file) => file.path.toLowerCase() === target.toLowerCase());
  assert(!existing || (existing.bytes === entry.bytes && existing.sha256 === entry.sha256), `NSIS 生成文件与载荷冲突：${target}`);
  if (!existing) manifest.installedFiles.push(entry);
  manifest.generatedFiles ??= [];
  manifest.generatedFiles.push({ ...entry, source: path.relative(projectDir, source).split(path.sep).join('/') });
}
function files(root) {
  const result = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      assert(!fs.lstatSync(absolute).isSymbolicLink(), `拒绝重解析/符号链接载荷：${absolute}`);
      if (entry.isDirectory()) walk(absolute);
      else {
        assert(entry.isFile(), `载荷包含非普通文件：${absolute}`);
        const bytes = fs.readFileSync(absolute);
        result.push({ path: path.relative(root, absolute).split(path.sep).join('/'), bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
function buildRegistry(action, guid, output, beforeReceipt) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'Build-Registry.ps1'), '-Action', action, '-Guid', guid];
  if (output) args.push('-OwnedBuildDirectory', output, '-BeforeReceipt', beforeReceipt);
  return JSON.parse(execFileSync('powershell.exe', args, { env, encoding: 'utf8', timeout: 60000 }).trim());
}

async function main() {
  const [projectInput, outputInput, candidateInput, expectedVersion] = process.argv.slice(2);
  assert(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted', '只允许一次性 GitHub-hosted Windows runner。');
  assert(projectInput && outputInput && candidateInput && /^\d+\.\d+\.\d+-test\.\d+$/.test(expectedVersion || ''), '参数：projectDir outputDir candidate.exe X.Y.Z-test.N');
  const projectDir = path.resolve(projectInput);
  const output = path.resolve(outputInput);
  const candidate = path.resolve(candidateInput);
  assert(within(output, path.resolve(process.env.GITHUB_WORKSPACE)), '比较输出必须位于本次 workspace。');
  assert(!fs.existsSync(output), '比较输出目录必须不存在。');
  assert(fs.existsSync(candidate) && !within(candidate, output), '候选安装器必须已存在并位于比较输出目录之外。');
  const requireSource = createRequire(path.join(projectDir, 'package.json'));
  const packaging = requireSource('./scripts/windowsPackaging.cjs');
  const signing = requireSource('./scripts/signWithRacent.cjs');
  const { build, Platform, Arch } = requireSource('electron-builder');
  const { UUID } = requireSource('builder-util-runtime');
  const version = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')).version;
  assert(version === expectedVersion, 'CI 注入版本与比较请求不一致。');
  assert(signing.hasRacentCredentials(), '比较安装器必须沿用 release 签名凭据。');
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectDir, encoding: 'utf8' }).trim();
  assert(/^[a-f0-9]{40}$/.test(sourceSha) && sourceSha !== BASELINE_SHA, '候选源码必须为不同于固定基线的提交。');
  const appDir = packaging.getPackagedAppDir(projectDir, 'x64', version);
  assert(asarVersion(path.join(appDir, 'resources', 'app.asar')) === version, '实际 app.asar 版本与 CI 注入版本不同。');
  assert(fs.existsSync(path.join(appDir, 'resources', 'python.7z')), '候选完成后必须保留已打包的 python.7z。');
  assert(!fs.existsSync(path.join(appDir, 'resources', 'python')), '候选载荷必须已经完成 Python 归档阶段。');
  const candidateHash = hash(fs.readFileSync(candidate));
  const before = files(appDir);
  fs.mkdirSync(output);
  writeJson(path.join(output, 'payload-before.json'), { appDir, files: before });
  const expectedDirectory = path.join(output, 'expected-python');
  fs.mkdirSync(expectedDirectory);
  const sevenZip = path.join(path.dirname(requireSource.resolve('7zip-bin/package.json')), 'win', 'x64', '7za.exe');
  execFileSync(sevenZip, ['x', '-y', '-bso0', '-bsp0', `-o${expectedDirectory}`, path.join(appDir, 'resources', 'python.7z')], { stdio: 'inherit' });
  const python = files(expectedDirectory);
  assert(python.length > 0 && python.every((entry) => entry.path.startsWith('python/')), 'Python 归档成员必须位于 python/。');
  const installed = before.filter((entry) => entry.path !== 'resources/python.7z').concat(python.map((entry) => ({ ...entry, path: `resources/${entry.path}` }))).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const manifest = { schemaVersion: 1, version, sourceSha, baselineSourceSha: BASELINE_SHA, payloadDigest: hash(JSON.stringify(before)), packagedFiles: before, installedFiles: installed };
  writeJson(path.join(output, 'payload-manifest.json'), manifest);

  execFileSync('git', ['fetch', '--no-tags', 'origin', BASELINE_SHA], { cwd: projectDir, stdio: 'inherit' });
  assert(execFileSync('git', ['rev-parse', `${BASELINE_SHA}^{commit}`], { cwd: projectDir, encoding: 'utf8' }).trim() === BASELINE_SHA, '固定基线提交无法解析。');
  const include = path.join(output, 'baseline-include');
  fs.mkdirSync(include);
  const baselineFiles = [];
  for (const name of BASELINE_FILES) {
    const data = execFileSync('git', ['show', `${BASELINE_SHA}:build/${name}`], { cwd: projectDir, maxBuffer: 8 * 1024 * 1024 });
    fs.writeFileSync(path.join(include, name === 'installer.nsh' ? 'installer-base.nsh' : name), data);
    baselineFiles.push({ path: `build/${name}`, sha256: hash(data) });
  }
  fs.writeFileSync(path.join(include, 'installer.nsh'), '!undef APP_FILENAME\r\n!define APP_FILENAME "Floatboat"\r\n!include "${__FILEDIR__}\\installer-base.nsh"\r\n');
  const baselineText = fs.readFileSync(path.join(include, 'installer-base.nsh'), 'utf8');
  assert(!baselineText.includes('installer-direct-upgrade.nsh'), '基线不得包含候选 direct-upgrade hook。');
  const config = packaging.readElectronBuilderConfig(projectDir, version);
  const uninstallerIcon = path.resolve(projectDir, config.nsis.uninstallerIcon);
  addGeneratedFile(manifest, 'uninstallerIcon.ico', uninstallerIcon, projectDir);
  for (const association of config.fileAssociations || []) {
    const extension = (Array.isArray(association.ext) ? association.ext[0] : association.ext).replace(/^\./, '');
    const icon = association.icon
      ? path.resolve(projectDir, association.icon)
      : path.resolve(projectDir, config.directories.buildResources || 'build', `${extension}.ico`);
    if (!association.icon && !fs.existsSync(icon)) continue;
    assert(path.extname(icon).toLowerCase() === '.ico', '性能工具只接受当前工程明确的 ICO 文件关联图标。');
    addGeneratedFile(manifest, `resources/${path.basename(icon)}`, icon, projectDir);
  }
  manifest.installedFiles.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  writeJson(path.join(output, 'payload-manifest.json'), manifest);
  const baselineOutput = path.join(output, 'baseline-installer');
  config.nsis.include = path.join(include, 'installer.nsh');
  config.directories.output = baselineOutput;
  const { nsisDir, resourcesDir } = await packaging.ensureCustomNsisToolchain(projectDir);
  process.env.ELECTRON_BUILDER_NSIS_DIR = nsisDir;
  process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = resourcesDir;
  const guid = String(UUID.v5(config.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')));
  const registryBefore = buildRegistry('Inspect', guid);
  assert(registryBefore.every((entry) => !entry.exists), '基线构建前已有产品 HKCU 登记，拒绝更改。');
  writeJson(path.join(output, 'registry-before-build.json'), registryBefore);
  let paths;
  try {
    // Python 已由正式候选构建压缩；只重包 NSIS，避免重复归档或重新生成应用载荷。
    paths = await build({ projectDir, config, prepackaged: appDir, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never' });
  } finally {
    writeJson(path.join(output, 'registry-after-build.json'), buildRegistry('Inspect', guid));
    buildRegistry('Cleanup', guid, baselineOutput, path.join(output, 'registry-before-build.json'));
    writeJson(path.join(output, 'registry-after-cleanup.json'), buildRegistry('Inspect', guid));
  }
  const baselineInstallers = paths.filter((file) => file.toLowerCase().endsWith('.exe'));
  assert(baselineInstallers.length === 1 && within(baselineInstallers[0], baselineOutput), '只允许一个隔离输出的基线安装器。');
  signing.signFileWithRacent({ projectDir, filePath: baselineInstallers[0] });
  const after = files(appDir);
  writeJson(path.join(output, 'payload-after.json'), { appDir, files: after });
  assert(JSON.stringify(before) === JSON.stringify(after), '重包改变了候选载荷，停止性能比较。');
  assert(hash(fs.readFileSync(candidate)) === candidateHash, '候选安装器在重包时被覆盖。');
  writeJson(path.join(output, 'build-receipt.json'), { schemaVersion: 1, version, sourceSha, baselineSourceSha: BASELINE_SHA, appGuid: guid, baselineFiles, payloadDigest: manifest.payloadDigest, payloadUnchanged: true, baselineInstaller: baselineInstallers[0], candidateInstaller: candidate, candidateSha256: candidateHash, baselineSha256: hash(fs.readFileSync(baselineInstallers[0])), note: '仅固定 NSIS include/依赖使用基线源码；主应用、版本、签名后载荷与候选完全相同。' });
  console.log(`比较基线已生成；同载荷摘要 ${manifest.payloadDigest}`);
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
  // 与 electron-builder CLI 一致：临时目录清理的 exit(0) 不能覆盖真实构建失败。
  process.on('exit', () => { process.exitCode = 1; });
});
module.exports = { files, hash, within, asarVersion, addGeneratedFile };
