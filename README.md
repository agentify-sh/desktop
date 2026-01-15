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

**Planned**
- `claude.ai`
- `grok.com`
- `aistudio.google.com`

## CAPTCHA policy (human-in-the-loop)
Agentify Desktop does **not** attempt to bypass CAPTCHAs or use third-party solvers. If a human verification appears, the app pauses automation, brings the relevant window to the front, and waits for you to complete the check manually.

## Requirements
- Node.js 20+ (22 recommended)
- Codex CLI (optional, for MCP)

## Quickstart (macOS/Linux)
Quickstart installs dependencies, registers the MCP server with Codex (if installed), and starts Agentify Desktop:

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

## Manual install & run
```bash
npm i
npm run start
```

The Agentify Control Center opens. Use it to:
- Show/hide tabs (each tab is a separate window)
- Create tabs for different vendors (ChatGPT supported; others planned)
- Tune automation safety limits (governor)
- Manage the optional “single-chat emulator” orchestrator

Sign in to ChatGPT in the tab window.

## Connect from Codex (MCP)
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

If you already had Codex open, restart it (or start a new session) so it reloads MCP server config.

## How to use (practical)
- **Use ChatGPT normally (manual):** write a plan/spec in the UI, then in Codex call `agentify_read_page` to pull the transcript into your workflow.
- **Drive ChatGPT from Codex:** call `agentify_ensure_ready`, then `agentify_query` with a `prompt`. Use a stable `key` per project to keep parallel jobs isolated.
- **Parallel jobs:** create/ensure a tab per project with `agentify_tab_create(key: ...)`, then use that `key` for `agentify_query`, `agentify_read_page`, and `agentify_download_images`.
- **Upload files:** pass local paths via `attachments` to `agentify_query` (best-effort; depends on the site UI).
- **Generate/download images:** ask for images via `agentify_query` (then call `agentify_download_images`), or use `agentify_image_gen` (prompt + download).

## Governor (anti-spam)
Agentify Desktop includes a built-in governor to reduce accidental high-rate automation:
- Limits concurrent in-flight queries
- Limits queries per minute (token bucket)
- Enforces minimum gaps between queries (per tab + globally)

You can adjust these limits in the Control Center after acknowledging the disclaimer.

## Single-chat emulator (experimental)
Agentify Desktop can optionally run a local “orchestrator” that watches a ChatGPT thread for fenced JSON tool requests.

It can run Codex CLI locally and post back results (including a bounded diff “review packet”). Manage it from the Control Center under **Orchestrator**.

## Limitations / robustness notes
- **File upload selectors:** `input[type=file]` selection is best-effort; if ChatGPT changes the upload flow, update `selectors.json` or `~/.agentify-desktop/selectors.override.json`.
- **Completion detection:** waiting for “stop generating” to disappear + text stability works well, but can mis-detect on very long outputs or intermittent streaming pauses.
- **Image downloads:** prefers `<img>` elements in the latest assistant message; some UI modes may render images via nonstandard elements.
- **Parallelism model:** “tabs” are separate windows; they can run in parallel without stealing focus unless a human check is required.
- **Security knobs:** default is loopback-only + bearer token; token rotation and shutdown are supported via MCP tools.

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
