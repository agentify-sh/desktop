# Agentify Desktop

Agentify Desktop is a local-first control center for AI work: connect your real, logged-in AI subscriptions to your MCP-compatible CLI tools, all on your own machine.

### Why teams keep it open
- `🌐` **Real browser sessions, real accounts**: automate the web UIs you already use, without API-key migration.
- `🔌` **MCP-native integration**: works with Codex, Claude Code, OpenCode, and other MCP-capable clients.
- `🧵` **Parallel tabs for parallel work**: run multiple isolated workflows at once using stable tab keys.
- `📎` **Practical I/O support**: upload files, save generated images/files locally, and reattach them in later prompts.

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

Sign in to your target vendor in the tab window.

If your account uses SSO (Google/Microsoft/Apple), keep **Settings → Allow auth popups** enabled in the Control Center. ChatGPT login often opens provider auth in a popup, and blocking popups can prevent login from completing.

## Browser backend choice
Agentify Desktop now supports two browser backends:

- `electron` (default): embedded windows managed directly by Agentify.
- `chrome-cdp`: launches/attaches a real Chrome-family browser via the Chrome DevTools Protocol.

If Google/Microsoft/Apple SSO is fighting Electron, switch to **Settings → Browser backend → Chrome CDP**, save, then restart Agentify Desktop.

`chrome-cdp` notes:
- Uses a managed browser profile at `~/.agentify-desktop/chrome-user-data/`
- Default remote debugging port is `9222`
- Prefers your local Chrome install, but also works with Chromium / Brave / Edge
- Uses real browser login flows, which is the main reason to choose it

Profile options in the Control Center:
- `Agentify isolated profile` (default): safest and most predictable
- `Existing Chrome profile`: reuses your normal Chrome session/profile

If you choose `Existing Chrome profile`, fully quit regular Chrome first, then start Agentify Desktop. If Chrome is already using that profile, Agentify will fail fast with a hint instead of attaching to the wrong browser state.

## First Useful Workflow
This is the simplest real workflow to prove the product is doing something useful.

1. Start Agentify Desktop:
```bash
npm i
npm run start
```

2. In the Control Center:
- set `Browser backend` to `Chrome CDP`
- keep `Chrome profile mode` as `Agentify isolated profile`
- click `Save`
- restart Agentify Desktop if you changed the backend

3. Click `Show default`, then sign in to ChatGPT in the browser window.

4. Register the MCP server in your CLI.

Codex:
```bash
codex mcp add agentify-desktop -- node /ABS/PATH/TO/desktop/mcp-server.mjs
```

Claude Code:
```bash
claude mcp add --transport stdio agentify-desktop -- node /ABS/PATH/TO/desktop/mcp-server.mjs
```

5. In your MCP client, run this exact workflow:

Prompt:
```text
Create or reuse an Agentify tab with key repo-triage.
Use ChatGPT to answer this:
"Summarize the architecture of this repo in 8 bullets, then list the top 3 risky areas to change first."
Return the answer and keep the tab key stable for follow-ups.
```

6. Follow up in the same tab:

Prompt:
```text
Use the existing Agentify tab key repo-triage.
Ask for a test plan for changing one of those risky areas.
Return the plan as a short checklist.
```

That proves the core loop:
- keep a persistent logged-in web session
- call it from Codex / Claude Code over MCP
- reuse the same tab/session across multiple requests

### First artifact workflow
This is the fastest way to prove the image/file pipeline is useful.

1. Generate something in a stable tab:

Prompt:
```text
Use tab key sprite-lab.
Generate a simple 2D pixel-art robot sprite on a transparent background.
Give me 3 variations.
```

2. Save the latest generated outputs to disk:

```json
{
  "tool": "agentify_save_artifacts",
  "arguments": {
    "key": "sprite-lab",
    "mode": "images",
    "maxImages": 3
  }
}
```

The response includes local file paths. You can immediately reuse one of them in the next step.

3. Reattach one of the returned paths in the next prompt:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "sprite-lab",
    "prompt": "Take the attached sprite and create a damaged version with one broken eye and darker metal.",
    "attachments": [
      "/ABS/PATH/FROM/PREVIOUS/STEP/sprite.png"
    ]
  }
}
```

4. If you want the folder in Finder/Explorer:

```json
{
  "tool": "agentify_open_artifacts_folder",
  "arguments": {
    "key": "sprite-lab"
  }
}
```

That proves the artifact loop:
- generate in a real web session
- save locally without manual browser downloads
- reuse the saved file path in the next MCP prompt

### First codebase stuffing workflow
Use this when you want to hand a repo or folder tree to the model without manually copy/pasting files.

1. Ask Agentify to pack a folder into the next query:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review",
    "prompt": "Summarize this codebase in 8 bullets and list the top 3 risky files to change first.",
    "contextPaths": [
      "/ABS/PATH/TO/YOUR/REPO"
    ]
  }
}
```

2. Inspect the returned `packedContextSummary` in the tool result.

It tells you, at a glance:
- which roots were scanned
- how many files were scanned
- which text files were inlined
- which files were auto-attached
- which files were skipped and why

3. If the first pass is too large or too small, tighten the budget explicitly:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review",
    "prompt": "Focus only on the rendering pipeline and state management.",
    "contextPaths": [
      "/ABS/PATH/TO/YOUR/REPO"
    ],
    "maxContextChars": 60000,
    "maxContextFiles": 40,
    "maxContextChunkChars": 4000,
    "maxContextChunksPerFile": 2,
    "maxContextInlineFiles": 12,
    "maxContextAttachments": 6
  }
}
```

4. Reuse the same tab key for follow-ups:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review",
    "prompt": "Now give me a safe refactor plan for the top risky file."
  }
}
```

That proves the codebase loop:
- point Agentify at a folder
- let it inline text files and auto-attach binaries/images
- inspect what it included vs skipped
- keep the same live session for follow-up questions

### Watch-folder ingestion workflow
Use this when you want a dead-simple local drop zone.

1. Open the default inbox folder:

```json
{
  "tool": "agentify_open_watch_folder",
  "arguments": {}
}
```

2. Drop files into that folder from Finder/Explorer or another local tool.

3. Agentify will index them automatically. If you want to force it immediately:

```json
{
  "tool": "agentify_scan_watch_folder",
  "arguments": {}
}
```

4. List the ingested files and reuse their paths:

```json
{
  "tool": "agentify_list_artifacts",
  "arguments": {
    "limit": 20
  }
}
```

Then pass one of the returned `path` values into the next `attachments` array.

You can also add your own watched folders:

```json
{
  "tool": "agentify_add_watch_folder",
  "arguments": {
    "name": "sprites",
    "folderPath": "/ABS/PATH/TO/sprites"
  }
}
```

List them:

```json
{
  "tool": "agentify_list_watch_folders",
  "arguments": {}
}
```

Remove one later:

```json
{
  "tool": "agentify_remove_watch_folder",
  "arguments": {
    "name": "sprites"
  }
}
```

### Reusable context bundle workflow
Use this when you keep sending the same codebase roots, screenshots, and instruction prefix.

1. Save a bundle once:

```json
{
  "tool": "agentify_save_bundle",
  "arguments": {
    "name": "repo-review",
    "promptPrefix": "You are reviewing this repository for safe incremental changes. Be concrete and concise.",
    "contextPaths": [
      "/ABS/PATH/TO/repo/src",
      "/ABS/PATH/TO/repo/package.json"
    ],
    "attachments": [
      "/ABS/PATH/TO/repo/docs/architecture.png"
    ]
  }
}
```

2. Reuse it later in a normal query:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review-chatgpt",
    "bundleName": "repo-review",
    "prompt": "Find the riskiest auth-related change points and propose the smallest safe refactor plan."
  }
}
```

3. If needed, add extra one-off context on top of the bundle:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review-chatgpt",
    "bundleName": "repo-review",
    "promptPrefix": "Prioritize fixes we can ship today.",
    "contextPaths": [
      "/ABS/PATH/TO/repo/new-module"
    ],
    "prompt": "Update the plan with the new module included."
  }
}
```

Good next workflow:
- create separate keys like `cmp-chatgpt`, `cmp-claude`, `cmp-gemini`
- send the same architecture prompt to each
- compare answers before making changes

Optional overrides:
```bash
AGENTIFY_DESKTOP_BROWSER_BACKEND=chrome-cdp npm run start
AGENTIFY_DESKTOP_CHROME_DEBUG_PORT=9333 npm run start
AGENTIFY_DESKTOP_CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run start
```

Equivalent CLI flags:
```bash
npm run start -- --browser-backend chrome-cdp
npm run start -- --chrome-debug-port 9333
npm run start -- --chrome-binary "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

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

## Developer workflows (natural language)
Use plain requests in your MCP client. You usually do not need to call tool IDs directly.

1. **Plan in ChatGPT Pro or Gemini Deep Think, then execute in phases.**
Prompt:
"Open a Gemini tab with key `plan-auth-v2`, ask Deep Think for a migration plan from session cookies to JWT in this repo, and return a 10-step checklist with risk and rollback per step."
Follow-up:
"Now use key `plan-auth-v2` and generate step 1 implementation only, including tests."

2. **Prompt all vendors and compare output quality before coding.**
Prompt:
"Create tabs for keys `cmp-chatgpt`, `cmp-claude`, `cmp-gemini`, and `cmp-perplexity`. Send the same architecture prompt to each. Then compare responses in a table by correctness, operational risk, implementation complexity, and testability."

3. **Run incident triage with attached evidence.**
Prompt:
"Open key `incident-prod-api`, send `./incident/error.log` and `./incident/dashboard.png`, and produce: likely root cause, 30-minute hotfix plan, rollback, and validation checklist."

Use explicit tool calls (`agentify_query`, `agentify_read_page`, etc.) when you need deterministic/reproducible runs or when debugging tool selection.

## How to use (practical)
- **Use ChatGPT/Perplexity/Claude/AI Studio/Gemini/Grok normally (manual):** write a plan/spec in the UI, then in your MCP client call `agentify_read_page` to pull the transcript into your workflow.
- **Drive ChatGPT/Perplexity/Claude/AI Studio/Gemini/Grok from your MCP client:** call `agentify_ensure_ready`, then `agentify_query` with a `prompt`. Use a stable `key` per project to keep parallel jobs isolated.
- **Parallel jobs:** create/ensure a tab per project with `agentify_tab_create(key: ...)`, then use that `key` for `agentify_query`, `agentify_read_page`, and `agentify_download_images`.
- **Upload files:** pass local paths via `attachments` to `agentify_query` (best-effort; depends on the site UI).
- **Generate/save/reuse artifacts:** ask for images/files via `agentify_query`, then call `agentify_save_artifacts` or `agentify_download_images`. Reuse the returned local paths in the next `attachments` array.
- **Open the artifact folder quickly:** call `agentify_open_artifacts_folder` or click `Artifacts` in the Control Center.
- **Use local inbox/watch folders:** call `agentify_open_watch_folder`, `agentify_add_watch_folder`, or manage them in the Control Center. Each watched folder has a one-click open button in the UI.
- **Stuff folder context into a prompt:** pass `contextPaths` to `agentify_query`. Agentify will inline chunked text files into the prompt and auto-attach small binary/image files when useful.
- **Tune large-context packing when needed:** `agentify_query` also accepts `maxContextChars`, `maxContextFiles`, `maxContextFileChars`, `maxContextChunkChars`, `maxContextChunksPerFile`, `maxContextInlineFiles`, and `maxContextAttachments`.
- **Vendor-aware context budgets:** packed context defaults are tuned by the target vendor/tab so large folder stuffing is less aggressive on narrower UIs and more generous where it makes sense.
- **Break-glass stop for stuck runs:** `agentify_status` includes `activeQuery` / `runtime.activeQueries`, `agentify_stop_query` requests a stop, and the Control Center shows a `Stop` button on tabs with a running job.
- **Reuse project context without rebuilding it every time:** save a named bundle with `agentify_save_bundle`, then pass `bundleName` to `agentify_query`.

## Real-world prompt example
Example `agentify_query` input:
```json
{
  "key": "incident-triage-prod-api",
  "promptPrefix": "Prefer precise shell commands and call out risky assumptions.",
  "prompt": "You are my senior incident engineer. I attached a production error log and a screenshot from our monitoring dashboard.\\n\\nGoal: produce a high-confidence triage summary and a safe hotfix plan I can execute in 30 minutes.\\n\\nRequirements:\\n1) Identify the most likely root cause with evidence from the log lines.\\n2) List top 3 hypotheses and how to falsify each quickly.\\n3) Give a step-by-step hotfix plan with exact commands.\\n4) Include rollback steps and post-fix validation checks.\\n5) Keep response concise and actionable.\\n\\nReturn format:\\n- Root cause\\n- Evidence\\n- 30-minute hotfix plan\\n- Rollback\\n- Validation checklist",
  "attachments": [
    "./incident/error.log",
    "./incident/dashboard.png"
  ],
  "contextPaths": [
    "./src",
    "./package.json"
  ],
  "timeoutMs": 600000
}
```

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

## Not Supported Right Now
The experimental orchestrator / single-chat emulator is intentionally hidden from the desktop UI and is not supported right now.
The supported product surface is the local browser-control + MCP workflow described above.

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
- Check 4: Switch to the `chrome-cdp` backend and restart. This uses a real Chrome-family browser and avoids the embedded Electron auth path entirely.

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
