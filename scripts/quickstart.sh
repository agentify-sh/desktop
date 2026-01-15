#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf "\n%s\n" "$*"; }
die() { printf "\nERROR: %s\n" "$*" >&2; exit 1; }

SHOW_TABS=0
for arg in "$@"; do
  case "${arg}" in
    --show-tabs) SHOW_TABS=1 ;;
    --help|-h)
      cat <<'EOF'
Usage: ./scripts/quickstart.sh [--show-tabs]

Options:
  --show-tabs   Show newly-created tab windows by default (for parallel jobs).
EOF
      exit 0
      ;;
  esac
done

command -v node >/dev/null 2>&1 || die "Node.js is required (install Node 20+)."

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  die "Node.js 20+ is required (found $(node -v))."
fi

if ! command -v npm >/dev/null 2>&1; then
  die "npm is required (it should come with Node)."
fi

say "Agentify Desktop quickstart"
say "Repo: ${REPO_ROOT}"
if [[ "${SHOW_TABS}" -eq 1 ]]; then
  say "Mode: --show-tabs enabled"
fi

say "1) Installing dependencies (npm ci)..."
(cd "${REPO_ROOT}" && npm ci)

say "2) Registering MCP server with Codex (absolute path)..."
if command -v codex >/dev/null 2>&1; then
  set +e
  if [[ "${SHOW_TABS}" -eq 1 ]]; then
    codex mcp add agentify-desktop -- node "${REPO_ROOT}/mcp-server.mjs" --show-tabs
  else
    codex mcp add agentify-desktop -- node "${REPO_ROOT}/mcp-server.mjs"
  fi
  CODEX_ADD_RC=$?
  set -e
  if [[ "${CODEX_ADD_RC}" -ne 0 ]]; then
    say "Note: 'codex mcp add' returned a non-zero exit code."
    say "If it says the server already exists, you can run: codex mcp list"
  fi
else
  say "Codex CLI not found on PATH; skipping MCP registration."
  say "When Codex is installed, run:"
  if [[ "${SHOW_TABS}" -eq 1 ]]; then
    say "  codex mcp add agentify-desktop -- node \"${REPO_ROOT}/mcp-server.mjs\" --show-tabs"
  else
    say "  codex mcp add agentify-desktop -- node \"${REPO_ROOT}/mcp-server.mjs\""
  fi
fi

say "3) Starting Agentify Desktop (Electron)..."
STATE_DIR="${HOME}/.agentify-desktop"
LOG_DIR="${STATE_DIR}/logs"
mkdir -p "${LOG_DIR}"

health_ok() {
  node <<'NODE'
import fs from 'node:fs/promises';
import path from 'node:path';

const stateDir = process.env.HOME ? path.join(process.env.HOME, '.agentify-desktop') : null;
if (!stateDir) process.exit(2);

let port = null;
try {
  const state = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8'));
  port = Number(state?.port || 0) || null;
} catch {
  process.exit(2);
}

try {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  if (!res.ok) process.exit(3);
  const data = await res.json().catch(() => ({}));
  if (data?.ok !== true) process.exit(4);
  process.exit(0);
} catch {
  process.exit(5);
}
NODE
}

if health_ok >/dev/null 2>&1; then
  say "Desktop already running (health check OK)."
  if [[ "${SHOW_TABS}" -eq 1 ]]; then
    say "Note: --show-tabs affects the running desktop instance; to apply it, restart via the MCP tool: agentify_shutdown"
  fi
else
  DESKTOP_LOG="${LOG_DIR}/desktop.$(date +%Y%m%d-%H%M%S).log"
  (
    cd "${REPO_ROOT}"
    if [[ "${SHOW_TABS}" -eq 1 ]]; then
      AGENTIFY_DESKTOP_SHOW_TABS_BY_DEFAULT=1 nohup npm run start >"${DESKTOP_LOG}" 2>&1 &
    else
      nohup npm run start >"${DESKTOP_LOG}" 2>&1 &
    fi
    echo $! > "${STATE_DIR}/desktop.pid"
  )
  say "Started desktop (pid $(cat "${STATE_DIR}/desktop.pid"))"
  say "Desktop log: ${DESKTOP_LOG}"

  say "Waiting for desktop health check..."
  started=0
  for _ in {1..120}; do
    if health_ok >/dev/null 2>&1; then
      started=1
      break
    fi
    sleep 0.25
  done
  if [[ "${started}" -ne 1 ]]; then
    say "ERROR: desktop did not become healthy within 30s."
    say "Check log: ${DESKTOP_LOG}"
    exit 1
  fi
fi

say ""
say "Next:"
say "- Bring the Agentify Desktop window to the front and sign in to https://chatgpt.com/."
say "- (Optional) Open Agentify Desktop → Control Center… to manage tabs and safety settings."
say "- In Codex, use the tools:"
say "  - agentify_ensure_ready   (waits for #prompt-textarea / prompt box)"
say "  - agentify_query          (send a prompt; use 'key' for parallel jobs)"
say ""
say "Troubleshooting:"
say "- If you don't see the window, use the MCP tool: agentify_show"
say "- To stop the app later, use the MCP tool: agentify_shutdown"
say "- If selectors break due to UI changes, override them in:"
say "  ${STATE_DIR}/selectors.override.json"

say ""
say "If you just registered the MCP server, restart Codex so it picks up the new tool list."
