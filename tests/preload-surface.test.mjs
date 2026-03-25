import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

for (const preloadFile of ['preload.cjs', 'preload.mjs']) {
  test(`preload surface: ${preloadFile} does not expose unsupported orchestrator APIs`, async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'ui', preloadFile), 'utf8');
    assert.ok(src.includes('createTab:'), 'expected desktop tab API');
    assert.ok(!src.includes('getOrchestrators:'), 'should not expose orchestrator APIs in preload');
    assert.ok(!src.includes('startOrchestrator:'), 'should not expose orchestrator APIs in preload');
    assert.ok(!src.includes('stopOrchestrator:'), 'should not expose orchestrator APIs in preload');
    assert.ok(!src.includes('stopAllOrchestrators:'), 'should not expose orchestrator APIs in preload');
    assert.ok(!src.includes('setWorkspaceForKey:'), 'should not expose workspace APIs in preload');
    assert.ok(!src.includes('getWorkspaceForKey:'), 'should not expose workspace APIs in preload');
  });
}

test('preload surface: preload.cjs and preload.mjs expose the same desktop API keys', async () => {
  const cjs = await fs.readFile(path.join(__dirname, '..', 'ui', 'preload.cjs'), 'utf8');
  const mjs = await fs.readFile(path.join(__dirname, '..', 'ui', 'preload.mjs'), 'utf8');

  const extractKeys = (src) =>
    Array.from(src.matchAll(/^\s{2}([a-zA-Z0-9_]+):/gm))
      .map((match) => match[1])
      .sort();

  assert.deepEqual(extractKeys(mjs), extractKeys(cjs));
});
