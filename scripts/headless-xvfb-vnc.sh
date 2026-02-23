#!/usr/bin/env bash
set -euo pipefail

# Headless launcher for Agentify Desktop on Linux servers.
# - Creates a virtual X display via Xvfb
# - Starts a lightweight window manager (fluxbox)
# - Exposes that display via VNC (x11vnc), bound to localhost only
#
# Connect from your laptop using SSH/Tailscale port-forwarding:
#   ssh -L 5901:127.0.0.1:5901 ubuntu@<tailscale-ip-or-hostname>
# then open a VNC client to:
#   localhost:5901

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DISPLAY_NUM="${DISPLAY_NUM:-99}"
DISPLAY=":${DISPLAY_NUM}"
VNC_PORT="${VNC_PORT:-5901}"
SCREEN_W="${SCREEN_W:-1440}"
SCREEN_H="${SCREEN_H:-900}"
SCREEN_D="${SCREEN_D:-24}"

say() { printf "\n%s\n" "$*"; }
die() { printf "\nERROR: %s\n" "$*" >&2; exit 1; }

command -v Xvfb >/dev/null 2>&1 || die "Xvfb not found (install: sudo apt-get install xvfb)"
command -v fluxbox >/dev/null 2>&1 || die "fluxbox not found (install: sudo apt-get install fluxbox)"
command -v x11vnc >/dev/null 2>&1 || die "x11vnc not found (install: sudo apt-get install x11vnc)"
command -v npm >/dev/null 2>&1 || die "npm not found"

say "Agentify Desktop (headless)"
say "Repo: ${REPO_ROOT}"
say "DISPLAY: ${DISPLAY}"
say "VNC: 127.0.0.1:${VNC_PORT} (localhost-only)"

cleanup() {
  set +e
  [[ -n "${X11VNC_PID:-}" ]] && kill "${X11VNC_PID}" >/dev/null 2>&1 || true
  [[ -n "${FLUXBOX_PID:-}" ]] && kill "${FLUXBOX_PID}" >/dev/null 2>&1 || true
  [[ -n "${XVFB_PID:-}" ]] && kill "${XVFB_PID}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "1) Starting Xvfb..."
Xvfb "${DISPLAY}" \
  -screen 0 "${SCREEN_W}x${SCREEN_H}x${SCREEN_D}" \
  -nolisten tcp \
  >/dev/null 2>&1 &
XVFB_PID=$!

say "2) Starting fluxbox..."
DISPLAY="${DISPLAY}" fluxbox >/dev/null 2>&1 &
FLUXBOX_PID=$!

say "3) Starting VNC server (x11vnc)..."
# -localhost: bind to 127.0.0.1 only (use SSH/Tailscale port-forward)
# -nopw: no password (safe-ish because localhost-only). If you want a password,
#        replace -nopw with: -rfbauth ~/.agentify-desktop/vnc.pass
x11vnc \
  -display "${DISPLAY}" \
  -rfbport "${VNC_PORT}" \
  -localhost \
  -nopw \
  -forever \
  -shared \
  -quiet \
  >/dev/null 2>&1 &
X11VNC_PID=$!

say "4) Starting Agentify Desktop (Electron)..."
say "Tip: set AGENTIFY_DESKTOP_SHOW_TABS=true to show tabs by default."

cd "${REPO_ROOT}"
AGENTIFY_DESKTOP_SHOW_TABS="${AGENTIFY_DESKTOP_SHOW_TABS:-true}" \
DISPLAY="${DISPLAY}" \
npm run start
