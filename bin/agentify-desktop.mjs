#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

function printHelp() {
  console.log(`Agentify Desktop

Usage:
  agentify-desktop [gui] [options]
  agentify-desktop mcp [options]

Commands:
  gui    Start the Agentify Desktop control center. This is the default.
  mcp    Run the Agentify Desktop MCP server over stdio.

Examples:
  npx @agentify/desktop
  npx @agentify/desktop mcp
  npx @agentify/desktop mcp --show-tabs

GUI options are passed to the Electron app.
MCP options are passed to mcp-server.mjs.`);
}

function resolveMode(invokedName, argv) {
  if (invokedName.endsWith('-mcp')) return { mode: 'mcp', args: argv };
  if (invokedName.endsWith('-gui')) return { mode: 'gui', args: argv };

  const [first, ...rest] = argv;
  if (!first || first.startsWith('-')) return { mode: 'gui', args: argv };
  if (first === 'gui' || first === 'start') return { mode: 'gui', args: rest };
  if (first === 'mcp') return { mode: 'mcp', args: rest };
  if (first === 'help') return { mode: 'help', args: rest };
  return { mode: 'unknown', args: argv };
}

function electronBin() {
  const local = path.join(
    packageRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron'
  );
  if (fs.existsSync(local)) return local;
  return process.env.AGENTIFY_DESKTOP_ELECTRON_BIN || 'electron';
}

async function runMcp(args) {
  const serverPath = path.join(packageRoot, 'mcp-server.mjs');
  process.argv = [process.argv[0], serverPath, ...args];
  await import(pathToFileURL(serverPath).href);
}

function runGui(args) {
  const child = spawn(electronBin(), [packageRoot, ...args], {
    stdio: 'inherit',
    env: process.env
  });
  child.on('error', (err) => {
    console.error(`agentify-desktop failed to start: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`agentify-desktop exited from signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

const invokedName = path.basename(process.argv[1] || 'agentify-desktop');
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

const { mode, args } = resolveMode(invokedName, argv);
if (mode === 'help') {
  printHelp();
} else if (mode === 'mcp') {
  await runMcp(args);
} else if (mode === 'gui') {
  runGui(args);
} else {
  console.error(`Unknown Agentify Desktop command: ${args[0] || argv[0]}`);
  console.error('Run `agentify-desktop --help` for usage.');
  process.exit(2);
}
