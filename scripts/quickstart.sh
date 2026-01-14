#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf "\n%s\n" "$*"; }
die() { printf "\nERROR: %s\n" "$*" >&2; exit 1; }

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
(cd "${REPO_ROOT}" && npm ci)

say "2) Registering MCP server with Codex (absolute path)..."
if command -v codex >/dev/null 2>&1; then
  set +e
  codex mcp add agentify-desktop -- node "${REPO_ROOT}/mcp-server.mjs"
  CODEX_ADD_RC=$?
  set -e
  if [[ "${CODEX_ADD_RC}" -ne 0 ]]; then
    say "Note: 'codex mcp add' returned a non-zero exit code."
    say "If it says the server already exists, you can run: codex mcp list"
  fi
else
  say "Codex CLI not found on PATH; skipping MCP registration."
  say "When Codex is installed, run:"
  say "  codex mcp add agentify-desktop -- node \"${REPO_ROOT}/mcp-server.mjs\""
fi

say "3) Starting Agentify Desktop (Electron)..."
STATE_DIR="${HOME}/.agentify-desktop"
LOG_DIR="${STATE_DIR}/logs"
mkdir -p "${LOG_DIR}"

DESKTOP_LOG="${LOG_DIR}/desktop.$(date +%Y%m%d-%H%M%S).log"
(
  cd "${REPO_ROOT}"
  nohup npm run start >"${DESKTOP_LOG}" 2>&1 &
  echo $! > "${STATE_DIR}/desktop.pid"
)
say "Started desktop (pid $(cat "${STATE_DIR}/desktop.pid"))"
say "Desktop log: ${DESKTOP_LOG}"

say ""
say "Next:"
say "- Bring the Agentify Desktop window to the front and sign in to https://chatgpt.com/."
say "- In Codex, use the tools:"
say "  - browser_ensure_ready   (waits for #prompt-textarea / prompt box)"
say "  - browser_query          (send a prompt; use 'key' for parallel jobs)"
say ""
say "Troubleshooting:"
say "- If you don't see the window, run: open -a \"Electron\"  (or use browser_show from Codex)"
say "- To stop the app later, use the MCP tool: browser_shutdown"
say "- If selectors break due to UI changes, override them in:"
say "  ${STATE_DIR}/selectors.override.json"

