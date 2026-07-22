// Command-line client for Agentify Desktop — the same operations the MCP
// server exposes, driveable from a shell. Talks to the local desktop app's
// HTTP API (launching the app on demand, like the MCP server does), so agents
// and scripts can use ChatGPT-Pro-in-the-browser without any MCP wiring:
//
//   agentify-desktop cli query --prompt "Summarize this" --attach notes.md
//   agentify-desktop cli query --key myproject --prompt-file q.txt --out reply.md
//   agentify-desktop cli read --key myproject
//   agentify-desktop cli tabs | status | stop
//
// Reusing --key continues the SAME tab, i.e. the same conversation thread.

import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultStateDir } from './state.mjs';
import { ensureDesktopRunning, loadConnection, requestJson } from './mcp-lib.mjs';

const HELP = `Agentify Desktop CLI

Usage:
  agentify-desktop cli <command> [options]

Commands:
  query    Send a prompt (with optional attachments), wait for the full reply
  send     Fire-and-forget a message into the thread
  read     Read the current thread text
  tabs     List tabs
  status   Show desktop status
  stop     Break-glass stop for a running query

Common options:
  --model <vendor>     Vendor to use (default: chatgpt)
  --key <key>          Stable tab key; reusing a key continues the same conversation
  --tab <tabId>        Explicit tab id
  --state-dir <dir>    Override the state directory
  --no-launch          Fail instead of auto-launching the desktop app
  --show               Show the browser tab while working
  --json               Print the full JSON response

query options:
  --prompt <text>      Prompt text (or --prompt-file)
  --prompt-file <path> Read the prompt from a file
  --attach <path>      Attach a local file (repeatable)
  --timeout <ms>       How long to wait for the reply (default 600000)
  --out <path>         Write the reply text to this file

send options:
  --text <text> | --text-file <path>

read options:
  --max-chars <n>      Cap the returned text (default 200000)

Exit codes: 0 success · 1 command failed · 2 usage error
`;

function parseArgs(argv) {
  const opts = { attach: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--model': opts.model = take(); break;
      case '--key': opts.key = take(); break;
      case '--tab': opts.tab = take(); break;
      case '--state-dir': opts.stateDir = take(); break;
      case '--no-launch': opts.noLaunch = true; break;
      case '--show': opts.show = true; break;
      case '--json': opts.json = true; break;
      case '--prompt': opts.prompt = take(); break;
      case '--prompt-file': opts.promptFile = take(); break;
      case '--attach': opts.attach.push(take()); break;
      case '--timeout': opts.timeout = parseInt(take(), 10); break;
      case '--out': opts.out = take(); break;
      case '--text': opts.text = take(); break;
      case '--text-file': opts.textFile = take(); break;
      case '--max-chars': opts.maxChars = parseInt(take(), 10); break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option: ${a}`);
        opts._.push(a);
    }
  }
  return opts;
}

class UsageError extends Error {}

async function connect(opts) {
  const stateDir = opts.stateDir || process.env.AGENTIFY_DESKTOP_STATE_DIR || defaultStateDir();
  if (opts.noLaunch) {
    const conn = await loadConnection({ stateDir });
    if (!conn) throw new Error('desktop_not_running (remove --no-launch to auto-start it)');
    return conn;
  }
  return await ensureDesktopRunning({ stateDir, showTabs: !!opts.show });
}

function tabBody(opts) {
  const body = { source: 'cli' };
  if (opts.model) body.model = opts.model;
  else if (!opts.tab && !opts.key) body.model = 'chatgpt';
  if (opts.key) body.key = opts.key;
  if (opts.tab) body.tabId = opts.tab;
  if (opts.show) body.show = true;
  return body;
}

async function cmdQuery(conn, opts) {
  let prompt = opts.prompt;
  if (!prompt && opts.promptFile) prompt = await fs.readFile(path.resolve(opts.promptFile), 'utf8');
  if (!prompt?.trim()) throw new UsageError('query needs --prompt or --prompt-file');
  const attachments = [];
  for (const a of opts.attach) {
    const abs = path.resolve(a);
    await fs.access(abs);
    attachments.push(abs);
  }
  const data = await requestJson({
    ...conn,
    method: 'POST',
    path: '/query',
    body: {
      ...tabBody(opts),
      prompt,
      attachments,
      timeoutMs: Number.isFinite(opts.timeout) ? opts.timeout : 600_000
    }
  });
  const text = String(data?.result?.text ?? '');
  if (opts.out) await fs.writeFile(path.resolve(opts.out), text + (text.endsWith('\n') ? '' : '\n'));
  if (opts.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else if (!opts.out) process.stdout.write(text + '\n');
  else process.stderr.write(`reply written to ${opts.out} (${text.length} chars)\n`);
  return 0;
}

async function cmdSend(conn, opts) {
  let text = opts.text;
  if (!text && opts.textFile) text = await fs.readFile(path.resolve(opts.textFile), 'utf8');
  if (!text?.trim()) throw new UsageError('send needs --text or --text-file');
  const data = await requestJson({ ...conn, method: 'POST', path: '/send', body: { ...tabBody(opts), text } });
  process.stdout.write(opts.json ? JSON.stringify(data, null, 2) + '\n' : 'sent\n');
  return 0;
}

async function cmdRead(conn, opts) {
  const data = await requestJson({
    ...conn,
    method: 'POST',
    path: '/read-page',
    body: { ...tabBody(opts), maxChars: Number.isFinite(opts.maxChars) ? opts.maxChars : 200_000 }
  });
  process.stdout.write(opts.json ? JSON.stringify(data, null, 2) + '\n' : String(data?.text || '') + '\n');
  return 0;
}

async function cmdTabs(conn, opts) {
  const data = await requestJson({ ...conn, method: 'GET', path: '/tabs' });
  if (opts.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else for (const t of data?.tabs || []) process.stdout.write(`${t.id}  key=${t.key || '-'}  vendor=${t.vendorId || '-'}  ${t.url || ''}\n`);
  return 0;
}

async function cmdStatus(conn, opts) {
  const data = await requestJson({ ...conn, method: 'GET', path: '/status' });
  if (opts.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else {
    const q = data?.activeQuery;
    process.stdout.write(`ok=${data?.ok}  tabs=${(data?.tabs || []).length}  active=${q ? `${q.kind}:${q.phase}` : 'idle'}\n`);
  }
  return 0;
}

async function cmdStop(conn, opts) {
  const data = await requestJson({ ...conn, method: 'POST', path: '/query/stop', body: tabBody(opts) });
  process.stdout.write(opts.json ? JSON.stringify(data, null, 2) + '\n' : 'stop requested\n');
  return 0;
}

export async function runCli(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`agentify-desktop cli: ${error.message}\n\n${HELP}`);
      return 2;
    }
    throw error;
  }
  const cmd = opts._[0];
  if (opts.help || !cmd) {
    process.stdout.write(HELP);
    return opts.help ? 0 : 2;
  }
  const commands = { query: cmdQuery, send: cmdSend, read: cmdRead, tabs: cmdTabs, status: cmdStatus, stop: cmdStop };
  const fn = commands[cmd];
  if (!fn) {
    process.stderr.write(`agentify-desktop cli: unknown command '${cmd}'\n\n${HELP}`);
    return 2;
  }
  try {
    const conn = await connect(opts);
    return await fn(conn, opts);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`agentify-desktop cli: ${error.message}\n`);
      return 2;
    }
    const detail = error?.data ? ` ${JSON.stringify(error.data).slice(0, 300)}` : '';
    process.stderr.write(`agentify-desktop cli: ${error?.message || error}${detail}\n`);
    return 1;
  }
}
