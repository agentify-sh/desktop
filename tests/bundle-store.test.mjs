import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { deleteBundle, getBundle, listBundles, saveBundle } from '../bundle-store.mjs';

test('bundle-store: save/get/list/delete lifecycle', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-bundles-'));
  const attachment = path.join(stateDir, 'README.md');
  const contextDir = path.join(stateDir, 'src');
  await fs.writeFile(attachment, 'hello\n', 'utf8');
  await fs.mkdir(contextDir, { recursive: true });

  const saved = await saveBundle(stateDir, {
    name: 'repo-review',
    promptPrefix: 'Review carefully.',
    attachments: [attachment],
    contextPaths: [contextDir]
  });
  assert.equal(saved.name, 'repo-review');
  assert.equal(saved.promptPrefix, 'Review carefully.');
  assert.equal(saved.attachments.length, 1);
  assert.equal(saved.contextPaths.length, 1);

  const got = await getBundle(stateDir, 'repo-review');
  assert.equal(got?.name, 'repo-review');

  const listed = await listBundles(stateDir);
  assert.equal(listed.length, 1);

  const deleted = await deleteBundle(stateDir, 'repo-review');
  assert.equal(deleted, true);
  assert.equal(await getBundle(stateDir, 'repo-review'), null);
});

test('bundle-store: ignores blank attachment/context entries', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-bundles-blank-'));
  const attachment = path.join(stateDir, 'README.md');
  const contextDir = path.join(stateDir, 'src');
  await fs.writeFile(attachment, 'hello\n', 'utf8');
  await fs.mkdir(contextDir, { recursive: true });
  const saved = await saveBundle(stateDir, {
    name: 'blank-filter',
    attachments: ['   ', attachment, ''],
    contextPaths: ['', contextDir, '   ']
  });

  assert.equal(saved.attachments.length, 1);
  assert.equal(saved.contextPaths.length, 1);
  assert.notEqual(saved.attachments[0], process.cwd());
  assert.notEqual(saved.contextPaths[0], process.cwd());
});

test('bundle-store: ignores legacy relative paths when reading persisted bundles', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-bundles-legacy-relative-'));
  const bundleFile = path.join(stateDir, 'bundles.json');
  await fs.writeFile(
    bundleFile,
    JSON.stringify(
      {
        bundles: [
          {
            name: 'legacy',
            promptPrefix: 'Review carefully.',
            attachments: ['./README.md', '/tmp/abs.txt'],
            contextPaths: ['./src', '/tmp/abs-dir']
          }
        ]
      },
      null,
      2
    ),
    'utf8'
  );

  const got = await getBundle(stateDir, 'legacy');
  assert.equal(got?.attachments.includes('/tmp/abs.txt'), true);
  assert.equal(got?.contextPaths.includes('/tmp/abs-dir'), true);
  assert.equal(got?.attachments.some((p) => !path.isAbsolute(p)), false);
  assert.equal(got?.contextPaths.some((p) => !path.isAbsolute(p)), false);
  assert.equal(got?.attachments.includes(path.resolve('./README.md')), false);
  assert.equal(got?.contextPaths.includes(path.resolve('./src')), false);
});
