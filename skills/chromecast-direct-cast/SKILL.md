---
name: chromecast-direct-cast
description: >-
  Use the chromecast-direct-cast TypeScript CLI for Chromecast, direct cast, Chrome Mirroring, DashCast, HLS, DASH, m3u8, cast URL, Chromecast volume, monitor or recover playback, "transmitir a Chromecast", and "reproducir en Chromecast" requests.
---

# Chromecast Direct Cast

Invoke the packaged CLI to discover an authorized HLS or DASH stream from a source page and cast it directly. Do not reimplement page or manifest extraction with shell commands.

## Operating Rules

1. Use only source pages provided by the user or pages they are authorized to access.
2. Do not bypass DRM, paywalls, authentication, signed-access checks, or other access controls.
3. Never print, save, log, or report discovered manifest URLs, query strings, tokens, cookies, or signatures.
4. Prefer direct playback over Chrome Mirroring for lower latency and better quality.
5. Do not treat `cast_site` or DashCast as an interactive-player solution; it cannot click or control page players.
6. Confirm the receiver reaches `PLAYING`; command success or `BUFFERING` alone is insufficient.

## Prerequisites and Setup

Require Node.js 20 or newer, npm, and `uvx` so the CLI can invoke its casting dependency:

```bash
command -v node && node --version
command -v npm
command -v uvx
```

From the package repository, install dependencies when needed, build the TypeScript CLI, and expose its declared binary:

```bash
npm ci
npm run build
npm link
```

Use an already installed `chromecast-direct-cast` binary when available; do not repeat setup for every cast.

## Command Interface

```text
chromecast-direct-cast cast <page-url> --device <name> [--volume <percent>] [--monitor <seconds>] [--poll <seconds>] [--recover <attempts>]
chromecast-direct-cast status --device <name>
chromecast-direct-cast stop --device <name>
chromecast-direct-cast volume <percent> --device <name>
```

`--device` may be omitted when `CHROMECAST_DEVICE` supplies the receiver name:

```bash
export CHROMECAST_DEVICE='<name>'
chromecast-direct-cast status
```

Cast defaults are 300 seconds of monitoring, 10-second polling, and 2 recovery attempts. Volume accepts an integer from 0 through 100.

## End-to-End Workflow

1. Confirm the source page and receiver are user-provided or authorized.
2. Inspect safe receiver fields with `chromecast-direct-cast status --device '<name>'`.
3. Run `chromecast-direct-cast cast '<page-url>' --device '<name>'`; add volume, monitoring, polling, or bounded recovery options only as needed.
4. Observe concise events such as `Discovering stream.`, `Casting.`, `State: ...`, `Recovering playback (...)`, and `Monitoring complete.`.
5. Verify `State: PLAYING` in monitored output or with a follow-up `status` command.
6. Let bounded recovery rediscover refreshed temporary links; do not extract or expose those links manually.
7. Use `chromecast-direct-cast volume '<percent>' --device '<name>'` only when requested, then report safe state and volume fields without tokens.
8. On request, run `chromecast-direct-cast stop --device '<name>'` and confirm `Playback stopped.`.

## Fallback Order

1. Use the site's native Cast control when direct CLI playback is unavailable.
2. Use Chrome **Cast tab** if native Cast is unavailable.
3. Avoid **Cast screen**, which usually has the worst quality and latency.

Report only the playback state, muted state, volume, recovery outcome, and whether playback was stopped; never include discovered media URLs or credentials.
