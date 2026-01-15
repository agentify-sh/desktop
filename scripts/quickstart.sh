#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf "\n%s\n" "$*"; }
die() { printf "\nERROR: %s\n" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: ./scripts/quickstart.sh [--foreground] [--show-tabs]

--foreground  Run Agentify Desktop in the foreground (shows logs, Ctrl+C to stop).
--show-tabs   Make newly-created tab windows visible by default (debug-friendly).
EOF
}

FOREGROUND=0
SHOW_TABS=0
for arg in "$@"; do
  case "$arg" in
    --foreground) FOREGROUND=1 ;;
    --show-tabs) SHOW_TABS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown arg: ${arg}" ;;
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

say "1) Installing dependencies (npm ci)..."
(cd "${REPO_ROOT}" && npm ci --no-fund --no-audit)

say "2) Registering MCP server with Codex (absolute path)..."
if command -v codex >/dev/null 2>&1; then
  MCP_CMD=(node "${REPO_ROOT}/mcp-server.mjs")
  if [[ "${SHOW_TABS}" -eq 1 ]]; then
    MCP_CMD+=(--show-tabs)
  fi

  # Ensure the server config matches the requested flags.
  set +e
  codex mcp remove agentify-desktop >/dev/null 2>&1
  set -e

  set +e
  codex mcp add agentify-desktop -- "${MCP_CMD[@]}"
  CODEX_ADD_RC=$?
  set -e
  if [[ "${CODEX_ADD_RC}" -ne 0 ]]; then
    say "Note: 'codex mcp add' returned a non-zero exit code."
    say "If it says the server already exists, you can run: codex mcp list"
  fi
  say "Codex MCP servers:"
  codex mcp list || true
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

DESKTOP_LOG="${LOG_DIR}/desktop.$(date +%Y%m%d-%H%M%S).log"

if [[ "${FOREGROUND}" -eq 1 ]]; then
  say "Running in foreground. Logs will print here."
  say "Tip: if you don't see the Control Center, click the app in the Dock (macOS)."
  (cd "${REPO_ROOT}" && npm run start)
  exit 0
fi

(
  cd "${REPO_ROOT}"
  nohup npm run start >"${DESKTOP_LOG}" 2>&1 &
  echo $! > "${STATE_DIR}/desktop.pid"
) || true

PID="$(cat "${STATE_DIR}/desktop.pid" 2>/dev/null || true)"
say "Started desktop (pid ${PID:-unknown})"
say "Desktop log: ${DESKTOP_LOG}"

# Best-effort: confirm the local API is up (reads ~/.agentify-desktop/state.json and calls /health).
STATE_JSON="${STATE_DIR}/state.json"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f "${STATE_JSON}" ]] && break
  sleep 0.3
done
if [[ -f "${STATE_JSON}" ]]; then
  PORT="$(STATE_JSON="${STATE_JSON}" node -p "try{JSON.parse(require('fs').readFileSync(process.env.STATE_JSON,'utf8')).port||0}catch(e){0}" 2>/dev/null || echo 0)"
  if [[ "${PORT}" != "0" ]]; then
    if command -v curl >/dev/null 2>&1; then
      curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && say "Local API is up (http://127.0.0.1:${PORT})." || true
    fi
  fi
fi

say ""
say "Next:"
say "- The Agentify Control Center will open. Click 'Show default' to open the ChatGPT tab and sign in."
say "- MCP note: Codex starts the MCP server automatically on first tool call (you do NOT need to run a separate 'npm run mcp')."
say "- If you already have Codex open, restart it (or start a new session) to pick up the new MCP server."
if [[ "${SHOW_TABS}" -eq 1 ]]; then
  say "- Tabs visibility: --show-tabs is enabled, so new tabs will be shown by default."
else
  say "- Tabs visibility: default is hidden tabs; use the Control Center or agentify_show to bring a tab forward."
fi
say "- In Codex, use the tools:"
say "  - agentify_ensure_ready  (waits for #prompt-textarea / prompt box)"
say "  - agentify_query         (send a prompt; use 'key' for parallel jobs)"
say "  - agentify_read_page     (read the current page/chat transcript text)"
say ""
say "Troubleshooting:"
say "- If you don't see the Control Center, click the app in the dock (macOS) or re-run this script."
say "- To stop the app later, use the MCP tool: agentify_shutdown"
say "- If selectors break due to UI changes, override them in:"
say "  ${STATE_DIR}/selectors.override.json"
