import fs from 'node:fs/promises';
import path from 'node:path';

function ts() {
  return new Date().toISOString();
}

export function logPath(stateDir, key) {
  return path.join(stateDir, 'orchestrator', 'logs', `${String(key || 'default')}.log`);
}

export async function appendLog(stateDir, key, line) {
  const p = logPath(stateDir, key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const msg = `[${ts()}] ${String(line || '').trim()}\n`;
  await fs.appendFile(p, msg, { encoding: 'utf8' });
  return p;
}

