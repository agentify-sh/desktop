# Agentify Desktop

Agentify Desktop is a local-first desktop app that lets AI coding tools drive your **existing web subscriptions** (starting with ChatGPT) through a real, logged-in browser session on your machine.

It exposes an **MCP server** so tools like Codex can:
- Send prompts to the web UI and read back the response
- Run multiple parallel jobs via separate “tabs” (separate windows; shared login session by default)
- Upload local files (best-effort; depends on the target site UI)
- Download generated images (best-effort; supports `<img>` and `canvas` render paths)

## Supported sites
**Supported**
- `chatgpt.com`

**Planned**
- `claude.ai`
- `gemini.google.com`

## CAPTCHA policy (human-in-the-loop)
Agentify Desktop does **not** attempt to bypass CAPTCHAs or use third-party solvers. If a human verification appears, the app pauses automation, brings the relevant window to the front, and waits for you to complete the check manually.

## Install
Requirements:
- Node.js 20+ (22 recommended)

## Quickstart (macOS/Linux)
From anywhere:
```bash
git clone git@github.com:agentify-sh/desktop.git
cd desktop
./scripts/quickstart.sh
```

To make newly-created tab windows visible by default (debug-friendly):
```bash
./scripts/quickstart.sh --show-tabs
```

Install dependencies:
```bash
npm i
```

## Run
Start the desktop app:
```bash
npm run start
```

The **Agentify Control Center** opens. Use it to:
- Show/hide tabs (each tab is a separate window)
- Create tabs for different vendors (ChatGPT supported; others planned)
- Tune automation safety limits (governor)

Sign in to ChatGPT in the tab window.

## Connect from Codex (MCP)
Add the MCP server:
```bash
codex mcp add agentify-desktop -- node mcp-server.mjs
```

Then use tools like `agentify_query` and pass a stable `key` (e.g. your repo name) to run parallel jobs without mixing contexts.

If you already had Codex open, restart it (or start a new session) so it reloads MCP server config. You can confirm registration via `codex mcp list`.

## How to use (practical)
- **Use ChatGPT normally (manual):** open the ChatGPT tab, write a plan/spec in the UI, then in Codex call `agentify_read_page` to pull the transcript into your workflow.
- **Drive ChatGPT from Codex:** call `agentify_ensure_ready`, then `agentify_query` with a `prompt`. Use a stable `key` per project to keep parallel jobs isolated.
- **Generate images:** ask for images via `agentify_query` (then call `agentify_download_images`), or generate them manually in the UI and then call download.

## Tool names and visibility
- Tool names are `agentify_*` (for example: `agentify_query`, `agentify_ensure_ready`, `agentify_tabs`).
- For debugging, you can make newly-created tab windows visible by default by running:
  - `./scripts/quickstart.sh --show-tabs`
- If you register manually, pass the flag through to the MCP command:
  - `codex mcp add agentify-desktop -- node mcp-server.mjs --show-tabs`

## Governor (anti-spam)
Agentify Desktop includes a built-in “governor” to reduce accidental high-rate automation:
- Limits concurrent in-flight queries.
- Limits queries per minute (token bucket).
- Enforces minimum gaps between queries (per tab + globally).

You can adjust these limits in the Control Center **Settings (governor)** section after acknowledging the disclaimer.

## Limitations / robustness notes
- **File upload selectors:** `input[type=file]` selection is best-effort; if ChatGPT changes the upload flow, update `selectors.json` or `~/.agentify-desktop/selectors.override.json`.
- **Completion detection:** waiting for “stop generating” to disappear + text stability works well, but can mis-detect on very long outputs or intermittent streaming pauses.
- **Image downloads:** prefers `<img>` elements in the latest assistant message; some UI modes may render images via nonstandard elements.
- **Parallelism model:** “tabs” are separate hidden windows; they can run in parallel without stealing focus unless a human check is required.
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
