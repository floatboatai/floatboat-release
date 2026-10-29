// ABOUTME: 构建前按 SHA-256 预填源码仓库打包脚本的下载缓存，让 ffmpeg.org / kernel.org 不可达时仍能发版。
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 源码仓库 dev 上的入库提交（PR #2626）；更早的 ref（如 v0.6.2）只会去上游下载，需要这里兜底。
const VENDORED_SOURCE_COMMIT = 'c3564cbc32ca8605d9bcd5933f5e045841fbf380';
const VENDORED_SOURCE_DIRECTORY = 'vendor/bundled-tool-sources';
const PINNED_SOURCE_MODULES = [
  ['scripts/bundle-ffmpeg.mjs', 'FFMPEG_SOURCE'],
  ['scripts/bundle-git.mjs', 'GIT_SOURCE'],
];
const DOWNLOAD_TIMEOUT_MS = 180_000;

async function loadPinnedSources(sourceRoot) {
  const sources = [];
  for (const [relativePath, exportName] of PINNED_SOURCE_MODULES) {
    const modulePath = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(modulePath)) continue;
    const pinnedModule = await import(pathToFileURL(modulePath).href);
    const source = pinnedModule[exportName];
    if (source?.url && source?.sha256 && source?.fileName) sources.push(source);
  }
  return sources;
}

// 命名必须与源码仓库 scripts/packaging/bundledToolDownload.mjs 的下载缓存一致，否则打包脚本不会命中。
function resolveCachePath(cacheDirectory, source) {
  return path.join(cacheDirectory, `${source.sha256.slice(0, 16)}-${source.fileName}`);
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sanitizeToken(value) {
  return (value || '').trim().replace(/^﻿/, '').trim();
}

function resolveDownloadCandidates(source, env) {
  const candidates = [];
  const token = sanitizeToken(env.SOURCE_REPO_TOKEN);
  if (env.SOURCE_REPO && token) {
    candidates.push({
      label: `${env.SOURCE_REPO}@${VENDORED_SOURCE_COMMIT.slice(0, 9)}`,
      url: `https://api.github.com/repos/${env.SOURCE_REPO}/contents/${VENDORED_SOURCE_DIRECTORY}/${source.fileName}?ref=${VENDORED_SOURCE_COMMIT}`,
      headers: {
        Accept: 'application/vnd.github.raw',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }
  candidates.push({ label: 'upstream', url: source.url, headers: {} });
  return candidates;
}

async function seedSource(source, { sourceRoot, cacheDirectory, env, fetchImpl, log }) {
  if (fs.existsSync(path.join(sourceRoot, VENDORED_SOURCE_DIRECTORY, source.fileName))) {
    log(`[Seed] ${source.fileName} 已随源码入库，跳过`);
    return 'vendored';
  }

  const cachePath = resolveCachePath(cacheDirectory, source);
  if (fs.existsSync(cachePath) && sha256Buffer(fs.readFileSync(cachePath)) === source.sha256) {
    log(`[Seed] ${source.fileName} 缓存已存在`);
    return 'cached';
  }

  fs.mkdirSync(cacheDirectory, { recursive: true });
  for (const candidate of resolveDownloadCandidates(source, env)) {
    try {
      const response = await fetchImpl(candidate.url, {
        headers: candidate.headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const actualSha256 = sha256Buffer(buffer);
      if (actualSha256 !== source.sha256) throw new Error(`SHA-256 不匹配：${actualSha256}`);
      const partialPath = `${cachePath}.seed-${process.pid}`;
      fs.writeFileSync(partialPath, buffer);
      fs.renameSync(partialPath, cachePath);
      log(`[Seed] ${source.fileName} 已从 ${candidate.label} 预填到 ${cachePath}`);
      return 'seeded';
    } catch (error) {
      log(`[Seed] ${source.fileName} 从 ${candidate.label} 获取失败：${error?.message || error}`);
    }
  }
  return 'missing';
}

async function seedBundledToolSources({
  sourceRoot = process.cwd(),
  cacheDirectory = path.join(os.tmpdir(), 'floatboat-bundled-tools'),
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const results = {};
  for (const source of await loadPinnedSources(sourceRoot)) {
    results[source.fileName] = await seedSource(source, { sourceRoot, cacheDirectory, env, fetchImpl, log });
  }
  return results;
}

module.exports = { VENDORED_SOURCE_COMMIT, resolveCachePath, seedBundledToolSources };

if (require.main === module) {
  // 预填只是兜底：失败时不阻断，由打包脚本自身的下载给出权威错误。
  seedBundledToolSources()
    .then((results) => {
      for (const [fileName, status] of Object.entries(results)) {
        if (status === 'missing') console.log(`::warning::未能预填 ${fileName}，打包脚本将回退到上游下载`);
      }
    })
    .catch((error) => console.log(`::warning::预填打包源码包失败：${error?.message || error}`));
}
