# Agentify Desktop

Agentify Desktop is a local-first desktop app that lets AI coding tools drive your existing web subscriptions (starting with ChatGPT) through a real, logged-in browser session on your machine.

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
- `grok.com`
- `aistudio.google.com`

## CAPTCHA policy (human-in-the-loop)
Agentify Desktop does **not** attempt to bypass CAPTCHAs or use third-party solvers. If a human verification appears, the app pauses automation, brings the relevant window to the front, and waits for you to complete the check manually.

## Requirements
- Node.js 20+ (22 recommended)
- Codex CLI (optional, for MCP)

## Quickstart (macOS/Linux)
This installs dependencies, registers the MCP server with Codex (if installed), and starts Agentify Desktop.

```bash
git clone git@github.com:agentify-sh/desktop.git
cd desktop
./scripts/quickstart.sh [--show-tabs]
```

Then:
- Sign in to `https://chatgpt.com/` in the Agentify Desktop window.
- Restart Codex so it picks up the MCP tool list.

## Manual install & run
```bash
npm i
npm run start
```

## Control Center
Use the app menu `Agentify Desktop → Control Center…` to:
- See and manage tabs (show/hide/close) for parallel jobs
- Edit safety settings saved locally under `~/.agentify-desktop/config.json`

## Connect from Codex (MCP)
Add the MCP server:
```bash
codex mcp add agentify-desktop -- node /ABS/PATH/TO/desktop/mcp-server.mjs [--show-tabs]
```

Verify it is installed:
```bash
codex mcp list
```

Restart Codex.

Then use tools like `agentify_query` and pass a stable `key` (e.g. `my-repo`) to run parallel jobs without mixing contexts.

Notes:
- Tool names are `agentify_*`.
- To make newly-created tab windows visible (instead of hidden/minimized), start the MCP server with `--show-tabs`, or pass `show: true` to `agentify_tab_create`.

## Common workflows
- **Parallel jobs:** call `agentify_tab_create` with a unique `key` per project, then use that `key` for `agentify_query` / `agentify_read_page`.
- **Plan in ChatGPT:** `agentify_query` with your planning prompt, then `agentify_read_page` if you need the full page text again.
- **Upload files:** pass local paths via `attachments` to `agentify_query` (best-effort; depends on the site UI).
- **Generate and download images:** use `agentify_image_gen`, or run `agentify_query` and then `agentify_download_images`.

## Limitations / robustness notes
- **File upload selectors:** `input[type=file]` selection is best-effort; if ChatGPT changes the upload flow, update `selectors.json` or `~/.agentify-desktop/selectors.override.json`.
- **Completion detection:** waiting for “stop generating” to disappear + text stability works well, but can mis-detect on very long outputs or intermittent streaming pauses.
- **Image downloads:** prefers `<img>` elements in the latest assistant message; some UI modes may render images via nonstandard elements.
- **Parallelism model:** “tabs” are separate windows; by default they are created hidden/minimized, but can be shown via `--show-tabs` or `agentify_tab_create(show: true)`.
- **Spam guard:** the local HTTP API limits concurrent `/query` calls across all tabs (default `6`). Override with `AGENTIFY_DESKTOP_MAX_PARALLEL_QUERIES`.
- **Request pacing:** `/query` is paced to be less “machine-like” (defaults: per-tab `250ms`, global `100ms`). Override with:
  - `AGENTIFY_DESKTOP_MIN_QUERY_GAP_MS`
  - `AGENTIFY_DESKTOP_MIN_QUERY_GAP_MS_GLOBAL`
  - `AGENTIFY_DESKTOP_QUERY_GAP_MAX_WAIT_MS` (0 = return `429 rate_limited` instead of waiting)
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
