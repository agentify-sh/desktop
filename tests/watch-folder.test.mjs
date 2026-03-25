import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createWatchFolderManager, defaultWatchFolder } from '../watch-folder.mjs';
import { listArtifacts } from '../artifact-store.mjs';

test('watch-folder: scan ingests new files and does not duplicate unchanged files', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-watch-'));
  const manager = createWatchFolderManager({ stateDir, pollMs: 60_000 });
  await manager.start();
  const inbox = defaultWatchFolder(stateDir);

  await fs.writeFile(path.join(inbox, 'note.txt'), 'hello\n', 'utf8');
  const first = await manager.scan();
  assert.equal(first.ingested.length, 1);

  const second = await manager.scan();
  assert.equal(second.ingested.length, 0);

  await fs.writeFile(path.join(inbox, 'note.txt'), 'hello again\n', 'utf8');
  const third = await manager.scan();
  assert.equal(third.ingested.length, 1);

  const artifacts = await listArtifacts({ stateDir, limit: 10 });
  assert.equal(artifacts.length, 2);
  await manager.stop();
});

test('watch-folder: scan skips invalid linked files and continues indexing valid files', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-watch-linked-skip-'));
  const manager = createWatchFolderManager({ stateDir, pollMs: 60_000 });
  await manager.start();
  const inbox = defaultWatchFolder(stateDir);

  const valid = path.join(inbox, 'note.txt');
  const target = path.join(stateDir, 'outside.txt');
  const symlinkPath = path.join(inbox, 'link.txt');
  await fs.writeFile(valid, 'hello\n', 'utf8');
  await fs.writeFile(target, 'outside\n', 'utf8');
  await fs.symlink(target, symlinkPath);

  const result = await manager.scan();
  assert.equal(result.ingested.length, 1);
  assert.equal(path.basename(result.ingested[0].path), 'note.txt');

  const artifacts = await listArtifacts({ stateDir, limit: 10 });
  assert.equal(artifacts.length, 1);
  assert.equal(path.basename(artifacts[0].path), 'note.txt');
  await manager.stop();
});

test('watch-folder: supports add/remove/list and blocks overlapping roots', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-watch-folders-'));
  const manager = createWatchFolderManager({ stateDir, pollMs: 60_000 });
  await manager.start();

  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-watch-custom-'));
  const added = await manager.addFolder({ name: 'sprites', folderPath: base });
  assert.equal(added.name, 'sprites');

  const folders = await manager.listFolders();
  assert.equal(folders.some((f) => f.name === 'inbox'), true);
  assert.equal(folders.some((f) => f.name === 'sprites'), true);

  await assert.rejects(
    async () => await manager.addFolder({ name: 'nested', folderPath: path.join(base, 'nested') }),
    /watch_folder_overlaps_existing/
  );

  const nestedReal = path.join(base, 'nested-real');
  await fs.mkdir(nestedReal, { recursive: true });
  const symlinkParent = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-watch-symlink-'));
  const symlinkPath = path.join(symlinkParent, 'nested-link');
  await fs.symlink(nestedReal, symlinkPath);
  await assert.rejects(async () => await manager.addFolder({ name: 'nested-link', folderPath: symlinkPath }), /watch_folder_overlaps_existing/);

  const removed = await manager.removeFolder({ name: 'sprites' });
  assert.equal(removed, true);
  await manager.stop();
});

test('watch-folder: rejects filesystem root', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-watch-root-'));
  const manager = createWatchFolderManager({ stateDir, pollMs: 60_000 });
  await manager.start();
  await assert.rejects(
    async () => await manager.addFolder({ name: 'root', folderPath: path.parse(process.cwd()).root }),
    /watch_folder_cannot_be_filesystem_root/
  );
  await manager.stop();
});

test('watch-folder: rejects blank folder path instead of resolving cwd', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-watch-blank-'));
  const manager = createWatchFolderManager({ stateDir, pollMs: 60_000 });
  await manager.start();
  await assert.rejects(async () => await manager.addFolder({ name: 'blank', folderPath: '   ' }), /missing_watch_folder_path/);
  await manager.stop();
});

test('watch-folder: rejects existing file path instead of crashing', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-watch-file-path-'));
  const manager = createWatchFolderManager({ stateDir, pollMs: 60_000 });
  await manager.start();
  const filePath = path.join(stateDir, 'not-a-dir.txt');
  await fs.writeFile(filePath, 'hello\n', 'utf8');
  await assert.rejects(async () => await manager.addFolder({ name: 'filey', folderPath: filePath }), /watch_folder_not_directory/);
  await manager.stop();
});

test('watch-folder: ignores legacy relative paths when reading persisted state', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-watch-legacy-relative-'));
  const manager = createWatchFolderManager({ stateDir, pollMs: 60_000 });
  const watchDir = path.join(stateDir, 'watch-folders');
  await fs.mkdir(watchDir, { recursive: true });
  await fs.writeFile(
    path.join(watchDir, 'state.json'),
    JSON.stringify(
      {
        folders: [
          { name: 'relative', path: './sprites', isDefault: false },
          { name: 'absolute', path: path.join(stateDir, 'abs-folder'), isDefault: false }
        ],
        files: {}
      },
      null,
      2
    ),
    'utf8'
  );

  await manager.start();
  const folders = await manager.listFolders();
  assert.equal(folders.some((f) => f.name === 'relative'), false);
  assert.equal(folders.some((f) => f.name === 'absolute'), true);
  assert.equal(folders.some((f) => f.path === path.resolve('./sprites')), false);
  await manager.stop();
});

test('watch-folder: ignores persisted file paths when reading state', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-watch-legacy-file-'));
  const manager = createWatchFolderManager({ stateDir, pollMs: 60_000 });
  const watchDir = path.join(stateDir, 'watch-folders');
  const filePath = path.join(stateDir, 'not-a-dir.txt');
  await fs.mkdir(watchDir, { recursive: true });
  await fs.writeFile(filePath, 'hello\n', 'utf8');
  await fs.writeFile(
    path.join(watchDir, 'state.json'),
    JSON.stringify(
      {
        folders: [
          { name: 'filey', path: filePath, isDefault: false },
          { name: 'absolute', path: path.join(stateDir, 'abs-folder'), isDefault: false }
        ],
        files: {}
      },
      null,
      2
    ),
    'utf8'
  );

  await manager.start();
  const folders = await manager.listFolders();
  assert.equal(folders.some((f) => f.name === 'filey'), false);
  assert.equal(folders.some((f) => f.name === 'absolute'), true);
  await manager.stop();
});
