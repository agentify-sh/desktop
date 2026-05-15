# Troly Win Agent

Troly Win Agent is a local control center for AI web sessions. It lets MCP-capable tools such as Codex, Claude Code, and OpenCode use the AI subscriptions you are already signed into, while keeping browser state, files, and automation on your machine.

This repository is currently based on the Agentify Desktop upstream codebase and is being adapted in phases for Troly-specific authentication, key sync, and workflow integration.

## What It Does

- Opens a local Troly Win Agent Control Center.
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
npx @kienbui-eup/trolywin
```

Equivalent explicit GUI command:

```bash
npx @kienbui-eup/trolywin gui
```

If you prefer a global install:

```bash
npm install -g @kienbui-eup/trolywin
trolywin
```

If you want the older repo-clone and local source workflow, use [DEVELOPMENT_FROM_SOURCE.md](/Users/upwiz/crowd4gpt.com/desktop/DEVELOPMENT_FROM_SOURCE.md).

## MCP Server

Run the MCP server over stdio:

```bash
npx @kienbui-eup/trolywin mcp
```

Show newly-created browser tabs while debugging:

```bash
npx @kienbui-eup/trolywin mcp --show-tabs
```

With a global install:

```bash
trolywin-mcp
trolywin-mcp --show-tabs
```

## Register With MCP Clients

Codex:

```bash
codex mcp add trolywin -- npx -y @kienbui-eup/trolywin mcp
```

Claude Code:

```bash
claude mcp add --transport stdio trolywin -- npx -y @kienbui-eup/trolywin mcp
```

OpenCode config example:

```json
{
  "mcp": {
    "trolywin": {
      "type": "local",
      "command": ["npx", "-y", "@kienbui-eup/trolywin", "mcp"],
      "enabled": true
    }
  }
}
```

Use `--show-tabs` at the end of the command while debugging:

```bash
codex mcp add trolywin -- npx -y @kienbui-eup/trolywin mcp --show-tabs
```

## First Run

1. Start the app:

```bash
npx @kienbui-eup/trolywin
```

2. In the Control Center, create or show a ChatGPT tab.

3. Sign in to the target vendor in the browser window.

4. Register the MCP server with your CLI.

5. Ask your MCP client to use Troly Win Agent:

```text
Use Troly Win Agent with tab key repo-triage.
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

Troly Win Agent supports two browser backends:

- `chrome-cdp`: launches or attaches to a Chrome-family browser over Chrome DevTools Protocol. This is the default and recommended backend.
- `electron`: embedded windows managed by Agentify Desktop. Use this only as an explicit fallback.

Chrome CDP is the default because SSO providers commonly block embedded Electron login:

```bash
npx @kienbui-eup/trolywin
```

Optional Chrome CDP settings:

```bash
AGENTIFY_DESKTOP_CHROME_DEBUG_PORT=9333 npx @kienbui-eup/trolywin
AGENTIFY_DESKTOP_CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx @kienbui-eup/trolywin
```

You can also pass GUI flags:

```bash
npx @kienbui-eup/trolywin gui --browser-backend chrome-cdp
npx @kienbui-eup/trolywin gui --browser-backend electron
npx @kienbui-eup/trolywin gui --chrome-debug-port 9333
```

Chrome CDP profile modes:

- `Agentify isolated profile`: safest default.
- `Existing Chrome profile`: reuses your normal Chrome session. Fully quit Chrome first so the profile is not already locked.

## CAPTCHA And Login Policy

Troly Win Agent does not bypass CAPTCHAs or use third-party solvers. If a verification or login challenge appears, automation pauses, brings the relevant window forward, and waits for you to complete the step manually.

If your account uses Google, Microsoft, or Apple SSO, keep auth popups enabled in the Control Center. If embedded login remains unreliable, use Chrome CDP.

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
