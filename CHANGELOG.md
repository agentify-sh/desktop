# Changelog

## 0.2.4 - 2026-05-17

### Fixed
- Fixed Windows Chrome CDP startup by spawning the Chrome/Edge/Brave executable directly without a shell.
- Added a regression test to keep Chrome CDP spawn options shell-free on every platform.

## 0.2.3 - 2026-05-17

### Fixed
- Fixed the Windows npm/global GUI launcher path by running Electron through its package CLI with Node instead of the Windows `.cmd` shim.
- Applied the same safer Electron launch resolution to MCP desktop auto-start.

### Changed
- Added Windows CI coverage for install/test and the npm CLI help path.
- Added README Windows notes for Chrome CDP and explicit browser executable configuration.

## 0.2.2 - 2026-05-17

### Fixed
- Restored the full governor UI from the prepared release work: digit-only inputs, narrow two-column layout, safe default values, and protection against live refresh wiping unsaved edits.
- Added the missing risk-disclaimer modal linked from the governor acknowledgement text.
- Restored the compact two-line footer with activity summary and color-coded status messages.
- Added bulk tab visibility bridge methods so the header show/hide-all control can use one desktop IPC call when available.
- Made Chrome CDP the first browser backend option in the Control Center.

### Verified
- Control Center script syntax check passed.
- Public package dry-run excludes private workflows.

## 0.2.1 - 2026-05-17

### Fixed
- Restored the intended icon-only Control Center header controls for opening the default tab, watch folder, artifacts folder, state folder, and refresh.
- Added the missing show/hide-all managed tabs toggle in the Control Center header.
- Kept the Orchestrator UI hidden from the Control Center public surface.

### Verified
- Control Center script syntax check passed.
- Public package dry-run excludes private workflows.

## 0.2.0 - 2026-05-17

### Added
- First npm-ready public package flow for `@agentify/desktop`, including npx/global CLI entrypoints for the desktop app and MCP server.
- Chrome CDP browser backend as the recommended path for real signed-in provider sessions, with Electron kept available as an explicit fallback.
- Agentify Control Center for managing vendor tabs, showing/hiding browser windows, inspecting activity, opening local state, and tuning runtime settings.
- Multi-vendor MCP workflow coverage for ChatGPT, Claude, Perplexity, Gemini, Google AI Studio, and Grok.
- Stable tab keys so parallel agent jobs can reuse the right browser session without mixing project context.
- Artifact workflows for saving generated files/images locally and reattaching them in follow-up prompts.
- Context packing and bundle workflows so agents can send selected repo/file context to a web AI session without manual copy/paste.
- Watch-folder support for indexing local output folders and making generated files easier to reuse.
- Governor safety controls for reducing accidental high-rate automation, including concurrency and pacing limits.
- README prompt examples for common MCP workflows after Agentify is installed.
- Explicit `.gitignore` protection for local-only private workflows.

### Changed
- Chrome CDP is the documented default browser engine because embedded Electron login flows are often blocked by SSO providers.
- README examples now focus on generic browser automation, artifact saving, context packing, and multi-vendor review workflows.
- MCP/tooling language is clearer about multi-vendor AI web UI automation instead of implying ChatGPT-only behavior.
- Control Center stale bridge errors now explain that the desktop app may need to be restarted after updating.
- Release packaging now keeps public npm contents focused on the generic desktop/MCP tool rather than domain-specific internal workflows.
- Removed private/domain-specific workflow language from public docs and package guidance.
- Updated package version from 0.1.2 to 0.2.0.

### Fixed
- MCP desktop auto-start resolves the bundled Electron binary relative to the Agentify package instead of the caller's current working directory.
- Package tests no longer assume the checkout directory is literally named `desktop`.
- Public README links now use repo-relative paths instead of local machine paths.

### Verified
- Published `@agentify/desktop@0.2.0` to npm with `latest` dist-tag.
- GitHub release `v0.2.0` published from the merged main branch.
- GitHub Actions CI passed for the release PR.
- Local test suite passed: 162/162 tests.
- Public package dry-run excludes private workflows.
- Public source scan excludes private workflow tool and module references.
