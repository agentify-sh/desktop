import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { defaultConfig, sanitizeConfig, readConfig, writeConfig } from '../config.mjs';

test('config: sanitizeConfig clamps and defaults', () => {
  const cleaned = sanitizeConfig({
    showTabsByDefault: 'yes',
    maxTabs: 0,
    maxParallelQueries: 999,
    minQueryGapMs: -5,
    minQueryGapMsGlobal: '250',
    queryGapMaxWaitMs: 99999999
  });

  assert.equal(cleaned.showTabsByDefault, true);
  assert.equal(cleaned.maxTabs, 1);
  assert.equal(cleaned.maxParallelQueries, 50);
  assert.equal(cleaned.minQueryGapMs, 0);
  assert.equal(cleaned.minQueryGapMsGlobal, 250);
  assert.equal(cleaned.queryGapMaxWaitMs, 120000);
});

test('config: readConfig returns defaults when missing/invalid', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-config-'));
  const cfg = await readConfig(dir);
  assert.deepEqual(cfg, defaultConfig());
});

test('config: writeConfig persists sanitized values', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentify-desktop-config-'));
  const saved = await writeConfig({ maxTabs: 2, maxParallelQueries: 3, showTabsByDefault: true }, dir);
  assert.equal(saved.maxTabs, 2);
  assert.equal(saved.maxParallelQueries, 3);
  assert.equal(saved.showTabsByDefault, true);

  const re = await readConfig(dir);
  assert.deepEqual(re, saved);
});

