# Security

## Local-only design
- The local control API binds to `127.0.0.1` (loopback only).
- Requests are rejected unless the client is loopback (`127.0.0.1`/`::1`).
- Auth uses a local bearer token stored at `~/.agentify-desktop/token.txt` (permissions `0600`).
- The chosen port is written to `~/.agentify-desktop/state.json`.

## CAPTCHA policy
- Agentify Desktop does **not** automate CAPTCHA solving.
- When a verification challenge appears, automation pauses and requires manual user intervention.

## Session data
- Electron cookies/localStorage are stored in `~/.agentify-desktop/electron-user-data/`.
- Anyone with local access to the machine may be able to access the signed-in session.

