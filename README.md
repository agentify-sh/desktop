# Agentify Desktop

Agentify Desktop is a local-first desktop app that lets AI coding tools drive your existing web subscriptions (starting with ChatGPT) through a real, logged-in browser session on your machine.

It exposes an MCP server so tools like Codex can:
- Send prompts to the web UI and read back the response
- Run multiple parallel jobs via separate “tabs” (separate windows; shared login session by default)
- Upload local files (best-effort; depends on the target site UI)
- Download generated images (best-effort; supports `<img>` and `canvas` render paths)

## Supported sites
**Supported**
- `chatgpt.com`
- `perplexity.ai`
- `claude.ai`
- `aistudio.google.com`
- `gemini.google.com`
- `grok.com`

**Planned**
- Additional vendor profiles via `vendors.json` + selector overrides.

## CAPTCHA policy (human-in-the-loop)
Agentify Desktop does **not** attempt to bypass CAPTCHAs or use third-party solvers. If a human verification appears, the app pauses automation, brings the relevant window to the front, and waits for you to complete the check manually.

## Requirements
- Node.js 20+ (22 recommended)
- MCP-capable CLI (optional, for MCP): Codex, Claude Code, or OpenCode

## Quickstart (macOS/Linux)
Quickstart installs dependencies, auto-registers the MCP server for installed clients (Codex/Claude Code/OpenCode), and starts Agentify Desktop:

```bash
git clone git@github.com:agentify-sh/desktop.git
cd desktop
./scripts/quickstart.sh
```

Debug-friendly: show newly-created tab windows by default:
```bash
./scripts/quickstart.sh --show-tabs
```

Foreground mode (logs to your terminal, Ctrl+C to stop):
```bash
./scripts/quickstart.sh --foreground
```

Choose MCP registration target explicitly:
```bash
./scripts/quickstart.sh --client auto     # default
./scripts/quickstart.sh --client codex
./scripts/quickstart.sh --client claude
./scripts/quickstart.sh --client opencode
./scripts/quickstart.sh --client all
./scripts/quickstart.sh --client none
```

## Manual install & run
```bash
npm i
npm run start
```

The Agentify Control Center opens. Use it to:
- Show/hide tabs (each tab is a separate window)
- Create tabs for ChatGPT, Perplexity, Claude, Google AI Studio, Gemini, and Grok
- Tune automation safety limits (governor)
- Manage the optional “single-chat emulator” orchestrator

Sign in to your target vendor in the tab window.

If your account uses SSO (Google/Microsoft/Apple), keep **Settings → Allow auth popups** enabled in the Control Center. ChatGPT login often opens provider auth in a popup, and blocking popups can prevent login from completing.

## Connect from MCP clients
Quickstart can register MCP automatically, but manual commands are below if you prefer explicit setup.

### Codex
From the repo root:
```bash
codex mcp add agentify-desktop -- node mcp-server.mjs [--show-tabs]
```

From anywhere (absolute path):
```bash
codex mcp add agentify-desktop -- node /ABS/PATH/TO/desktop/mcp-server.mjs [--show-tabs]
```

Confirm registration:
```bash
codex mcp list
```

### Claude Code
From the repo root:
```bash
claude mcp add --transport stdio agentify-desktop -- node mcp-server.mjs [--show-tabs]
```

From anywhere (absolute path):
```bash
claude mcp add --transport stdio agentify-desktop -- node /ABS/PATH/TO/desktop/mcp-server.mjs [--show-tabs]
```

Confirm registration:
```bash
claude mcp list
```

### OpenCode
OpenCode can be configured in `~/.config/opencode/opencode.json`:
```json
{
  "mcp": {
    "agentify-desktop": {
      "type": "local",
      "command": ["node", "/ABS/PATH/TO/desktop/mcp-server.mjs"],
      "enabled": true
    }
  }
}
```

`./scripts/quickstart.sh --client opencode` (or `--client all`) writes/updates this entry automatically.

Confirm registration:
```bash
opencode mcp list
```

If you already had your client open, restart it (or start a new session) so it reloads MCP server config.

## How to use (practical)
- **Use ChatGPT/Perplexity/Claude/AI Studio/Gemini/Grok normally (manual):** write a plan/spec in the UI, then in your MCP client call `agentify_read_page` to pull the transcript into your workflow.
- **Drive ChatGPT/Perplexity/Claude/AI Studio/Gemini/Grok from your MCP client:** call `agentify_ensure_ready`, then `agentify_query` with a `prompt`. Use a stable `key` per project to keep parallel jobs isolated.
- **Parallel jobs:** create/ensure a tab per project with `agentify_tab_create(key: ...)`, then use that `key` for `agentify_query`, `agentify_read_page`, and `agentify_download_images`.
- **Upload files:** pass local paths via `attachments` to `agentify_query` (best-effort; depends on the site UI).
- **Generate/download images:** ask for images via `agentify_query` (then call `agentify_download_images`), or use `agentify_image_gen` (prompt + download).

## What's new
- First-class multi-vendor tab support now includes Perplexity, Claude, Google AI Studio, Gemini, and Grok.
- Control Center reliability and UX were hardened (state/refresh wiring, tab actions, compact controls, clearer field guidance).
- Local API hardening includes strict invalid JSON handling, key/vendor mismatch protection, and safer tab-key recovery.
- Desktop runtime hardening includes Control Center sandboxing plus dependency security updates.

## Governor (anti-spam)
Agentify Desktop includes a built-in governor to reduce accidental high-rate automation:
- Limits concurrent in-flight queries
- Limits queries per minute (token bucket)
- Enforces minimum gaps between queries (per tab + globally)

You can adjust these limits in the Control Center after acknowledging the disclaimer.

## Single-chat emulator (experimental)
Agentify Desktop can optionally run a local “orchestrator” that watches a ChatGPT thread for fenced JSON tool requests, runs Codex locally, and posts results back into the *same* ChatGPT thread. This gives you a “single-chat” orchestration feel without relying on ChatGPT’s built-in tools/MCP mode.

The orchestrator currently invokes Codex CLI directly. Core `agentify_*` MCP tools remain client-agnostic.

### What it does
- Treats your ChatGPT Web thread as the “mothership” (planning + context).
- Watches for tool requests you paste as fenced JSON blocks.
- Runs Codex CLI locally in your workspace (interactive or non-interactive).
- Posts back: a short outcome + a bounded diff/review packet (so you’re not pasting 200k+ chars every time).

### Quick test (recommended)
1) Start the app and sign in:
- Run `./scripts/quickstart.sh --show-tabs`
- In the Control Center, click **Show default** and sign in to `https://chatgpt.com`

2) Start an orchestrator session:
- In the Control Center → **Orchestrator**, start an orchestrator for a project `key` (one key per project/workstream).

3) In the ChatGPT thread (same tab/key), paste a fenced JSON request like:
```json
{
  "tool": "codex.run",
  "mode": "interactive",
  "args": {
    "prompt": "Find the README file and add a short troubleshooting section. Then run tests."
  }
}
```

4) Wait for the orchestrator to post results back into the thread.

### Tips
- Use one stable `key` per project so parallel jobs don’t mix.
- If the orchestrator can’t find the right workspace root, set it in the Control Center (Workspace/Allowlist), then retry.
- If you want the orchestrator to post less frequently, keep prompts focused (it posts progress updates on a timer).

## Limitations / robustness notes
- **File upload selectors:** `input[type=file]` selection is best-effort; if ChatGPT changes the upload flow, update `selectors.json` or `~/.agentify-desktop/selectors.override.json`.
- **Perplexity selectors:** Perplexity support is best-effort and may require selector overrides in `~/.agentify-desktop/selectors.override.json` if UI changes.
- **Gemini selectors:** Gemini support is best-effort and may require selector overrides in `~/.agentify-desktop/selectors.override.json` if UI changes.
- **Completion detection:** waiting for “stop generating” to disappear + text stability works well, but can mis-detect on very long outputs or intermittent streaming pauses.
- **Image downloads:** prefers `<img>` elements in the latest assistant message; some UI modes may render images via nonstandard elements.
- **Parallelism model:** “tabs” are separate windows; they can run in parallel without stealing focus unless a human check is required.
- **Security knobs:** default is loopback-only + bearer token; token rotation and shutdown are supported via MCP tools.

## Login troubleshooting (Google SSO)
- Symptom: login shows “This browser or app may not be secure” or the flow never completes.
- Check 1: In Control Center, enable `Allow auth popups (needed for Google/Microsoft/Apple SSO)`.
- Check 2: Retry login from a fresh ChatGPT tab (`Create tab` → `ChatGPT` → `Show`).
- Check 3: If your provider asks for WebAuthn/security key prompts, complete/cancel once and continue; some providers require that step before password/passkey fallback.

## Build installers (unsigned)
```bash
npm run dist
```
Artifacts land in `dist/`.

## Security and data
- Control API binds to `127.0.0.1` on an ephemeral port by default.
- Auth uses a local bearer token stored under `~/.agentify-desktop/`.
- Electron session data (cookies/local storage) is stored under `~/.agentify-desktop/electron-user-data/`.

See `SECURITY.md`.

## Trademarks
Forks/derivatives may not use Agentify branding. See `TRADEMARKS.md`.
