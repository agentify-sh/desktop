import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';

function isUuidLike(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim());
}

function extractSessionIdFromJson(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'id']) {
    const v = obj[k];
    if (isUuidLike(v)) return String(v).trim();
  }
  // Search any shallow string fields for uuid.
  for (const v of Object.values(obj)) {
    if (isUuidLike(v)) return String(v).trim();
  }
  return null;
}

export async function runCodexExec({
  workspaceDir,
  prompt,
  sessionId = null,
  timeoutMs = 30 * 60_000,
  onEvent,
  env = process.env
}) {
  const cwd = path.resolve(workspaceDir || process.cwd());
  const args = ['exec', '--json', '-C', cwd];
  if (sessionId) args.push('resume', sessionId);

  // Prompt is an argument to avoid stdin edge cases.
  args.push(String(prompt || ''));

  const child = spawn('codex', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let resolvedSessionId = sessionId || null;
  const out = [];
  const err = [];

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    out.push(line);
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch {}
    if (obj) {
      const sid = extractSessionIdFromJson(obj);
      if (!resolvedSessionId && sid) resolvedSessionId = sid;
      onEvent?.({ type: 'json', json: obj, raw: line, sessionId: resolvedSessionId });
    } else {
      onEvent?.({ type: 'text', text: line, sessionId: resolvedSessionId });
    }
  });

  child.stderr.on('data', (buf) => {
    const s = String(buf || '');
    err.push(s);
    onEvent?.({ type: 'stderr', text: s, sessionId: resolvedSessionId });
  });

  const timer = setTimeout(() => {
    try {
      child.kill('SIGTERM');
    } catch {}
  }, timeoutMs);
  timer.unref?.();

  const exit = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  try {
    rl.close();
  } catch {}

  const stdout = out.join('\n');
  const stderr = err.join('');

  return { ok: exit.code === 0, exit, sessionId: resolvedSessionId, stdout, stderr };
}

