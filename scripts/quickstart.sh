#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf "\n%s\n" "$*"; }
die() { printf "\nERROR: %s\n" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: ./scripts/quickstart.sh [--foreground] [--show-tabs] [--client <mode>]

--foreground  Run Agentify Desktop in the foreground (shows logs, Ctrl+C to stop).
--show-tabs   Make newly-created tab windows visible by default (debug-friendly).
--client      MCP registration mode:
              auto (default): register with installed clients found on PATH
              codex: register only Codex
              claude: register only Claude Code
              opencode: register only OpenCode
              all: register Codex + Claude Code + OpenCode
              none: skip MCP registration
EOF
}

FOREGROUND=0
SHOW_TABS=0
CLIENT_MODE="auto"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --foreground) FOREGROUND=1; shift ;;
    --show-tabs) SHOW_TABS=1; shift ;;
    --client)
      [[ $# -ge 2 ]] || die "--client requires a value"
      CLIENT_MODE="$2"
      shift 2
      ;;
    --client=*)
      CLIENT_MODE="${1#*=}"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown arg: $1" ;;
  esac
done
CLIENT_MODE="$(printf '%s' "${CLIENT_MODE}" | tr '[:upper:]' '[:lower:]')"
case "${CLIENT_MODE}" in
  auto|codex|claude|opencode|all|none) ;;
  *) die "Invalid --client value: ${CLIENT_MODE}" ;;
esac

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
if ! (cd "${REPO_ROOT}" && npm ci --no-fund --no-audit); then
  say "npm ci failed (likely package-lock drift). Falling back to npm install..."
  (cd "${REPO_ROOT}" && npm install --no-fund --no-audit)
fi

MCP_CMD=(node "${REPO_ROOT}/mcp-server.mjs")
SHOW_SUFFIX=""
if [[ "${SHOW_TABS}" -eq 1 ]]; then
  MCP_CMD+=(--show-tabs)
  SHOW_SUFFIX=" --show-tabs"
fi
MCP_CMD_DISPLAY="node \"${REPO_ROOT}/mcp-server.mjs\"${SHOW_SUFFIX}"
REGISTERED_CLIENTS=()

print_codex_manual() {
  say "When Codex is installed, run:"
  say "  codex mcp add agentify-desktop -- ${MCP_CMD_DISPLAY}"
}

print_claude_manual() {
  say "When Claude Code is installed, run:"
  say "  claude mcp add --transport stdio agentify-desktop -- ${MCP_CMD_DISPLAY}"
}

print_opencode_manual() {
  local config_path="$1"
  say "Manual OpenCode config (${config_path}):"
  say '{'
  say '  "mcp": {'
  if [[ "${SHOW_TABS}" -eq 1 ]]; then
    say "    \"agentify-desktop\": { \"type\": \"local\", \"command\": [\"node\", \"${REPO_ROOT}/mcp-server.mjs\", \"--show-tabs\"], \"enabled\": true }"
  else
    say "    \"agentify-desktop\": { \"type\": \"local\", \"command\": [\"node\", \"${REPO_ROOT}/mcp-server.mjs\"], \"enabled\": true }"
  fi
  say '  }'
  say '}'
}

register_codex() {
  local required="${1:-0}"
  if ! command -v codex >/dev/null 2>&1; then
    if [[ "${required}" -eq 1 ]]; then
      say "Codex CLI not found on PATH; skipping Codex registration."
      print_codex_manual
    fi
    return 0
  fi

  say "Registering MCP server with Codex..."
  set +e
  codex mcp remove agentify-desktop >/dev/null 2>&1
  codex mcp add agentify-desktop -- "${MCP_CMD[@]}"
  local rc=$?
  set -e
  if [[ "${rc}" -ne 0 ]]; then
    say "Note: 'codex mcp add' returned a non-zero exit code."
    say "If it says the server already exists, run: codex mcp list"
  else
    REGISTERED_CLIENTS+=("codex")
  fi
  say "Codex MCP servers:"
  codex mcp list || true
}

register_claude() {
  local required="${1:-0}"
  if ! command -v claude >/dev/null 2>&1; then
    if [[ "${required}" -eq 1 ]]; then
      say "Claude Code CLI not found on PATH; skipping Claude registration."
      print_claude_manual
    fi
    return 0
  fi

  say "Registering MCP server with Claude Code..."
  set +e
  claude mcp remove agentify-desktop >/dev/null 2>&1
  claude mcp add --transport stdio agentify-desktop -- "${MCP_CMD[@]}"
  local rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    claude mcp add agentify-desktop -- "${MCP_CMD[@]}"
    rc=$?
  fi
  set -e
  if [[ "${rc}" -ne 0 ]]; then
    say "Note: 'claude mcp add' returned a non-zero exit code."
  else
    REGISTERED_CLIENTS+=("claude")
  fi
  say "Claude MCP servers:"
  claude mcp list || true
}

register_opencode() {
  local required="${1:-0}"
  if [[ "${required}" -eq 0 ]] && ! command -v opencode >/dev/null 2>&1; then
    return 0
  fi

  local config_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/opencode"
  local config_path="${config_dir}/opencode.json"

  say "Registering MCP server with OpenCode config..."
  set +e
  local out
  out="$(
    REPO_ROOT="${REPO_ROOT}" SHOW_TABS="${SHOW_TABS}" CONFIG_PATH="${config_path}" node 2>&1 <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.env.REPO_ROOT;
const showTabs = process.env.SHOW_TABS === '1';
const configPath = process.env.CONFIG_PATH;

const existed = fs.existsSync(configPath);
let doc = {};

if (existed) {
  const raw = fs.readFileSync(configPath, 'utf8');
  if (raw.trim()) {
    try {
      doc = JSON.parse(raw);
    } catch {
      console.error(`invalid_json:${configPath}`);
      process.exit(2);
    }
  }
}

if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
  console.error(`invalid_root_object:${configPath}`);
  process.exit(3);
}

if (doc.mcp == null) doc.mcp = {};
if (!doc.mcp || typeof doc.mcp !== 'object' || Array.isArray(doc.mcp)) {
  console.error(`invalid_mcp_object:${configPath}`);
  process.exit(4);
}

const command = ['node', path.join(repoRoot, 'mcp-server.mjs')];
if (showTabs) command.push('--show-tabs');
doc.mcp['agentify-desktop'] = { type: 'local', command, enabled: true };

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
console.log(`${existed ? 'Updated' : 'Created'} ${configPath}`);
NODE
  )"
  local rc=$?
  set -e

  if [[ "${rc}" -ne 0 ]]; then
    say "OpenCode MCP config update failed."
    if [[ -n "${out}" ]]; then
      say "Reason: ${out}"
    fi
    print_opencode_manual "${config_path}"
    return 0
  fi

  say "${out}"
  REGISTERED_CLIENTS+=("opencode")
  if command -v opencode >/dev/null 2>&1; then
    say "OpenCode MCP servers:"
    opencode mcp list || true
  fi
}

say "2) Registering MCP server (client mode: ${CLIENT_MODE})..."
case "${CLIENT_MODE}" in
  auto)
    register_codex 0
    register_claude 0
    register_opencode 0
    ;;
  codex) register_codex 1 ;;
  claude) register_claude 1 ;;
  opencode) register_opencode 1 ;;
  all)
    register_codex 1
    register_claude 1
    register_opencode 1
    ;;
  none)
    say "Skipping MCP registration (--client none)."
    ;;
esac

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
  cd "${REPO_ROOT}" || exit 1
  nohup npm run start >"${DESKTOP_LOG}" 2>&1 &
  echo $! > "${STATE_DIR}/desktop.pid"
)

PID="$(cat "${STATE_DIR}/desktop.pid" 2>/dev/null || true)"
if [[ -z "${PID}" ]]; then
  die "Desktop failed to start (missing PID file). Check permissions for ${STATE_DIR} and ${LOG_DIR}."
fi
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
say "- The Agentify Control Center will open. Click 'Show default' or create a vendor tab and sign in."
say "- MCP server entrypoint: ${MCP_CMD_DISPLAY}"
if [[ "${#REGISTERED_CLIENTS[@]}" -gt 0 ]]; then
  REGISTERED_TEXT="$(IFS=', '; echo "${REGISTERED_CLIENTS[*]}")"
  say "- Registered MCP clients: ${REGISTERED_TEXT}"
  say "- Restart those clients (or open a new session) so they reload MCP config."
else
  say "- No MCP client was auto-registered. Use --client <name> or add it manually from README."
fi
if [[ "${SHOW_TABS}" -eq 1 ]]; then
  say "- Tabs visibility: --show-tabs is enabled, so new tabs will be shown by default."
else
  say "- Tabs visibility: default is hidden tabs; use the Control Center or agentify_show to bring a tab forward."
fi
say "- In your MCP client, use the tools:"
say "  - agentify_ensure_ready  (waits until the prompt box is ready)"
say "  - agentify_query         (send a prompt; use 'key' for parallel jobs)"
say "  - agentify_read_page     (read the current page/chat transcript text)"
say ""
say "Troubleshooting:"
say "- If you don't see the Control Center, click the app in the dock (macOS) or re-run this script."
say "- To stop the app later, use the MCP tool: agentify_shutdown"
say "- If selectors break due to UI changes, override them in:"
say "  ${STATE_DIR}/selectors.override.json"
