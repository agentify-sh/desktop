import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { prepareQueryContext } from '../context-packer.mjs';

test('context-packer: packs text files and auto-attaches binary files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-context-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'index.js'), 'export function sprite(){ return "ok"; }\n', 'utf8');
  await fs.writeFile(path.join(dir, 'sprite.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

  const packed = await prepareQueryContext({
    prompt: 'Use this repo context.',
    promptPrefix: 'Be concise.',
    contextPaths: [dir]
  });

  assert.match(packed.prompt, /Be concise\./);
  assert.match(packed.prompt, /Packed Context Summary/);
  assert.match(packed.prompt, /src\/index\.js/);
  assert.match(packed.prompt, /Use this repo context\./);
  assert.ok(packed.attachments.some((p) => p.endsWith('sprite.png')));
  assert.equal(packed.context.filesScanned >= 2, true);
  assert.equal(packed.context.summary.inlineFileCount >= 1, true);
  assert.equal(packed.context.summary.autoAttachmentCount, 1);
  assert.equal(Array.isArray(packed.context.summary.autoAttachments), true);
});

test('context-packer: chunks large files within budget', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-context-big-'));
  const large = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
  await fs.writeFile(path.join(dir, 'big.ts'), large, 'utf8');

  const packed = await prepareQueryContext({
    prompt: 'Summarize.',
    contextPaths: [dir],
    maxContextChars: 5000,
    maxChunkChars: 1000,
    maxChunksPerFile: 2,
    maxInlineFiles: 1
  });

  assert.match(packed.prompt, /chunk 1\/2/);
  assert.match(packed.prompt, /big\.ts/);
  assert.ok(packed.prompt.length <= 7000);
  assert.equal(packed.context.summary.inlineChunkCount >= 1, true);
});

test('context-packer: ignores blank explicit attachments instead of resolving cwd', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-context-attach-'));
  const target = path.join(dir, 'note.txt');
  await fs.writeFile(target, 'hello\n', 'utf8');

  const packed = await prepareQueryContext({
    prompt: 'Use attachment only.',
    attachments: ['   ', target, ''],
    cwd: dir
  });

  assert.deepEqual(packed.attachments, [target]);
  assert.equal(packed.context.summary.explicitAttachmentCount, 1);
});

test('context-packer: rejects missing explicit attachments early', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-context-missing-attach-'));
  const missing = path.join(dir, 'missing.png');

  await assert.rejects(
    async () =>
      await prepareQueryContext({
        prompt: 'Use attachment only.',
        attachments: [missing],
        cwd: dir
      }),
    /missing_attachment_path/
  );
});

test('context-packer: skips symlinked files and directories from context paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-context-symlink-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-context-outside-'));
  const outsideFile = path.join(outsideDir, 'secret.txt');
  await fs.writeFile(outsideFile, 'outside-secret\n', 'utf8');
  const insideFile = path.join(dir, 'inside.txt');
  await fs.writeFile(insideFile, 'inside\n', 'utf8');
  await fs.symlink(outsideFile, path.join(dir, 'secret-link.txt'));
  await fs.symlink(outsideDir, path.join(dir, 'outside-dir-link'));

  const packed = await prepareQueryContext({
    prompt: 'Summarize.',
    contextPaths: [dir]
  });

  assert.match(packed.prompt, /inside\.txt/);
  assert.doesNotMatch(packed.prompt, /secret-link\.txt/);
  assert.doesNotMatch(packed.prompt, /outside-secret/);
  assert.equal(packed.attachments.some((p) => p.includes('secret-link.txt')), false);
  assert.equal(packed.context.filesScanned, 1);
  assert.equal(packed.context.summary.omittedCount, 0);
});

test('context-packer: prioritizes source files over dotfiles and workflow metadata', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-context-priority-'));
  await fs.mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  await fs.writeFile(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI\n', 'utf8');
  await fs.writeFile(path.join(dir, 'src', 'main.js'), 'export const run = () => 42;\n', 'utf8');

  const packed = await prepareQueryContext({
    prompt: 'Summarize.',
    contextPaths: [dir],
    maxInlineFiles: 1,
    maxContextChars: 10000
  });

  assert.match(packed.prompt, /src\/main\.js/);
  assert.equal(packed.context.summary.inlineFiles.length, 1);
  assert.match(packed.context.summary.inlineFiles[0], /src\/main\.js$/);
  assert.equal(packed.context.summary.omittedByReason.inline_limit, 2);
});
