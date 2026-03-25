import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { artifactsIndexPath, artifactsRoot, ensureArtifactsDir, listArtifacts, registerArtifact } from '../artifact-store.mjs';

test('artifact-store: registers and lists artifacts newest first', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-artifacts-'));
  const dir = await ensureArtifactsDir({ stateDir, tabId: 'tab-1', tabKey: 'repo', vendorId: 'chatgpt' });
  assert.ok(dir.startsWith(artifactsRoot(stateDir)));
  await fs.writeFile(path.join(dir, 'sprite.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(dir, 'spec.txt'), 'spec\n', 'utf8');

  const first = await registerArtifact({
    stateDir,
    tabId: 'tab-1',
    tabKey: 'repo',
    vendorId: 'chatgpt',
    kind: 'image',
    filePath: path.join(dir, 'sprite.png'),
    mime: 'image/png'
  });
  const second = await registerArtifact({
    stateDir,
    tabId: 'tab-1',
    tabKey: 'repo',
    vendorId: 'chatgpt',
    kind: 'file',
    filePath: path.join(dir, 'spec.txt'),
    mime: 'text/plain'
  });

  const listed = await listArtifacts({ stateDir, tabId: 'tab-1', limit: 10 });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, second.id);
  assert.equal(listed[1].id, first.id);
});

test('artifact-store: rejects blank artifact path', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-artifacts-blank-'));
  await assert.rejects(
    async () =>
      await registerArtifact({
        stateDir,
        tabId: 'tab-1',
        kind: 'file',
        filePath: '   '
      }),
    /missing_artifact_path/
  );
});

test('artifact-store: rejects relative artifact path', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-artifacts-relative-'));
  await assert.rejects(
    async () =>
      await registerArtifact({
        stateDir,
        tabId: 'tab-1',
        kind: 'file',
        filePath: './spec.txt'
      }),
    /relative_artifact_path_not_allowed/
  );
});

test('artifact-store: rejects missing artifact file', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-artifacts-missing-file-'));
  await assert.rejects(
    async () =>
      await registerArtifact({
        stateDir,
        tabId: 'tab-1',
        kind: 'file',
        filePath: path.join(stateDir, 'missing.txt')
      }),
    /missing_artifact_file/
  );
});

test('artifact-store: rejects directory artifact path', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-artifacts-dir-path-'));
  const dirPath = path.join(stateDir, 'not-a-file');
  await fs.mkdir(dirPath, { recursive: true });
  await assert.rejects(
    async () =>
      await registerArtifact({
        stateDir,
        tabId: 'tab-1',
        kind: 'file',
        filePath: dirPath
      }),
    /artifact_path_not_file/
  );
});

test('artifact-store: rejects symlink artifact path', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-artifacts-symlink-path-'));
  const target = path.join(stateDir, 'target.txt');
  const linkPath = path.join(stateDir, 'link.txt');
  await fs.writeFile(target, 'hello\n', 'utf8');
  await fs.symlink(target, linkPath);
  await assert.rejects(
    async () =>
      await registerArtifact({
        stateDir,
        tabId: 'tab-1',
        kind: 'file',
        filePath: linkPath
      }),
    /artifact_symlink_not_allowed/
  );
});

test('artifact-store: rejects hard-linked artifact path', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-artifacts-hardlink-path-'));
  const target = path.join(stateDir, 'target.txt');
  const linkPath = path.join(stateDir, 'hardlink.txt');
  await fs.writeFile(target, 'hello\n', 'utf8');
  await fs.link(target, linkPath);
  await assert.rejects(
    async () =>
      await registerArtifact({
        stateDir,
        tabId: 'tab-1',
        kind: 'file',
        filePath: linkPath
      }),
    /artifact_link_count_not_allowed/
  );
});

test('artifact-store: ignores legacy relative artifact records on read', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-artifacts-legacy-relative-'));
  const absolute = path.join(stateDir, 'abs.txt');
  await fs.writeFile(absolute, 'hello\n', 'utf8');
  await fs.mkdir(path.dirname(artifactsIndexPath(stateDir)), { recursive: true });
  await fs.writeFile(
    artifactsIndexPath(stateDir),
    [
      JSON.stringify({ id: 'r1', tabId: 'tab-1', kind: 'file', path: './relative.txt', savedAt: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ id: 'a1', tabId: 'tab-1', kind: 'file', path: absolute, savedAt: '2026-01-02T00:00:00.000Z' })
    ].join('\n') + '\n',
    'utf8'
  );

  const listed = await listArtifacts({ stateDir, tabId: 'tab-1', limit: 10 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'a1');
  assert.equal(listed[0].path, absolute);
});

test('artifact-store: ignores missing and non-file artifact records on read', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-artifacts-missing-read-'));
  const absolute = path.join(stateDir, 'abs.txt');
  const directory = path.join(stateDir, 'dir-artifact');
  const missing = path.join(stateDir, 'missing.txt');
  await fs.writeFile(absolute, 'hello\n', 'utf8');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.dirname(artifactsIndexPath(stateDir)), { recursive: true });
  await fs.writeFile(
    artifactsIndexPath(stateDir),
    [
      JSON.stringify({ id: 'm1', tabId: 'tab-1', kind: 'file', path: missing, savedAt: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ id: 'd1', tabId: 'tab-1', kind: 'file', path: directory, savedAt: '2026-01-02T00:00:00.000Z' }),
      JSON.stringify({ id: 'a1', tabId: 'tab-1', kind: 'file', path: absolute, savedAt: '2026-01-03T00:00:00.000Z' })
    ].join('\n') + '\n',
    'utf8'
  );

  const listed = await listArtifacts({ stateDir, tabId: 'tab-1', limit: 10 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'a1');
  assert.equal(listed[0].path, absolute);
});

test('artifact-store: ignores legacy symlink and hard-link artifact records on read', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-artifacts-linked-read-'));
  const absolute = path.join(stateDir, 'abs.txt');
  const target = path.join(stateDir, 'target.txt');
  const symlinkPath = path.join(stateDir, 'link.txt');
  const hardlinkPath = path.join(stateDir, 'hardlink.txt');
  await fs.writeFile(absolute, 'hello\n', 'utf8');
  await fs.writeFile(target, 'linked\n', 'utf8');
  await fs.symlink(target, symlinkPath);
  await fs.link(target, hardlinkPath);
  await fs.mkdir(path.dirname(artifactsIndexPath(stateDir)), { recursive: true });
  await fs.writeFile(
    artifactsIndexPath(stateDir),
    [
      JSON.stringify({ id: 's1', tabId: 'tab-1', kind: 'file', path: symlinkPath, savedAt: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ id: 'h1', tabId: 'tab-1', kind: 'file', path: hardlinkPath, savedAt: '2026-01-02T00:00:00.000Z' }),
      JSON.stringify({ id: 'a1', tabId: 'tab-1', kind: 'file', path: absolute, savedAt: '2026-01-03T00:00:00.000Z' })
    ].join('\n') + '\n',
    'utf8'
  );

  const listed = await listArtifacts({ stateDir, tabId: 'tab-1', limit: 10 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'a1');
  assert.equal(listed[0].path, absolute);
});
