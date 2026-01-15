import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { buildReviewPacket } from '../orchestrator/git-diff.mjs';

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (b) => out.push(String(b)));
    child.stderr.on('data', (b) => err.push(String(b)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: out.join(''), stderr: err.join('') }));
  });
}

async function tmpRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-git-'));
  await run('git', ['init'], dir);
  await run('git', ['config', 'user.email', 'test@example.com'], dir);
  await run('git', ['config', 'user.name', 'Test'], dir);
  await fs.writeFile(path.join(dir, 'README.md'), 'hi\n', 'utf8');
  await run('git', ['add', '.'], dir);
  await run('git', ['commit', '-m', 'init'], dir);
  return dir;
}

test('git-diff: builds a bounded review packet', async () => {
  const dir = await tmpRepo();
  await fs.writeFile(path.join(dir, 'src.js'), 'export function a(){return 1}\n', 'utf8');

  const pkt = await buildReviewPacket({ workspaceDir: dir, maxChars: 2000, maxFiles: 10, maxHunksPerFile: 2 });
  assert.equal(typeof pkt.stat, 'string');
  assert.ok(Array.isArray(pkt.files));
  assert.ok(typeof pkt.patch === 'string');
  assert.ok(pkt.patch.length <= 2000);
});
