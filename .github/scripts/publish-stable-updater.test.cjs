#!/usr/bin/env node
// ABOUTME: 使用本地替身贯通 stable updater 的 S3 发布、CloudFront 失效与 CDN 回读门禁。

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');

const scriptPath = path.join(__dirname, 'publish-stable-updater.sh');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o755 });
}

function createCommandDoubles(binDirectory) {
  writeExecutable(
    path.join(binDirectory, 'aws'),
    `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const storeRoot = process.env.MOCK_S3_ROOT;
const callLog = process.env.MOCK_CALL_LOG;
fs.appendFileSync(callLog, \`aws \${args.join(' ')}\\n\`);
function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1];
}
if (args[0] === 's3' && args[1] === 'cp') {
  const source = args[2];
  const target = new URL(args[3]);
  const destination = path.join(storeRoot, target.hostname, decodeURIComponent(target.pathname.slice(1)));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.writeFileSync(\`\${destination}.metadata.json\`, JSON.stringify({
    CacheControl: option('--cache-control'),
    ContentType: option('--content-type') || 'application/octet-stream',
  }));
  process.exit(0);
}
if (args[0] === 's3api' && args[1] === 'head-object') {
  const destination = path.join(storeRoot, option('--bucket'), option('--key'));
  const metadata = JSON.parse(fs.readFileSync(\`\${destination}.metadata.json\`, 'utf8'));
  process.stdout.write(JSON.stringify({
    ContentLength: fs.statSync(destination).size,
    ETag: '"mock-etag"',
    ...metadata,
  }));
  process.exit(0);
}
if (args[0] === 'cloudfront' && args[1] === 'create-invalidation') {
  process.stdout.write(JSON.stringify({
    Invalidation: { Id: 'INV-MOCK', Status: 'InProgress', CreateTime: '2026-07-28T00:00:00Z' },
  }));
  process.exit(0);
}
if (args[0] === 'cloudfront' && args[1] === 'wait') {
  if (process.env.MOCK_CLOUDFRONT_WAIT_DENIED === '1') {
    process.stderr.write('AccessDenied: cloudfront:GetInvalidation is not allowed\\n');
    process.exit(255);
  }
  process.exit(0);
}
process.stderr.write(\`Unexpected aws invocation: \${args.join(' ')}\\n\`);
process.exit(2);
`,
  );

  writeExecutable(
    path.join(binDirectory, 'curl'),
    `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const storeRoot = process.env.MOCK_S3_ROOT;
const callLog = process.env.MOCK_CALL_LOG;
fs.appendFileSync(callLog, \`curl \${args.join(' ')}\\n\`);
function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1];
}
const urlText = [...args].reverse().find((value) => /^https?:\\/\\//.test(value));
const url = new URL(urlText);
const source = path.join(storeRoot, 'aoe-desktop-releases', decodeURIComponent(url.pathname.slice(1)));
if (!fs.existsSync(source)) {
  process.stderr.write(\`Missing mocked CDN object: \${source}\\n\`);
  process.exit(22);
}
if (args.includes('--head')) {
  fs.writeFileSync(option('--dump-header'), \`HTTP/2 200\\r\\ncontent-length: \${fs.statSync(source).size}\\r\\n\\r\\n\`);
  process.exit(0);
}
const destination = option('--output');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(source, destination);
`,
  );
}

function createMetadata(artifactDirectory, releaseVersion, artifactNames) {
  const files = artifactNames.map((artifactName) => {
    const artifactPath = path.join(artifactDirectory, artifactName);
    const content = fs.readFileSync(artifactPath);
    return {
      url: artifactName,
      sha512: crypto.createHash('sha512').update(content).digest('base64'),
      size: content.byteLength,
    };
  });
  const primary = files.find((file) => file.url.endsWith('.zip')) || files[0];
  return {
    version: releaseVersion,
    files,
    path: primary.url,
    sha512: primary.sha512,
    releaseDate: '2026-07-28T00:00:00.000Z',
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floatboat-stable-updater-'));
  const workspace = path.join(root, 'workspace');
  const artifactDirectory = path.join(workspace, 'out', 'make');
  const metadataDirectory = path.join(workspace, 'dist');
  const deepseekMetadataDirectory = path.join(metadataDirectory, 'deepseek-agent');
  const binDirectory = path.join(root, 'bin');
  const s3Root = path.join(root, 's3');
  const callLog = path.join(root, 'calls.log');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  fs.mkdirSync(deepseekMetadataDirectory, { recursive: true });
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(callLog, '');
  createCommandDoubles(binDirectory);

  const floatboatVersion = '1.2.3';
  const deepseekVersion = '1.2.3-deepseek';
  const floatboatMacArtifacts = [
    `Floatboat-${floatboatVersion}-arm64.dmg`,
    `Floatboat-${floatboatVersion}-x64.dmg`,
    `Floatboat-${floatboatVersion}-arm64.zip`,
    `Floatboat-${floatboatVersion}-x64.zip`,
  ];
  const floatboatWindowsArtifact = `Floatboat-Setup-${floatboatVersion}-x64.exe`;
  const deepseekMacArtifacts = [
    `Floatboat-DeepSeek-Agent-${deepseekVersion}-arm64.dmg`,
    `Floatboat-DeepSeek-Agent-${deepseekVersion}-x64.dmg`,
    `Floatboat-DeepSeek-Agent-${deepseekVersion}-arm64.zip`,
    `Floatboat-DeepSeek-Agent-${deepseekVersion}-x64.zip`,
  ];
  const deepseekWindowsArtifact = `Floatboat-DeepSeek-Agent-Setup-${deepseekVersion}-x64.exe`;
  const allArtifacts = [
    ...floatboatMacArtifacts,
    floatboatWindowsArtifact,
    ...deepseekMacArtifacts,
    deepseekWindowsArtifact,
  ];
  for (const artifactName of allArtifacts) {
    fs.writeFileSync(path.join(artifactDirectory, artifactName), `content:${artifactName}`);
  }

  fs.writeFileSync(
    path.join(metadataDirectory, 'latest-mac.yml'),
    yaml.dump(createMetadata(artifactDirectory, floatboatVersion, floatboatMacArtifacts)),
  );
  fs.writeFileSync(
    path.join(metadataDirectory, 'latest.yml'),
    yaml.dump(createMetadata(artifactDirectory, floatboatVersion, [floatboatWindowsArtifact])),
  );
  fs.writeFileSync(
    path.join(deepseekMetadataDirectory, 'deepseek-agent-mac.yml'),
    yaml.dump(createMetadata(artifactDirectory, deepseekVersion, deepseekMacArtifacts)),
  );
  fs.writeFileSync(
    path.join(deepseekMetadataDirectory, 'deepseek-agent.yml'),
    yaml.dump(createMetadata(artifactDirectory, deepseekVersion, [deepseekWindowsArtifact])),
  );

  return {
    root,
    workspace,
    metadataDirectory,
    binDirectory,
    s3Root,
    callLog,
    floatboatVersion,
    deepseekVersion,
  };
}

function runPublish(fixture, desktopVariant = 'all', extraEnv = {}) {
  return spawnSync('bash', [scriptPath], {
    cwd: fixture.workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.binDirectory}:${process.env.PATH}`,
      GITHUB_WORKSPACE: fixture.workspace,
      DESKTOP_VARIANT: desktopVariant,
      FLOATBOAT_VERSION: fixture.floatboatVersion,
      DEEPSEEK_VERSION: fixture.deepseekVersion,
      MOCK_S3_ROOT: fixture.s3Root,
      MOCK_CALL_LOG: fixture.callLog,
      ...extraEnv,
    },
  });
}

test('依次发布十个制品和四份元数据，并完成 CDN 回读', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = runPublish(fixture);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /stable updater feeds are published and externally readable/);
  const releaseRoot = path.join(fixture.s3Root, 'aoe-desktop-releases');
  const deepseekRoot = path.join(releaseRoot, 'deepseek-agent');
  const expectedDeepseekObjects = [
    `Floatboat-DeepSeek-Agent-${fixture.deepseekVersion}-arm64.dmg`,
    `Floatboat-DeepSeek-Agent-${fixture.deepseekVersion}-x64.dmg`,
    `Floatboat-DeepSeek-Agent-Setup-${fixture.deepseekVersion}-x64.exe`,
    `Floatboat-DeepSeek-Agent-${fixture.deepseekVersion}-arm64.zip`,
    `Floatboat-DeepSeek-Agent-${fixture.deepseekVersion}-x64.zip`,
    'deepseek-agent-mac.yml',
    'deepseek-agent.yml',
  ];

  for (const objectName of expectedDeepseekObjects) {
    assert.ok(fs.existsSync(path.join(deepseekRoot, objectName)), `缺少 DeepSeek S3 对象：${objectName}`);
  }
  assert.equal(
    fs.readdirSync(releaseRoot).some((objectName) => objectName.startsWith('Floatboat-DeepSeek-Agent-')),
    false,
    'DeepSeek 制品不得写入 Floatboat S3 根前缀',
  );
  assert.ok(fs.existsSync(path.join(releaseRoot, 'latest.yml')));

  const calls = fs.readFileSync(fixture.callLog, 'utf8').trim().split('\n');
  const s3CopyCalls = calls.filter((call) => call.startsWith('aws s3 cp '));
  const artifactUploadIndices = s3CopyCalls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => !call.includes('.yml s3://'))
    .map(({ index }) => index);
  const metadataUploadIndices = s3CopyCalls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.includes('.yml s3://'))
    .map(({ index }) => index);

  assert.equal(artifactUploadIndices.length, 10);
  assert.equal(metadataUploadIndices.length, 4);
  assert.ok(Math.max(...artifactUploadIndices) < Math.min(...metadataUploadIndices));
  assert.match(calls.join('\n'), /aws cloudfront wait invalidation-completed/);
});

test('DeepSeek-only 只发布独立前缀下的五个制品和两份元数据', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  fs.rmSync(path.join(fixture.workspace, 'out', 'make', `Floatboat-${fixture.floatboatVersion}-arm64.dmg`));
  fs.rmSync(path.join(fixture.workspace, 'out', 'make', `Floatboat-${fixture.floatboatVersion}-x64.dmg`));
  fs.rmSync(path.join(fixture.workspace, 'out', 'make', `Floatboat-Setup-${fixture.floatboatVersion}-x64.exe`));
  fs.rmSync(path.join(fixture.workspace, 'out', 'make', `Floatboat-${fixture.floatboatVersion}-arm64.zip`));
  fs.rmSync(path.join(fixture.workspace, 'out', 'make', `Floatboat-${fixture.floatboatVersion}-x64.zip`));
  fs.rmSync(path.join(fixture.metadataDirectory, 'latest-mac.yml'));
  fs.rmSync(path.join(fixture.metadataDirectory, 'latest.yml'));

  const result = runPublish(fixture, 'deepseek-agent');

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Floatboat feed was untouched/);
  const releaseRoot = path.join(fixture.s3Root, 'aoe-desktop-releases');
  assert.deepEqual(fs.readdirSync(releaseRoot), ['deepseek-agent']);

  const calls = fs.readFileSync(fixture.callLog, 'utf8').trim().split('\n');
  const s3CopyCalls = calls.filter((call) => call.startsWith('aws s3 cp '));
  assert.equal(s3CopyCalls.length, 7);
  assert.ok(
    s3CopyCalls.every((call) => call.includes('s3://aoe-desktop-releases/deepseek-agent/')),
    'DeepSeek-only 不得写入 S3 根前缀',
  );
  assert.ok(
    calls.some((call) => call.includes('cloudfront create-invalidation') && call.includes('/deepseek-agent/*')),
    'DeepSeek-only 只能失效独立 CDN 前缀',
  );
  assert.equal(calls.some((call) => /s3:\/\/aoe-desktop-releases\/(latest|Floatboat-)/.test(call)), false);
});

test('CloudFront waiter 无权限时回退到 CDN 内容校验并保持发布成功', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = runPublish(fixture, 'deepseek-agent', { MOCK_CLOUDFRONT_WAIT_DENIED: '1' });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /falling back to CDN content polling/);
  assert.match(result.stdout, /CDN metadata matched on attempt 1/);
  assert.match(result.stdout, /Floatboat feed was untouched/);
  assert.match(result.stderr, /AccessDenied: cloudfront:GetInvalidation/);
});

test('缺少任一 DeepSeek 正式制品时在 S3 mutation 前失败', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.rmSync(
    path.join(
      fixture.workspace,
      'out',
      'make',
      `Floatboat-DeepSeek-Agent-${fixture.deepseekVersion}-arm64.dmg`,
    ),
  );

  const result = runPublish(fixture, 'deepseek-agent');

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Required updater release file is missing/);
  assert.equal(fs.readFileSync(fixture.callLog, 'utf8'), '');
});

test('本地元数据错误时在任何 S3 mutation 之前失败', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const metadataPath = path.join(fixture.metadataDirectory, 'latest.yml');
  const metadata = yaml.load(fs.readFileSync(metadataPath, 'utf8'));
  metadata.version = '9.9.9';
  fs.writeFileSync(metadataPath, yaml.dump(metadata));

  const result = runPublish(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /元数据版本不匹配/);
  assert.equal(fs.readFileSync(fixture.callLog, 'utf8'), '');
});
