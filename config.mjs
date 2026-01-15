import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { ensureStateDir } from './state.mjs';

function clampNumber(v, { min, max, fallback }) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  }
  return fallback;
}

async function atomicWriteFile(filePath, data, { mode } = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data, mode ? { encoding: 'utf8', mode } : { encoding: 'utf8' });
  await fs.rename(tmp, filePath);
}

export function configPath(stateDir) {
  return path.join(stateDir, 'config.json');
}

export function defaultConfig() {
  return {
    showTabsByDefault: false,
    maxTabs: 12,
    maxParallelQueries: 6,
    minQueryGapMs: 250,
    minQueryGapMsGlobal: 100,
    queryGapMaxWaitMs: 5_000
  };
}

export function sanitizeConfig(raw = {}) {
  const d = defaultConfig();
  const obj = raw && typeof raw === 'object' ? raw : {};
  return {
    showTabsByDefault: asBool(obj.showTabsByDefault, d.showTabsByDefault),
    maxTabs: clampNumber(obj.maxTabs, { min: 1, max: 50, fallback: d.maxTabs }),
    maxParallelQueries: clampNumber(obj.maxParallelQueries, { min: 1, max: 50, fallback: d.maxParallelQueries }),
    minQueryGapMs: clampNumber(obj.minQueryGapMs, { min: 0, max: 30_000, fallback: d.minQueryGapMs }),
    minQueryGapMsGlobal: clampNumber(obj.minQueryGapMsGlobal, { min: 0, max: 30_000, fallback: d.minQueryGapMsGlobal }),
    queryGapMaxWaitMs: clampNumber(obj.queryGapMaxWaitMs, { min: 0, max: 120_000, fallback: d.queryGapMaxWaitMs })
  };
}

export async function readConfig(stateDir) {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(stateDir), 'utf8'));
    return sanitizeConfig(raw);
  } catch {
    return defaultConfig();
  }
}

export async function writeConfig(nextConfig, stateDir) {
  await ensureStateDir(stateDir);
  const cleaned = sanitizeConfig(nextConfig);
  await atomicWriteFile(configPath(stateDir), `${JSON.stringify(cleaned, null, 2)}\n`, { mode: 0o600 });
  return cleaned;
}

