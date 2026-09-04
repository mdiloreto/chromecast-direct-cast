# Chromecast Direct Cast

TypeScript CLI for discovering an authorized HLS or DASH stream and playing it directly on a Chromecast through [`catt`](https://github.com/skorokithakis/catt).

Direct playback avoids the extra video compression and latency introduced by Chrome tab or screen mirroring. The CLI can monitor playback and refresh temporary stream URLs when a session drops.

## Requirements

- Node.js 20 or newer
- npm
- [`uvx`](https://docs.astral.sh/uv/guides/tools/) to run `catt`
- A Chromecast reachable from the local network

## Installation

```bash
git clone https://github.com/mdiloreto/chromecast-direct-cast.git
cd chromecast-direct-cast
npm ci
npm run build
npm link
```

## Usage

Cast from a page containing or linking to an HLS (`.m3u8`) or DASH (`.mpd`) player:

```bash
chromecast-direct-cast cast 'https://example.com/player' \
  --device 'Living Room' \
  --volume 60 \
  --monitor 300 \
  --poll 10 \
  --recover 2
```

The cast command waits for `PLAYING`, monitors state changes, and performs bounded rediscovery and recasting if playback becomes inactive or remains stuck buffering. It never prints the discovered manifest URL or its query parameters.

Other commands:

```bash
chromecast-direct-cast status --device 'Living Room'
chromecast-direct-cast volume 70 --device 'Living Room'
chromecast-direct-cast stop --device 'Living Room'
```

Set a default receiver to omit `--device`:

```bash
export CHROMECAST_DEVICE='Living Room'
```

Run `chromecast-direct-cast <command> --help` for all options. Cast defaults are 300 seconds of monitoring, 10-second polling, and 2 recovery attempts.

## Discovery

Discovery is static and bounded. It follows HTTP(S) redirects, nested iframe and player resources, source-like JavaScript assignments, and URL or Base64-encoded query parameters. Candidates must return a valid HLS or DASH manifest before they are sent to the Chromecast.

The CLI does not execute page JavaScript, read browser cookies, intercept browser traffic, download media segments, or bypass DRM, authentication, paywalls, geofencing, or other access controls. Dynamic or header-dependent players may not be supported.

Use the CLI only with pages and streams you are authorized to access.

## OpenCode Skill

The reusable skill is available at [`skills/chromecast-direct-cast/SKILL.md`](skills/chromecast-direct-cast/SKILL.md). Install it globally by placing that directory under `~/.config/opencode/skills/`, then restart OpenCode.

## Development

```bash
npm run check
```

The check runs ESLint, strict TypeScript validation, Vitest, and the production build. Tests use only synthetic resources under reserved domains.

## License

[MIT](LICENSE)
