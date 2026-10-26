// ABOUTME: 验证发布工作流在签名后、收集制品前执行真实运行门禁，并传播失败。
'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function step(workflow, name) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `缺少步骤：${name}`);
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return { start, source: workflow.slice(start, next < 0 ? undefined : next) };
}

for (const filename of ['release.yml', 'nightly.yml']) {
  for (const arch of ['arm64', 'x64']) {
    test(`${filename} ${arch} 签名后运行门禁失败必须阻止收集制品`, () => {
      const workflow = readFileSync(path.join(__dirname, '../workflows', filename), 'utf8');
      const signature = step(workflow, `Verify signed and notarized app (${arch})`);
      const runtime = step(workflow, `Verify packaged Node and workbench (${arch})`);
      const collect = step(workflow, `Collect ${arch} ${filename === 'release.yml' ? 'production ' : ''}artifacts`);
      assert.ok(signature.start < runtime.start && runtime.start < collect.start);
      assert.doesNotMatch(runtime.source, /continue-on-error|if:/);
      assert.match(runtime.source, /packaged-workbench-runtime\.mjs/);
      const command = runtime.source.split('        run: |\n')[1]
        .split('\n').map(line => line.replace(/^          /, '')).join('\n')
        .replaceAll('${{ matrix.app_name }}', 'Floatboat DeepSeek Agent');
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'release-runtime-gate-')));
      try {
        mkdirSync(path.join(root, 'bin'));
        const executable = path.join(root, 'bin/node');
        writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PROBE_ARGUMENTS"\nexit 19\n', { mode: 0o755 });
        const argsPath = path.join(root, 'arguments.txt');
        const result = spawnSync('/bin/bash', ['-c', command], {
          cwd: root,
          env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, PROBE_ARGUMENTS: argsPath },
          encoding: 'utf8',
        });
        assert.equal(result.status, 19, result.stderr);
        assert.deepEqual(readFileSync(argsPath, 'utf8').trim().split('\n'), [
          'scripts/packaging/packaged-workbench-runtime.mjs',
          `${root}/out/Floatboat DeepSeek Agent-darwin-${arch}/Floatboat DeepSeek Agent.app/Contents/Resources`,
          arch,
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
