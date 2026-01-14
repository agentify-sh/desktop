import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

async function atomicWriteFile(filePath, data, { mode } = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data, mode ? { encoding: 'utf8', mode } : { encoding: 'utf8' });
  await fs.rename(tmp, filePath);
}

export function defaultStateDir() {
  return process.env.AGENTIFY_DESKTOP_STATE_DIR || path.join(os.homedir(), '.agentify-desktop');
}

export function tokenPath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'token.txt');
}

export function statePath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'state.json');
}

export async function ensureStateDir(stateDir = defaultStateDir()) {
  await fs.mkdir(stateDir, { recursive: true });
}

export async function readToken(stateDir = defaultStateDir()) {
  const tokenFromEnv = (process.env.AGENTIFY_DESKTOP_TOKEN || '').trim();
  if (tokenFromEnv) return tokenFromEnv;
  try {
    return (await fs.readFile(tokenPath(stateDir), 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function writeToken(token, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  await atomicWriteFile(tokenPath(stateDir), `${token}\n`, { mode: 0o600 });
}

export async function ensureToken(stateDir = defaultStateDir()) {
  const existing = await readToken(stateDir);
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('hex');
  await writeToken(token, stateDir);
  return token;
}

export async function readState(stateDir = defaultStateDir()) {
  try {
    return JSON.parse(await fs.readFile(statePath(stateDir), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeState(state, stateDir = defaultStateDir()) {
  await ensureStateDir(stateDir);
  await atomicWriteFile(statePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}
