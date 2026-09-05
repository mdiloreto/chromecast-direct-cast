import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  CattClient,
  CattError,
  redactUrls,
  type ChromecastDevice,
} from "./catt.js";
import { discoverManifest, DiscoveryError } from "./discovery.js";
import {
  superviseCast,
  SupervisorError,
  type CattController,
  type DiscoverManifest,
  type SupervisorConfig,
  type SupervisorDependencies,
  type SupervisorEvent,
} from "./supervisor.js";

export interface UiServerConfig {
  defaultFallbackUrls?: readonly string[];
  defaultPageUrl?: string;
  host: string;
  pollSeconds: number;
  port: number;
  signal?: AbortSignal;
}

export interface UiCattController extends CattController {
  scan(signal?: AbortSignal): Promise<ChromecastDevice[]>;
  stop(device: string, signal?: AbortSignal): Promise<void>;
}

export type UiSupervisor = (
  config: SupervisorConfig,
  dependencies: SupervisorDependencies,
) => Promise<void>;

export interface UiServerDependencies {
  catt?: UiCattController;
  discover?: DiscoverManifest;
  now?: () => Date;
  supervise?: UiSupervisor;
}

export interface UiServerHandle {
  close(): Promise<void>;
  closed: Promise<void>;
  origin: string;
}

interface StartRequest {
  device: string;
  fallbackPageUrls: string[];
  pageUrl: string;
}

interface ActiveJob {
  controller: AbortController;
  device: string;
  phase: "running" | "stopping";
  startedAt: string;
}

interface UiState {
  authority: string;
  events: string[];
  job?: ActiveJob;
  origin: string;
}

const MAX_EVENTS = 100;
const MAX_REQUEST_BODY_BYTES = 32_768;
const MAX_DEVICE_LENGTH = 255;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export class UiServerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UiServerError";
  }
}

class UiHttpError extends UiServerError {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "UiHttpError";
  }
}

export async function startUiServer(
  config: UiServerConfig,
  dependencies: UiServerDependencies = {},
): Promise<UiServerHandle> {
  validateServerConfig(config);
  if (config.signal?.aborted === true) {
    throw new UiServerError("UI startup was interrupted.");
  }

  const catt = dependencies.catt ?? new CattClient();
  const discover =
    dependencies.discover ??
    ((pageUrl: string, signal: AbortSignal) =>
      discoverManifest(pageUrl, { signal }));
  const runSupervisor = dependencies.supervise ?? superviseCast;
  const now = dependencies.now ?? (() => new Date());
  const state: UiState = { authority: "", events: [], origin: "" };

  const record = (message: string): void => {
    state.events.push(`${now().toISOString()} ${message}`);
    state.events.splice(0, Math.max(0, state.events.length - MAX_EVENTS));
  };

  const server = createServer((request, response) => {
    void routeRequest(
      request,
      response,
      config,
      catt,
      discover,
      runSupervisor,
      state,
      record,
    ).catch((error: unknown) => {
      sendJson(response, statusFromError(error), {
        error: publicErrorMessage(error),
      });
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch {
    throw new UiServerError("Unable to start the local web UI.");
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new UiServerError("Unable to determine the local web UI address.");
  }

  const origin = formatOrigin(config.host, address.port);
  state.origin = origin;
  state.authority = new URL(origin).host.toLowerCase();

  const closed = new Promise<void>((resolve) => {
    server.once("close", resolve);
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) {
      return closing;
    }
    state.job?.controller.abort();
    closing = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(new UiServerError("Unable to stop the local web UI."));
        }
      });
      server.closeIdleConnections();
    });
    return closing;
  };
  const closeOnAbort = (): void => {
    void close().catch(() => undefined);
  };
  config.signal?.addEventListener("abort", closeOnAbort, { once: true });
  server.once("close", () => {
    config.signal?.removeEventListener("abort", closeOnAbort);
  });

  process.stdout.write(`Chromecast UI listening on ${origin}\n`);

  return { close, closed, origin };
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: UiServerConfig,
  catt: UiCattController,
  discover: DiscoverManifest,
  runSupervisor: UiSupervisor,
  state: UiState,
  record: (message: string) => void,
): Promise<void> {
  validateHost(request, state.authority);
  const url = new URL(request.url ?? "/", state.origin);

  if (request.method === "GET" && url.pathname === "/") {
    const nonce = randomBytes(18).toString("base64");
    sendHtml(response, renderPage(config, nonce), nonce);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/devices") {
    const devices = await catt.scan(config.signal);
    sendJson(response, 200, { devices });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/job") {
    sendJson(response, 200, jobSnapshot(state));
    return;
  }

  if (request.method === "POST") {
    validateWriteRequest(request, state.origin);
  }

  if (request.method === "POST" && url.pathname === "/api/start") {
    const body = await readJsonBody(request);
    const startRequest = parseStartRequest(body);
    if (state.job !== undefined) {
      throw new UiHttpError(
        "A monitor is already active. Stop it before starting another.",
        409,
      );
    }

    const controller = new AbortController();
    const job: ActiveJob = {
      controller,
      device: startRequest.device,
      phase: "running",
      startedAt: new Date().toISOString(),
    };
    state.job = job;
    record("starting monitor");

    void runSupervisor(
      {
        device: startRequest.device,
        ...(startRequest.fallbackPageUrls.length === 0
          ? {}
          : { fallbackPageUrls: startRequest.fallbackPageUrls }),
        monitorSeconds: 0,
        pageUrl: startRequest.pageUrl,
        pollSeconds: config.pollSeconds,
        recoverAttempts: 0,
        signal: controller.signal,
      },
      {
        catt,
        discover,
        emit: (event) => {
          record(formatSupervisorEvent(event));
        },
      },
    )
      .catch((error: unknown) => {
        record(`monitor stopped: ${publicErrorMessage(error)}`);
      })
      .finally(() => {
        if (state.job === job && job.phase === "running") {
          delete state.job;
        }
      });

    sendJson(response, 202, jobSnapshot(state));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/stop") {
    parseStopRequest(await readJsonBody(request));
    const job = state.job;
    if (job === undefined || job.phase === "stopping") {
      sendJson(response, 200, jobSnapshot(state));
      return;
    }

    job.phase = "stopping";
    job.controller.abort();
    record("stopping monitor and playback");
    try {
      await catt.stop(job.device);
      record("monitor and playback stopped");
    } catch (error) {
      record("monitor stopped; playback stop failed");
      throw error;
    } finally {
      if (state.job === job) {
        delete state.job;
      }
    }
    sendJson(response, 200, jobSnapshot(state));
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of request) {
    let buffer: Buffer;
    if (Buffer.isBuffer(chunk)) {
      buffer = chunk;
    } else if (typeof chunk === "string") {
      buffer = Buffer.from(chunk);
    } else if (chunk instanceof Uint8Array) {
      buffer = Buffer.from(chunk);
    } else {
      throw new UiHttpError("Request body is not readable.", 400);
    }
    bytesRead += buffer.byteLength;
    if (bytesRead > MAX_REQUEST_BODY_BYTES) {
      throw new UiHttpError("Request body is too large.", 413);
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new UiHttpError("Request body must be valid JSON.", 400);
  }
}

function parseStopRequest(value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length > 0
  ) {
    throw new UiHttpError("Stop request must be an empty object.", 400);
  }
}

function parseStartRequest(value: unknown): StartRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UiHttpError("Start request must be an object.", 400);
  }

  const request = value as Record<string, unknown>;
  const allowedFields = new Set(["device", "fallbackPageUrls", "pageUrl"]);
  if (Object.keys(request).some((key) => !allowedFields.has(key))) {
    throw new UiHttpError("Start request contains unsupported fields.", 400);
  }

  const pageUrl = parsePageUrl(request.pageUrl, "Primary URL");
  const fallbackPageUrls = parseFallbackPageUrls(request.fallbackPageUrls);
  const device = request.device;
  if (typeof device !== "string" || device.trim().length === 0) {
    throw new UiHttpError("Device is required.", 400);
  }

  const normalizedDevice = device.trim();
  if (
    normalizedDevice.length > MAX_DEVICE_LENGTH ||
    containsControlCharacter(normalizedDevice)
  ) {
    throw new UiHttpError("Device is not valid.", 400);
  }

  return {
    device: normalizedDevice,
    fallbackPageUrls,
    pageUrl,
  };
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function parseFallbackPageUrls(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new UiHttpError("Fallback URLs must be an array.", 400);
  }
  return value.map((pageUrl, index) =>
    parsePageUrl(pageUrl, `Fallback URL ${String(index + 1)}`),
  );
}

function parsePageUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UiHttpError(`${label} is required.`, 400);
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new UiHttpError(`${label} must use HTTP or HTTPS.`, 400);
    }
    if (url.username !== "" || url.password !== "") {
      throw new UiHttpError(`${label} must not include credentials.`, 400);
    }
    return url.href;
  } catch (error) {
    if (error instanceof UiServerError) {
      throw error;
    }
    throw new UiHttpError(`${label} is not a valid URL.`, 400);
  }
}

function jobSnapshot(state: UiState): object {
  if (state.job === undefined) {
    return { events: [...state.events], status: "idle" };
  }
  return {
    device: state.job.device,
    events: [...state.events],
    startedAt: state.job.startedAt,
    status: state.job.phase,
  };
}

function formatSupervisorEvent(event: SupervisorEvent): string {
  switch (event.type) {
    case "casting":
      return `casting ${event.source}`;
    case "complete":
      return "monitoring complete";
    case "discovering":
      return `discovering ${event.source}`;
    case "interrupted":
      return "interrupted";
    case "recovering":
      return event.maximum === undefined
        ? `recovering attempt ${String(event.attempt)} (unlimited)`
        : `recovering ${String(event.attempt)}/${String(event.maximum)}`;
    case "state":
      return `state ${event.state}`;
  }
}

function validateServerConfig(config: UiServerConfig): void {
  if (!LOOPBACK_HOSTS.has(config.host)) {
    throw new UiServerError("UI host must be 127.0.0.1 or ::1.");
  }
  if (
    !Number.isSafeInteger(config.port) ||
    config.port < 0 ||
    config.port > 65_535
  ) {
    throw new UiServerError("UI port must be between 0 and 65535.");
  }
  if (!Number.isSafeInteger(config.pollSeconds) || config.pollSeconds <= 0) {
    throw new UiServerError("UI polling interval must be a positive integer.");
  }
}

function validateHost(request: IncomingMessage, expectedAuthority: string): void {
  if (request.headers.host?.toLowerCase() !== expectedAuthority) {
    throw new UiHttpError("Request host is not allowed.", 403);
  }
}

function validateWriteRequest(
  request: IncomingMessage,
  expectedOrigin: string,
): void {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== expectedOrigin) {
    throw new UiHttpError("Request origin is not allowed.", 403);
  }

  const contentType = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new UiHttpError("Content-Type must be application/json.", 415);
  }
}

function formatOrigin(host: string, port: number): string {
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return `http://${formattedHost}:${String(port)}`;
}

function statusFromError(error: unknown): number {
  if (error instanceof UiHttpError) {
    return error.status;
  }
  return error instanceof UiServerError ? 400 : 500;
}

function publicErrorMessage(error: unknown): string {
  if (
    error instanceof CattError ||
    error instanceof DiscoveryError ||
    error instanceof SupervisorError ||
    error instanceof UiServerError
  ) {
    return redactUrls(error.message);
  }
  return "Unexpected error.";
}

const COMMON_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

function sendHtml(response: ServerResponse, html: string, nonce: string): void {
  response.writeHead(200, {
    ...COMMON_HEADERS,
    "content-security-policy": [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
    ].join("; "),
    "content-type": "text/html; charset=utf-8",
  });
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, {
    ...COMMON_HEADERS,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function renderPage(config: UiServerConfig, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chromecast Direct Cast</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #24304d, #090b10 62%); color: #f6f7fb; }
    main { width: min(760px, calc(100% - 32px)); margin: 0 auto; padding: 40px 0; }
    .card { background: rgba(12, 16, 28, 0.86); border: 1px solid rgba(255,255,255,0.12); border-radius: 24px; padding: 24px; box-shadow: 0 24px 80px rgba(0,0,0,0.38); }
    h1 { margin: 0 0 8px; font-size: clamp(28px, 6vw, 48px); letter-spacing: -0.04em; }
    p { color: #bbc4d7; margin: 0 0 24px; }
    label { display: grid; gap: 8px; margin: 16px 0; font-weight: 700; }
    input, select, textarea { width: 100%; box-sizing: border-box; border: 1px solid rgba(255,255,255,0.18); border-radius: 14px; background: #111827; color: #fff; padding: 13px 14px; font: inherit; }
    textarea { min-height: 96px; resize: vertical; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 20px; }
    button { border: 0; border-radius: 999px; padding: 12px 18px; font: inherit; font-weight: 800; cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    .primary { background: #d4ed31; color: #111; }
    .secondary { background: #2b3347; color: #fff; }
    .status { display: inline-flex; align-items: center; gap: 8px; margin-top: 20px; color: #bbc4d7; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #737b8f; }
    .dot.running { background: #44e07d; box-shadow: 0 0 18px #44e07d; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #06080d; border-radius: 16px; padding: 16px; min-height: 160px; color: #c8d2e8; }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>Chromecast Direct Cast</h1>
      <p>Load primary and fallback pages, choose a receiver, then monitor and recover direct playback.</p>
      <form id="castForm">
        <label>Discovered device
          <select id="device"><option value="">Scanning...</option></select>
        </label>
        <label>Manual device name or address
          <input id="manualDevice" value="" placeholder="Receiver name or address">
        </label>
        <label>Primary page URL
          <input id="pageUrl" type="url" required value="${escapeHtml(config.defaultPageUrl ?? "")}" placeholder="https://example.com/player">
        </label>
        <label>Fallback page URLs (optional, one per line)
          <textarea id="fallbackPageUrls" placeholder="https://example.com/backup-player">${escapeHtml((config.defaultFallbackUrls ?? []).join("\n"))}</textarea>
        </label>
        <div class="actions">
          <button class="primary" id="start" type="submit">Start</button>
          <button class="secondary" id="stop" type="button">Stop</button>
          <button class="secondary" id="refresh" type="button">Refresh devices</button>
        </div>
      </form>
      <div class="status" aria-live="polite"><span class="dot" id="dot"></span><span id="summary">Idle</span></div>
      <pre id="events" aria-label="Monitor events"></pre>
    </section>
  </main>
  <script nonce="${escapeHtml(nonce)}">
    const form = document.querySelector('#castForm');
    const device = document.querySelector('#device');
    const manualDevice = document.querySelector('#manualDevice');
    const pageUrl = document.querySelector('#pageUrl');
    const fallbackPageUrls = document.querySelector('#fallbackPageUrls');
    const events = document.querySelector('#events');
    const summary = document.querySelector('#summary');
    const dot = document.querySelector('#dot');
    const startButton = document.querySelector('#start');
    const stopButton = document.querySelector('#stop');

    function errorMessage(error) {
      return error instanceof Error ? error.message : 'Request failed';
    }

    function showError(error) {
      summary.textContent = errorMessage(error);
    }

    async function json(path, options = {}) {
      const response = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        ...options,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed');
      return body;
    }

    function showEmptyDeviceOption(label) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = label;
      device.replaceChildren(option);
    }

    async function loadDevices() {
      summary.textContent = 'Scanning devices...';
      const previousDevice = device.value;
      let body;
      try {
        body = await json('/api/devices');
      } catch (error) {
        showEmptyDeviceOption('Scan failed; use a manual device');
        showError(error);
        return;
      }
      if (!Array.isArray(body.devices) || body.devices.length === 0) {
        showEmptyDeviceOption('No devices found; use a manual device');
        summary.textContent = 'No devices found';
        return;
      }
      const options = body.devices.map((item) => {
        const option = document.createElement('option');
        option.value = item.host;
        option.textContent = item.name + ' (' + item.host + ')';
        return option;
      });
      device.replaceChildren(...options);
      if (options.some((option) => option.value === previousDevice)) {
        device.value = previousDevice;
      }
      summary.textContent = 'Found ' + body.devices.length + ' device(s)';
    }

    async function refreshJob() {
      const body = await json('/api/job');
      const running = body.status === 'running';
      const stopping = body.status === 'stopping';
      dot.classList.toggle('running', running);
      summary.textContent = running
        ? 'Monitoring ' + body.device
        : stopping
          ? 'Stopping ' + body.device
          : 'Idle';
      startButton.disabled = running || stopping;
      stopButton.disabled = !running;
      events.textContent = Array.isArray(body.events) ? body.events.join('\\n') : '';
    }

    async function start() {
      const selectedDevice = manualDevice.value.trim() || device.value;
      await json('/api/start', {
        method: 'POST',
        body: JSON.stringify({
          device: selectedDevice,
          pageUrl: pageUrl.value,
          fallbackPageUrls: fallbackPageUrls.value
            .split(/\\r?\\n/)
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      });
      await refreshJob();
    }

    async function stop() {
      await json('/api/stop', { method: 'POST', body: '{}' });
      await refreshJob();
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void start().catch(showError);
    });
    stopButton.addEventListener('click', () => { void stop().catch(showError); });
    document.querySelector('#refresh').addEventListener('click', () => {
      void loadDevices().catch(showError);
    });
    setInterval(() => { void refreshJob().catch(showError); }, 2000);
    void Promise.all([loadDevices(), refreshJob()]).catch(showError);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
