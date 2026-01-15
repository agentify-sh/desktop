import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { detectWorkspaceRoot, detectTestCommand, detectPackageManager } from '../orchestrator/workspace.mjs';

async function tmp() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-ws-'));
}

test('workspace: detects workspace root by markers', async () => {
  const dir = await tmp();
  const nested = path.join(dir, 'a', 'b');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -v' } }), 'utf8');
  const root = await detectWorkspaceRoot(nested);
  assert.equal(root, dir);
});

test('workspace: detects npm by lockfile', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -v' } }), 'utf8');
  await fs.writeFile(path.join(dir, 'package-lock.json'), 'x', 'utf8');
  const pm = await detectPackageManager(dir);
  assert.equal(pm, 'npm');
  const cmd = await detectTestCommand(dir);
  assert.equal(cmd, 'npm test');
});

test('workspace: detects pnpm by lockfile', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -v' } }), 'utf8');
  await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'x', 'utf8');
  const pm = await detectPackageManager(dir);
  assert.equal(pm, 'pnpm');
  const cmd = await detectTestCommand(dir);
  assert.equal(cmd, 'pnpm test');
});

