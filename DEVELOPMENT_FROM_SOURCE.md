# Development From Source

This guide is for contributors and power users who want to run Agentify Desktop directly from a repo checkout.

For the normal install path, use the npm package from [README.md](/Users/upwiz/crowd4gpt.com/desktop/README.md):

```bash
npx @agentify/desktop
```

## Quickstart

Clone the repo and run the helper script:

```bash
git clone git@github.com:agentify-sh/desktop.git
cd desktop
./scripts/quickstart.sh
```

Useful quickstart variants:

```bash
./scripts/quickstart.sh --show-tabs
./scripts/quickstart.sh --foreground
./scripts/quickstart.sh --client codex
./scripts/quickstart.sh --client claude
./scripts/quickstart.sh --client opencode
./scripts/quickstart.sh --client all
./scripts/quickstart.sh --client none
```

## Manual Source Workflow

Install dependencies:

```bash
npm install
```

Run the desktop app from source:

```bash
npm run start
```

Run the MCP server from source:

```bash
npm run mcp
```

Run tests:

```bash
npm test
```

Build distributable desktop artifacts:

```bash
npm run dist
```

Smoke-test the npm launcher from source:

```bash
node ./bin/agentify-desktop.mjs --help
```

## When Source Mode Helps

- You are modifying Electron or MCP server code.
- You want to debug startup or login issues with local logs.
- You need to test changes before publishing a new npm package.
