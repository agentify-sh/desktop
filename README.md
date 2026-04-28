# Agentify Desktop

Agentify Desktop is a local control center for AI web sessions. It lets MCP-capable tools such as Codex, Claude Code, and OpenCode use the AI subscriptions you are already signed into, while keeping browser state, files, and automation on your machine.

## What It Does

- Opens a local Agentify Control Center.
- Manages signed-in browser sessions for ChatGPT, Claude, Perplexity, Gemini, Google AI Studio, and Grok.
- Exposes MCP tools for querying a tab, reading a page, navigating, uploading files, saving artifacts, and reusing stable tab keys.
- Supports parallel tabs so different agents or tasks can use separate sessions.
- Packs local repo/file context into prompts when requested.
- Saves generated images/files locally so they can be reused in follow-up prompts.

## Requirements

- Node.js 20 or newer
- An MCP-capable CLI if you want tool integration: Codex, Claude Code, or OpenCode

## Supported Sites

- `chatgpt.com`
- `claude.ai`
- `perplexity.ai`
- `aistudio.google.com`
- `gemini.google.com`
- `grok.com`

## Preferred Install And Run

Start the desktop GUI without cloning this repo:

```bash
npx @agentify/desktop
```

Equivalent explicit GUI command:

```bash
npx @agentify/desktop gui
```

If you prefer a global install:

```bash
npm install -g @agentify/desktop
agentify-desktop
```

If you want the older repo-clone and local source workflow, use [DEVELOPMENT_FROM_SOURCE.md](/Users/upwiz/crowd4gpt.com/desktop/DEVELOPMENT_FROM_SOURCE.md).

## MCP Server

Run the MCP server over stdio:

```bash
npx @agentify/desktop mcp
```

Show newly-created browser tabs while debugging:

```bash
npx @agentify/desktop mcp --show-tabs
```

With a global install:

```bash
agentify-desktop-mcp
agentify-desktop-mcp --show-tabs
```

## Register With MCP Clients

Codex:

```bash
codex mcp add agentify-desktop -- npx -y @agentify/desktop mcp
```

Claude Code:

```bash
claude mcp add --transport stdio agentify-desktop -- npx -y @agentify/desktop mcp
```

OpenCode config example:

```json
{
  "mcp": {
    "agentify-desktop": {
      "type": "local",
      "command": ["npx", "-y", "@agentify/desktop", "mcp"],
      "enabled": true
    }
  }
}
```

Use `--show-tabs` at the end of the command while debugging:

```bash
codex mcp add agentify-desktop -- npx -y @agentify/desktop mcp --show-tabs
```

## First Run

1. Start the app:

```bash
npx @agentify/desktop
```

2. In the Control Center, create or show a ChatGPT tab.

3. Sign in to the target vendor in the browser window.

4. Register the MCP server with your CLI.

5. Ask your MCP client to use Agentify:

```text
Use Agentify Desktop with tab key repo-triage.
Ask ChatGPT to summarize this repo in 8 bullets and list the top 3 risky areas to change first.
Return the answer and keep the tab key stable for follow-ups.
```

The core loop is:

- keep a real signed-in browser session open locally
- call it from an MCP client
- reuse a stable tab key across follow-up prompts

## Useful MCP Tools

The MCP server registers `agentify_*` tools, including:

- `agentify_query`: send a prompt to a stable tab and return the assistant response.
- `agentify_read_page`: read visible page text from a tab.
- `agentify_navigate`: navigate a tab to a URL.
- `agentify_ensure_ready`: wait for login, CAPTCHA, or UI readiness.
- `agentify_show` / `agentify_hide`: bring windows forward or minimize them.
- `agentify_status`: inspect tab and readiness state.
- `agentify_tabs`, `agentify_tab_create`, `agentify_tab_close`: manage tabs.
- `agentify_save_artifacts`, `agentify_list_artifacts`, `agentify_open_artifacts_folder`: manage generated files/images.
- `agentify_save_bundle`, `agentify_list_bundles`: save and reuse context bundles.
- `agentify_add_watch_folder`, `agentify_list_watch_folders`, `agentify_remove_watch_folder`: manage watched folders.

## Artifact Workflow

Generate an image or file in a stable tab:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "sprite-lab",
    "prompt": "Generate 3 simple 2D pixel-art robot sprite variations on transparent backgrounds."
  }
}
```

Save the generated images locally:

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

Reattach one of the returned file paths in a follow-up:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "sprite-lab",
    "prompt": "Use the attached sprite and make a damaged version with one broken eye.",
    "attachments": ["/absolute/path/to/sprite.png"]
  }
}
```

## Codebase Context Workflow

Ask Agentify to pack local files or folders into a prompt:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review",
    "prompt": "Summarize this codebase in 8 bullets and list the top 3 risky files to change first.",
    "contextPaths": ["/absolute/path/to/repo"]
  }
}
```

Control context size:

```json
{
  "tool": "agentify_query",
  "arguments": {
    "key": "repo-review",
    "prompt": "Focus only on rendering and state management.",
    "contextPaths": ["/absolute/path/to/repo"],
    "maxContextChars": 120000,
    "maxContextFiles": 80,
    "maxContextInlineFiles": 30
  }
}
```

The tool result includes `packedContextSummary` so you can see what was included, attached, or skipped.

## Browser Backend

Agentify Desktop supports two browser backends:

- `electron`: embedded windows managed by Agentify Desktop. This is the default.
- `chrome-cdp`: launches or attaches to a Chrome-family browser over Chrome DevTools Protocol.

Use Chrome CDP when SSO providers fight embedded Electron login:

```bash
AGENTIFY_DESKTOP_BROWSER_BACKEND=chrome-cdp npx @agentify/desktop
```

Optional Chrome CDP settings:

```bash
AGENTIFY_DESKTOP_CHROME_DEBUG_PORT=9333 npx @agentify/desktop
AGENTIFY_DESKTOP_CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx @agentify/desktop
# Linux example using PATH lookup:
AGENTIFY_DESKTOP_CHROME_PATH=$(which google-chrome-stable) AGENTIFY_DESKTOP_BROWSER_BACKEND=chrome-cdp npx @agentify/desktop
```

You can also pass GUI flags:

```bash
npx @agentify/desktop gui --browser-backend chrome-cdp
npx @agentify/desktop gui --chrome-debug-port 9333
```

Chrome CDP profile modes:

- `Agentify isolated profile`: safest default.
- `Existing Chrome profile`: reuses your normal Chrome session. Fully quit Chrome first so the profile is not already locked.

## CAPTCHA And Login Policy

Agentify Desktop does not bypass CAPTCHAs or use third-party solvers. If a verification or login challenge appears, automation pauses, brings the relevant window forward, and waits for you to complete the step manually.

If your account uses Google, Microsoft, or Apple SSO, keep auth popups enabled in the Control Center. If embedded login remains unreliable, use Chrome CDP.

## Google SSO ("Continue with Google")

Symptom: clicking **Continue with Google** in ChatGPT (or another vendor) shows
`This browser or app may not be secure. Try using a different browser.`

There are two distinct issues here, and only one of them is fully under
Agentify Desktop's control.

### What the Electron backend fix actually does

The Google OAuth flow opens an `about:blank` window first and then navigates
it to `accounts.google.com`. Earlier builds of Agentify Desktop denied that
`about:blank` pre-open, so the sign-in window never even appeared. The
current build allows that pre-open when the opener is one of the supported
vendor hosts (ChatGPT, Claude, Perplexity, Gemini, AI Studio, Grok). This is
gated — untrusted openers are still denied. **This fix only addresses popup
gating; it does not bypass Google's anti-embedded-browser checks.**

Make sure **Allow auth popups** is enabled in the Control Center (it is on
by default).

### What it does NOT fix

Google evaluates the window itself and may still refuse sign-in with
*"This browser or app may not be secure"* whenever it classifies the window
as an embedded webview. Agentify Desktop's Electron backend spoofs a Chrome
user agent and disables the `AutomationControlled` Blink feature, but
Google's heuristics evolve and the embedded Electron window is sometimes
blocked anyway. **If you see the "may not be secure" message, the Electron
backend cannot reliably resolve it on its own — you need the Chrome CDP
backend (below).**

### Chrome CDP backend — required fallback for Google SSO

The Chrome CDP backend launches your real Chrome/Chromium binary over the
DevTools Protocol. Google does not flag a real Chrome window the way it
flags an embedded one, so SSO works there.

Linux/macOS, default detection (Agentify probes common Chrome/Chromium
binaries on `PATH`):

```bash
AGENTIFY_DESKTOP_BROWSER_BACKEND=chrome-cdp npx @agentify/desktop
```

Local source checkout (this repo), equivalent to `npm start` with the env
var:

```bash
AGENTIFY_DESKTOP_BROWSER_BACKEND=chrome-cdp npm start
```

Explicit Chrome path (useful when auto-detection picks the wrong binary or
the user has a custom install):

```bash
AGENTIFY_DESKTOP_CHROME_PATH=$(which google-chrome-stable) \
AGENTIFY_DESKTOP_BROWSER_BACKEND=chrome-cdp npx @agentify/desktop
```

`AGENTIFY_DESKTOP_CHROME_PATH` is an alias of `AGENTIFY_DESKTOP_CHROME_BIN`;
either name works. The CLI flag form is `--chrome-binary /path/to/chrome`.

Reuse your already-signed-in Chrome profile (must fully quit regular Chrome
first so the profile is unlocked):

```bash
AGENTIFY_DESKTOP_BROWSER_BACKEND=chrome-cdp \
AGENTIFY_DESKTOP_CHROME_PROFILE_MODE=existing \
AGENTIFY_DESKTOP_CHROME_PROFILE_NAME=Default \
npx @agentify/desktop
```

You can also flip **Browser backend → Chrome CDP** in the Control Center.

### Linux: where to put environment variables

GUI launches on Linux (clicking a `.desktop` entry, App menu, AppImage, etc.)
do NOT load `~/.bashrc` / `~/.zshrc`. If you only export
`AGENTIFY_DESKTOP_BROWSER_BACKEND` in a shell rc file, terminal launches will
see it but GUI launches will not.

For GUI launches, set env vars in one of:

- `~/.profile` (Bourne-shell login profile, picked up by most display managers)
- `~/.config/environment.d/agentify-desktop.conf` (systemd user environment)
- The `Exec=` line of a custom `.desktop` launcher, e.g.
  `Exec=env AGENTIFY_DESKTOP_BROWSER_BACKEND=chrome-cdp npx @agentify/desktop`

Log out and back in for `~/.profile` / `environment.d` changes to take effect.

### Diagnosing `chrome_cdp_unavailable`

If the Chrome CDP backend itself fails to start, Agentify Desktop now shows
the captured Chrome stderr, the executable it tried, the launch args, the
debug port, the exit code, and a suggested fix. Common causes:

- Chrome/Chromium not on `PATH` and `AGENTIFY_DESKTOP_CHROME_PATH` not set
  → install Chrome or Chromium, or set the env var.
- Snap-confined Chrome refusing the user-data-dir under `~/.agentify-desktop/`
  → install the apt/dnf/Flatpak Chrome instead, or point at a non-snap
  binary via `AGENTIFY_DESKTOP_CHROME_PATH`.
- Profile already locked by a regular Chrome window in `existing` mode
  → fully quit regular Chrome and retry.
- SUID sandbox issue on some Linux distros (visible in the captured stderr)
  → use the distribution-packaged Chrome/Chromium that bundles the helper.

If you cannot get `chrome-cdp` working, the Electron backend remains usable
for vendors and flows that do not require Google SSO.

## Local Data And Privacy

Agentify Desktop is local-first:

- The local API binds to `127.0.0.1`.
- The local API requires a bearer token stored under `~/.agentify-desktop/`.
- Electron browser data is stored under `~/.agentify-desktop/electron-user-data/`.
- Chrome CDP profile data is stored under `~/.agentify-desktop/chrome-user-data/` unless you choose an existing profile.
- Artifacts, bundles, logs, and state are stored under `~/.agentify-desktop/`.

Anyone with access to your machine account may be able to access local session data. Treat the machine account as the security boundary.

## Environment Variables

- `AGENTIFY_DESKTOP_STATE_DIR`: override the local state directory.
- `AGENTIFY_DESKTOP_PORT`: choose the local API port.
- `AGENTIFY_DESKTOP_SHOW_TABS=true`: show newly-created tabs by default.
- `AGENTIFY_DESKTOP_MAX_TABS`: cap parallel tabs.
- `AGENTIFY_DESKTOP_BROWSER_BACKEND=electron|chrome-cdp`: choose browser backend.
- `AGENTIFY_DESKTOP_CHROME_BIN`: choose Chrome/Chromium executable.
- `AGENTIFY_DESKTOP_CHROME_PATH`: alias of `AGENTIFY_DESKTOP_CHROME_BIN` (either is accepted).
- `AGENTIFY_DESKTOP_CHROME_DEBUG_PORT`: choose Chrome debug port.
- `AGENTIFY_DESKTOP_CHROME_PROFILE_MODE=isolated|existing`: choose Chrome profile mode.
- `AGENTIFY_DESKTOP_CHROME_PROFILE_NAME`: choose an existing Chrome profile name.

## Development From Source

Source checkout, quickstart script usage, local build commands, and source-only debugging notes live in [DEVELOPMENT_FROM_SOURCE.md](/Users/upwiz/crowd4gpt.com/desktop/DEVELOPMENT_FROM_SOURCE.md).

## Package Commands

The npm package exposes these commands:

- `agentify-desktop`: default GUI launcher, with `mcp` subcommand support.
- `agentify-desktop-gui`: explicit GUI alias.
- `agentify-desktop-mcp`: explicit MCP alias.

Examples:

```bash
npx @agentify/desktop
npx @agentify/desktop mcp
npx -p @agentify/desktop agentify-desktop-mcp
```

## License And Trademarks

The code is licensed under `MPL-2.0`. Agentify trademarks and branding are not included in that license. See [TRADEMARKS.md](/Users/upwiz/crowd4gpt.com/desktop/TRADEMARKS.md).
