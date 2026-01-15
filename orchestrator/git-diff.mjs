import { spawn } from 'node:child_process';
import path from 'node:path';

function run(cmd, args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    const t = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
    }, timeoutMs);
    t.unref?.();
    child.stdout.on('data', (b) => out.push(String(b)));
    child.stderr.on('data', (b) => err.push(String(b)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout: out.join(''), stderr: err.join('') });
    });
  });
}

function scorePath(p) {
  const s = String(p || '').toLowerCase();
  if (/test|__tests__|spec\./.test(s)) return 90;
  if (/auth|security|token|secret|cors|policy|permission/.test(s)) return 85;
  if (/config|workflow|ci|github|wrangler|docker|k8s|nginx/.test(s)) return 80;
  if (/\.(md|txt)$/.test(s)) return 30;
  return 50;
}

export async function buildReviewPacket({ workspaceDir, maxChars = 35_000, maxFiles = 20, maxHunksPerFile = 6 } = {}) {
  const cwd = path.resolve(workspaceDir || process.cwd());

  const stat = await run('git', ['diff', '--stat'], { cwd, timeoutMs: 30_000 });
  const nameStatus = await run('git', ['diff', '--name-status'], { cwd, timeoutMs: 30_000 });
  const diff = await run('git', ['diff', '--unified=3'], { cwd, timeoutMs: 60_000 });

  const files = String(nameStatus.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split(/\s+/);
      const file = rest.join(' ');
      return { status, file, score: scorePath(file) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  // Very simple hunk selection: take first N hunks for prioritized files.
  const full = String(diff.stdout || '');
  const perFile = new Map();
  let current = null;
  for (const line of full.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = line;
      perFile.set(current, []);
      continue;
    }
    if (!current) continue;
    perFile.get(current).push(line);
  }

  const selected = [];
  let used = 0;
  for (const f of files) {
    // Find the diff section that matches this file (best-effort).
    const key = Array.from(perFile.keys()).find((k) => k.includes(` b/${f.file}`) || k.includes(` a/${f.file}`));
    if (!key) continue;
    const lines = perFile.get(key) || [];

    let hunks = 0;
    const buf = [key];
    for (const l of lines) {
      if (l.startsWith('@@')) hunks += 1;
      if (hunks > maxHunksPerFile) break;
      buf.push(l);
    }

    const block = buf.join('\n').trim() + '\n';
    if (used + block.length > maxChars) break;
    selected.push(block);
    used += block.length;
  }

  const packet = {
    ok: stat.code === 0 && diff.code === 0,
    stat: String(stat.stdout || '').trim(),
    files: files.map((f) => ({ status: f.status, file: f.file })),
    patch: selected.join('\n').trim()
  };
  return packet;
}

