#!/usr/bin/env node
import path from 'node:path';

import { defaultStateDir } from './state.mjs';
import { ensureDesktopRunning, requestJson } from './mcp-lib.mjs';
import { parseAgentifyToolBlocks, normalizeToolRequest, findNextUnHandled } from './orchestrator/protocol.mjs';
import { detectWorkspaceRoot, detectTestCommand } from './orchestrator/workspace.mjs';
import { buildReviewPacket } from './orchestrator/git-diff.mjs';
import { formatResultBlock, makeChunkedMessages } from './orchestrator/posting.mjs';
import { getSession, setSession, getWorkspace, setWorkspace, isHandled, markHandled, loadHandled } from './orchestrator/storage.mjs';
import { runCodexExec } from './orchestrator/codex.mjs';
import { appendLog } from './orchestrator/logging.mjs';
import { assertWithin } from './orchestrator/security.mjs';
import fs from 'node:fs/promises';

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function argFlag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendNoWait(conn, { key, text, stopAfterSend = true }) {
  return await requestJson({
    ...conn,
    method: 'POST',
    path: '/send',
    body: { key, text, stopAfterSend: !!stopAfterSend }
  });
}

async function readThread(conn, { key, maxChars = 200_000 }) {
  const data = await requestJson({ ...conn, method: 'POST', path: '/read-page', body: { key, maxChars } });
  return String(data.text || '');
}

async function ensureReady(conn, { key, timeoutMs = 10 * 60_000 }) {
  await requestJson({ ...conn, method: 'POST', path: '/ensure-ready', body: { key, timeoutMs } });
}

async function runTestsMaybe({ workspaceDir, testCommand, timeoutMs = 20 * 60_000 }) {
  if (!testCommand) return { ok: null, command: null, output: '' };
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve) => {
    const child = spawn(testCommand, { cwd: workspaceDir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    child.on('close', (code) => {
      clearTimeout(t);
      const output = (out.join('') + err.join('')).trim();
      resolve({ ok: code === 0, command: testCommand, output });
    });
  });
}

async function handleCodexRun({ stateDir, key, mode, args, conn }) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('missing_prompt');

  let ws = await getWorkspace(stateDir, { key });
  if (!ws) {
    const root = await detectWorkspaceRoot(process.cwd());
    ws = await setWorkspace(stateDir, { key, workspace: { root } });
  }
  const workspaceDir = path.resolve(ws.root);
  assertWithin({ filePath: workspaceDir, allowedRoots: ws.allowRoots });

  const testCommand = (await detectTestCommand(workspaceDir)) || null;

  const priorSession = mode === 'interactive' ? await getSession(stateDir, { key }) : null;
  const sessionId = priorSession?.sessionId || null;

  let lastMilestone = '';
  let lastPostAt = 0;
  const postMilestone = async (msg) => {
    const now = Date.now();
    if (now - lastPostAt < 45_000) return;
    lastPostAt = now;
    await sendNoWait(conn, { key, text: `Progress update (no reply needed): ${msg}`, stopAfterSend: true }).catch(() => {});
  };

  await appendLog(stateDir, key, `codex.run start mode=${mode}`);
  const codexResult = await runCodexExec({
    workspaceDir,
    prompt,
    sessionId,
    onEvent: (ev) => {
      if (mode !== 'interactive') return;
      if (ev.type !== 'json') return;
      const j = ev.json || {};
      const t = String(j.type || j.event || '').toLowerCase();
      const msg = String(j.message || j.summary || '').trim();
      const milestone =
        msg ||
        (t.includes('analysis') ? 'Analyzing…' : t.includes('apply') ? 'Applying changes…' : t.includes('test') ? 'Running tests…' : '');
      if (milestone && milestone !== lastMilestone) {
        lastMilestone = milestone;
        void postMilestone(milestone);
      }
    }
  });
  await appendLog(stateDir, key, `codex.run exit ok=${codexResult.ok} code=${codexResult.exit?.code ?? 'null'}`);

  if (mode === 'interactive' && codexResult.sessionId) {
    await setSession(stateDir, { key, session: { sessionId: codexResult.sessionId, updatedAt: new Date().toISOString() } });
  }

  const tests = await runTestsMaybe({ workspaceDir, testCommand });
  const diffPacket = await buildReviewPacket({ workspaceDir, maxChars: 35_000 });

  const result = {
    agentify_result_for: args.id,
    ok: !!codexResult.ok,
    codex: { ok: codexResult.ok, sessionId: codexResult.sessionId || null, exit: codexResult.exit || null },
    workspace: { root: workspaceDir },
    tests: {
      command: tests.command,
      ok: tests.ok,
      tail: tests.output ? tests.output.slice(-3000) : ''
    },
    diff: {
      stat: diffPacket.stat || '',
      files: diffPacket.files || []
    }
  };

  // Post: review packet summary first, then selected patch if present.
  const reviewText =
    `Agentify result (no reply needed unless you want changes):\n\n` +
    formatResultBlock(result) +
    (diffPacket.patch ? `\nSelected patch (for review):\n\n\`\`\`diff\n${diffPacket.patch}\n\`\`\`\n` : '');

  const msgs = makeChunkedMessages({ header: 'Agentify Tool Result', body: reviewText, maxChars: Number(args.maxPostChars || 25_000) || 25_000 });
  for (const m of msgs) {
    await sendNoWait(conn, { key, text: m, stopAfterSend: true }).catch(() => {});
    await sleep(500);
  }
}

async function handleGitDiff({ stateDir, key, args, conn }) {
  let ws = await getWorkspace(stateDir, { key });
  if (!ws) {
    const root = await detectWorkspaceRoot(process.cwd());
    ws = await setWorkspace(stateDir, { key, workspace: { root } });
  }
  const workspaceDir = path.resolve(ws.root);
  assertWithin({ filePath: workspaceDir, allowedRoots: ws.allowRoots });
  await appendLog(stateDir, key, 'git.diff start');
  const diffPacket = await buildReviewPacket({ workspaceDir, maxChars: Number(args.maxChars || 35_000) || 35_000 });
  const result = {
    agentify_result_for: args.id,
    ok: true,
    diff: { stat: diffPacket.stat || '', files: diffPacket.files || [] }
  };
  const body =
    `Agentify diff:\n\n` +
    formatResultBlock(result) +
    (diffPacket.patch ? `\n\`\`\`diff\n${diffPacket.patch}\n\`\`\`\n` : '');
  for (const m of makeChunkedMessages({ header: 'Agentify Tool Result', body, maxChars: Number(args.maxPostChars || 25_000) || 25_000 })) {
    await sendNoWait(conn, { key, text: m, stopAfterSend: true }).catch(() => {});
    await sleep(400);
  }
  await appendLog(stateDir, key, 'git.diff done');
}

async function handleTestsRun({ stateDir, key, args, conn }) {
  let ws = await getWorkspace(stateDir, { key });
  if (!ws) {
    const root = await detectWorkspaceRoot(process.cwd());
    ws = await setWorkspace(stateDir, { key, workspace: { root } });
  }
  const workspaceDir = path.resolve(ws.root);
  assertWithin({ filePath: workspaceDir, allowedRoots: ws.allowRoots });
  const testCommand = (await detectTestCommand(workspaceDir)) || null;
  await appendLog(stateDir, key, `tests.run start cmd=${testCommand || 'none'}`);
  const tests = await runTestsMaybe({ workspaceDir, testCommand, timeoutMs: Number(args.timeoutMs || 0) || 20 * 60_000 });
  const result = {
    agentify_result_for: args.id,
    ok: tests.ok,
    tests: { command: tests.command, ok: tests.ok, tail: tests.output ? tests.output.slice(-8000) : '' }
  };
  const body = `Agentify tests:\n\n${formatResultBlock(result)}`;
  for (const m of makeChunkedMessages({ header: 'Agentify Tool Result', body, maxChars: Number(args.maxPostChars || 25_000) || 25_000 })) {
    await sendNoWait(conn, { key, text: m, stopAfterSend: true }).catch(() => {});
    await sleep(400);
  }
  await appendLog(stateDir, key, `tests.run done ok=${tests.ok}`);
}

async function handleFsRead({ stateDir, key, args, conn }) {
  const file = String(args.path || '').trim();
  if (!file) throw new Error('missing_path');
  const maxBytes = Math.max(1, Math.min(200_000, Number(args.maxBytes || 50_000) || 50_000));

  const ws = await getWorkspace(stateDir, { key });
  if (!ws?.root) throw new Error('missing_workspace');
  const allowRoots = ws.allowRoots || [ws.root];
  const abs = path.resolve(ws.root, file);
  assertWithin({ filePath: abs, allowedRoots: allowRoots });

  await appendLog(stateDir, key, `fs.read ${abs}`);
  const buf = await fs.readFile(abs);
  const sliced = buf.subarray(0, maxBytes);
  const text = sliced.toString('utf8');
  const truncated = buf.length > maxBytes;

  const result = {
    agentify_result_for: args.id,
    ok: true,
    file,
    bytes: buf.length,
    truncated
  };
  const body =
    `Agentify fs.read:\n\n` +
    formatResultBlock(result) +
    `\n\`\`\`\n${text}\n\`\`\`\n`;
  for (const m of makeChunkedMessages({ header: 'Agentify Tool Result', body, maxChars: Number(args.maxPostChars || 25_000) || 25_000 })) {
    await sendNoWait(conn, { key, text: m, stopAfterSend: true }).catch(() => {});
    await sleep(350);
  }
}

async function executeTool({ stateDir, req, conn }) {
  if (req.tool === 'codex.run') {
    await handleCodexRun({ stateDir, key: req.key, mode: req.mode, args: { ...req.args, id: req.id }, conn });
    return;
  }
  if (req.tool === 'git.diff') {
    await handleGitDiff({ stateDir, key: req.key, args: { ...req.args, id: req.id }, conn });
    return;
  }
  if (req.tool === 'tests.run') {
    await handleTestsRun({ stateDir, key: req.key, args: { ...req.args, id: req.id }, conn });
    return;
  }
  if (req.tool === 'fs.read') {
    await handleFsRead({ stateDir, key: req.key, args: { ...req.args, id: req.id }, conn });
    return;
  }
  const err = new Error('unknown_tool');
  err.data = { tool: req.tool };
  throw err;
}

async function main() {
  const stateDir = argValue('--state-dir') || defaultStateDir();
  const key = argValue('--key') || 'default';
  const pollMs = Number(argValue('--poll-ms') || 1500);
  const maxChars = Number(argValue('--max-chars') || 200_000);
  const once = argFlag('--once');

  const conn = await ensureDesktopRunning({ stateDir });
  await appendLog(stateDir, key, 'orchestrator started');
  await ensureReady(conn, { key }).catch(() => {});

  while (true) {
    const text = await readThread(conn, { key, maxChars }).catch(() => '');
    const blocks = parseAgentifyToolBlocks(text);
    const handled = await loadHandled(stateDir).catch(() => ({ keys: {} }));
    const last =
      findNextUnHandled(blocks, (k, id) => !!handled?.keys?.[String(k)]?.[String(id)]) || null;
    if (last) {
      try {
        const req = normalizeToolRequest(last, { defaultKey: key });
        if (!(await isHandled(stateDir, { key: req.key, id: req.id }))) {
          await markHandled(stateDir, { key: req.key, id: req.id, status: 'started' });
          await executeTool({ stateDir, req, conn });
          await markHandled(stateDir, { key: req.key, id: req.id, status: 'done' });
        }
      } catch (e) {
        // Post parse errors as a hint but don't loop endlessly.
        const msg = `Agentify orchestrator error: ${e?.message || String(e)}`;
        await sendNoWait(conn, { key, text: msg, stopAfterSend: true }).catch(() => {});
        await appendLog(stateDir, key, `error: ${e?.message || String(e)}`);
      }
    }

    if (once) break;
    await sleep(pollMs);
  }
}

main().catch((e) => {
  console.error('[agentify-orchestrator] fatal', e);
  process.exit(1);
});
