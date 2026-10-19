#!/usr/bin/env node
// ABOUTME: 使用本地替身验证内部 Nightly/RC updater 的发布顺序、制品边界与显式切轨门禁。
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');
const scriptPath = path.join(__dirname, 'publish-internal-updater.sh');
function executable(file, content) { fs.writeFileSync(file, content, { mode: 0o755 }); }
function metadata(dir, version, names) {
  const files = names.map((url) => { const body=fs.readFileSync(path.join(dir,url)); return {url,size:body.length,sha512:crypto.createHash('sha512').update(body).digest('base64')}; });
  const primary=files.find((item)=>item.url.endsWith('.zip')) || files[0];
  return {version,files,path:primary.url,sha512:primary.sha512,releaseDate:'2026-10-19T00:00:00.000Z'};
}
function fixture(macX64 = false, version = '1.2.4-n.20261019-abcdef') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'internal-updater-')); const workspace=path.join(root,'workspace'); const artifacts=path.join(workspace,'out/make'); const dist=path.join(workspace,'dist'); const bin=path.join(root,'bin'); const store=path.join(root,'s3'); const log=path.join(root,'calls');
  for (const dir of [artifacts,dist,bin]) fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(log,'');
  const mac=[`Floatboat-${version}-arm64.dmg`,`Floatboat-${version}-arm64.zip`];
  if(macX64) mac.push(`Floatboat-${version}-x64.dmg`,`Floatboat-${version}-x64.zip`);
  const win=[`Floatboat-Setup-${version}-x64.exe`];
  const deep=`Floatboat-DeepSeek-Agent-${version}-deepseek-arm64.zip`;
  for(const name of [...mac,...win,deep]) fs.writeFileSync(path.join(artifacts,name),`content:${name}`);
  fs.writeFileSync(path.join(dist,'latest-mac.yml'),yaml.dump(metadata(artifacts,version,mac)));
  fs.writeFileSync(path.join(dist,'latest.yml'),yaml.dump(metadata(artifacts,version,win)));
  executable(path.join(bin,'aws'), `#!/usr/bin/env node
const fs=require('fs'),path=require('path'); const a=process.argv.slice(2), root=process.env.MOCK_S3_ROOT, log=process.env.MOCK_LOG; fs.appendFileSync(log,'aws '+a.join(' ')+'\\n'); const o=n=>{const i=a.indexOf(n);return i<0?'':a[i+1]};
if(a[0]==='s3'&&a[1]==='cp'){const u=new URL(a[3]),d=path.join(root,u.hostname,u.pathname.slice(1));fs.mkdirSync(path.dirname(d),{recursive:true});fs.copyFileSync(a[2],d);fs.writeFileSync(d+'.meta',JSON.stringify({CacheControl:o('--cache-control'),ContentType:o('--content-type')||'application/octet-stream'}));process.exit(0)}
if(a[0]==='s3api'&&a[1]==='head-object'){const d=path.join(root,o('--bucket'),o('--key')),m=JSON.parse(fs.readFileSync(d+'.meta'));process.stdout.write(JSON.stringify({ContentLength:fs.statSync(d).size,ETag:'"etag"',...m}));process.exit(0)}
if(a[0]==='cloudfront'&&a[1]==='create-invalidation'){process.stdout.write(JSON.stringify({Invalidation:{Id:'INV',Status:'InProgress'}}));process.exit(0)} if(a[0]==='cloudfront'&&a[1]==='wait')process.exit(0); process.exit(2);`);
  executable(path.join(bin,'curl'), `#!/usr/bin/env node
const fs=require('fs'),path=require('path');const a=process.argv.slice(2),o=n=>{const i=a.indexOf(n);return i<0?'':a[i+1]},u=new URL([...a].reverse().find(x=>/^https?:/.test(x))),s=path.join(process.env.MOCK_S3_ROOT,'aoe-desktop-releases',u.pathname.slice(1));fs.appendFileSync(process.env.MOCK_LOG,'curl '+a.join(' ')+'\\n');if(!fs.existsSync(s))process.exit(22);if(a.includes('--head')){fs.writeFileSync(o('--dump-header'),'HTTP/2 200\\r\\ncontent-length: '+fs.statSync(s).size+'\\r\\n\\r\\n')}else{const d=o('--output');fs.mkdirSync(path.dirname(d),{recursive:true});fs.copyFileSync(s,d)}`);
  return {root,workspace,artifacts,dist,bin,store,log,version,deep};
}
function run(f, extra={}) { return spawnSync('bash',[scriptPath],{cwd:f.workspace,encoding:'utf8',env:{...process.env,PATH:`${f.bin}:${process.env.PATH}`,GITHUB_WORKSPACE:f.workspace,TRACK:'nightly',FLOATBOAT_VERSION:f.version,PREFERRED_PRERELEASE:'unchanged',MOCK_S3_ROOT:f.store,MOCK_LOG:f.log,...extra}}); }
test('nightly 可按 metadata 实际集合发布 arm64 mac 与 Windows，且排除 DeepSeek',t=>{const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));const r=run(f);assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);const prefix=path.join(f.store,'aoe-desktop-releases/internal/nightly');assert.ok(fs.existsSync(path.join(prefix,`Floatboat-${f.version}-arm64.zip`)));assert.ok(fs.existsSync(path.join(prefix,`Floatboat-Setup-${f.version}-x64.exe`)));assert.equal(fs.existsSync(path.join(prefix,f.deep)),false);assert.equal(fs.existsSync(path.join(f.store,'aoe-desktop-releases/internal/channel.yml')),false);const calls=fs.readFileSync(f.log,'utf8');assert.ok(calls.indexOf('-arm64.zip s3://') < calls.indexOf('latest-mac.yml s3://'));});
test('显式同轨切换只在 feed 验证后写 channel.yml 并公网回读',t=>{const f=fixture(true, '1.2.4-rc.3');t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));const r=run(f,{TRACK:'rc',PREFERRED_PRERELEASE:'rc',FLOATBOAT_VERSION:f.version});assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);const channel=path.join(f.store,'aoe-desktop-releases/internal/channel.yml');assert.deepEqual(yaml.load(fs.readFileSync(channel,'utf8')),{schemaVersion:1,preferredPrerelease:'rc'});const calls=fs.readFileSync(f.log,'utf8');assert.ok(calls.indexOf('release.aoe.chat/internal/rc/latest.yml') < calls.indexOf(' s3://aoe-desktop-releases/internal/channel.yml'));assert.match(calls,/curl .*https:\/\/release\.aoe\.chat\/internal\/channel\.yml/);});
test('拒绝跨轨切换且不触碰 S3',t=>{const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));const r=run(f,{PREFERRED_PRERELEASE:'rc'});assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/必须与 TRACK 一致/);assert.equal(fs.readFileSync(f.log,'utf8'),'');});
test('metadata 引用 DeepSeek 时在上传前失败',t=>{const f=fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));fs.writeFileSync(path.join(f.dist,'latest-mac.yml'),yaml.dump(metadata(f.artifacts,f.version,[f.deep])));const r=run(f);assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/DeepSeek/);assert.equal(fs.readFileSync(f.log,'utf8'),'');});


test('nightly 版本不得发布到 RC 轨道，且不触碰 S3', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = run(f, { TRACK: 'rc' });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /RC 轨道版本格式无效/);
  assert.equal(fs.readFileSync(f.log, 'utf8'), '');
});

test('RC 版本不得发布到 nightly 轨道，且不触碰 S3', (t) => {
  const f = fixture(false, '1.2.4-rc.3');
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = run(f);

  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Nightly 轨道版本格式无效/);
  assert.equal(fs.readFileSync(f.log, 'utf8'), '');
});

test('stable 版本不得发布到任一内部轨道，且不触碰 S3', (t) => {
  for (const track of ['nightly', 'rc']) {
    const f = fixture(false, '1.2.4');
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

    const result = run(f, { TRACK: track });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /轨道版本格式无效/);
    assert.equal(fs.readFileSync(f.log, 'utf8'), '');
  }
});
