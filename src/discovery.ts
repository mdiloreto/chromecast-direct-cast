import { Buffer } from "node:buffer";

import { load } from "cheerio";

export interface DiscoveryLimits {
  maxDepth: number;
  maxResources: number;
  timeoutMs: number;
  overallTimeoutMs: number;
  maxBodyBytes: number;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DiscoveryOptions {
  fetchFn?: FetchLike;
  limits?: Partial<DiscoveryLimits>;
  now?: () => number;
  signal?: AbortSignal;
}

export const DEFAULT_DISCOVERY_LIMITS: Readonly<DiscoveryLimits> = {
  maxDepth: 3,
  maxResources: 20,
  timeoutMs: 8_000,
  overallTimeoutMs: 30_000,
  maxBodyBytes: 1_000_000,
};

const HTML_REFERENCES = [
  ["iframe[src]", "src"],
  ["script[src]", "src"],
  ["video[src]", "src"],
  ["source[src]", "src"],
] as const;

const FORBIDDEN_MEDIA_EXTENSION =
  /\.(?:aac|bin|key|lic|m4a|m4s|mp3|mp4|srt|ts|vtt|webm)$/i;
const FORBIDDEN_MEDIA_PATH = /(?:^|\/)(?:keys?|licenses?)(?:\/|$)/i;
const MANIFEST_CONTENT_TYPE =
  /(?:application\/(?:dash\+xml|mpegurl|vnd\.apple\.mpegurl)|audio\/(?:mpegurl|x-mpegurl))/i;
const MAX_REDIRECTS = 5;

interface PendingResource {
  depth: number;
  url: URL;
}

interface FetchedResource {
  finalUrl: URL;
  release: () => void;
  response: Response;
}

export class DiscoveryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

export async function discoverManifest(
  pageUrl: string,
  options: DiscoveryOptions = {},
): Promise<string> {
  const initialUrl = parseHttpUrl(pageUrl);
  if (initialUrl === undefined) {
    throw new DiscoveryError("Page URL must use HTTP or HTTPS.");
  }
  if (isForbiddenResource(initialUrl)) {
    throw new DiscoveryError("Page URL is not a supported discovery resource.");
  }

  const limits = { ...DEFAULT_DISCOVERY_LIMITS, ...options.limits };
  validateLimits(limits);

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const isAborted = (): boolean => options.signal?.aborted === true;
  const startedAt = now();
  const deadline = startedAt + limits.overallTimeoutMs;
  const queue: PendingResource[] = [{ depth: 0, url: initialUrl }];
  const queued = new Set<string>([normalizeUrl(initialUrl).href]);
  const visited = new Set<string>();
  let resourcesFetched = 0;

  const enqueue = (url: URL, depth: number): void => {
    const normalized = normalizeUrl(url);
    if (
      depth > limits.maxDepth ||
      isForbiddenResource(normalized) ||
      queued.has(normalized.href)
    ) {
      return;
    }

    queued.add(normalized.href);
    queue.push({ depth, url: normalized });
  };

  while (
    queue.length > 0 &&
    resourcesFetched < limits.maxResources &&
    now() < deadline &&
    !isAborted()
  ) {
    const resource = queue.shift();
    if (resource === undefined) {
      break;
    }

    const normalizedUrl = normalizeUrl(resource.url);
    if (visited.has(normalizedUrl.href)) {
      continue;
    }
    visited.add(normalizedUrl.href);

    for (const nestedUrl of extractQueryUrls(normalizedUrl)) {
      enqueue(nestedUrl, resource.depth + 1);
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }

    resourcesFetched += 1;

    try {
      const fetchedResource = await fetchResource(
        normalizedUrl,
        Math.min(limits.timeoutMs, remainingMs),
        fetchFn,
        options.signal,
      );
      try {
        const { finalUrl, response } = fetchedResource;
        if (!response.ok || isForbiddenResource(finalUrl)) {
          await response.body?.cancel();
          continue;
        }

        visited.add(normalizeUrl(finalUrl).href);
        for (const nestedUrl of extractQueryUrls(finalUrl)) {
          enqueue(nestedUrl, resource.depth + 1);
        }
        const contentType = response.headers.get("content-type") ?? "";
        const body = await readLimitedBody(response, limits.maxBodyBytes);

        if (isVerifiedManifest(finalUrl, contentType, body)) {
          return finalUrl.href;
        }

        if (
          resource.depth >= limits.maxDepth ||
          !isStaticTextResource(contentType, body)
        ) {
          continue;
        }

        for (const discoveredUrl of extractStaticUrls(
          body,
          finalUrl,
          contentType,
        )) {
          enqueue(discoveredUrl, resource.depth + 1);
        }
      } finally {
        fetchedResource.release();
      }
    } catch {
      if (isAborted()) {
        break;
      }
    }
  }

  if (isAborted()) {
    throw new DiscoveryError("Discovery was interrupted.");
  }

  throw new DiscoveryError("No supported manifest was discovered.");
}

function validateLimits(limits: DiscoveryLimits): void {
  const values = Object.values(limits);
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new DiscoveryError("Discovery limits must be positive integers.");
  }
}

function parseHttpUrl(value: string, base?: URL): URL | undefined {
  try {
    const parsed = base === undefined ? new URL(value) : new URL(value, base);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeUrl(url: URL): URL {
  const normalized = new URL(url.href);
  normalized.hash = "";
  return normalized;
}

function isForbiddenResource(url: URL): boolean {
  return (
    FORBIDDEN_MEDIA_EXTENSION.test(url.pathname) ||
    FORBIDDEN_MEDIA_PATH.test(url.pathname)
  );
}

async function fetchResource(
  url: URL,
  timeoutMs: number,
  fetchFn: FetchLike,
  externalSignal?: AbortSignal,
): Promise<FetchedResource> {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  const timer = setTimeout(abort, Math.max(1, timeoutMs));
  externalSignal?.addEventListener("abort", abort, { once: true });
  const release = (): void => {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  };

  try {
    if (externalSignal?.aborted === true) {
      controller.abort();
    }

    let currentUrl = url;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const response = await fetchFn(currentUrl, {
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) {
        return { finalUrl: currentUrl, release, response };
      }

      const location = response.headers.get("location");
      const redirectUrl =
        location === null ? undefined : parseHttpUrl(location, currentUrl);
      if (
        redirectUrl === undefined ||
        isForbiddenResource(redirectUrl) ||
        redirectCount === MAX_REDIRECTS
      ) {
        await response.body?.cancel();
        throw new DiscoveryError("Resource redirect was not supported.");
      }
      await response.body?.cancel();
      currentUrl = normalizeUrl(redirectUrl);
    }

    throw new DiscoveryError("Resource redirect was not supported.");
  } catch (error) {
    release();
    throw error;
  }
}

async function readLimitedBody(
  response: Response,
  maxBodyBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.parseInt(declaredLength, 10) > maxBodyBytes
  ) {
    throw new DiscoveryError("Resource body exceeded the discovery limit.");
  }

  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytesRead = 0;

  let result = await reader.read();
  while (!result.done) {
    bytesRead += result.value.byteLength;
    if (bytesRead > maxBodyBytes) {
      await reader.cancel();
      throw new DiscoveryError("Resource body exceeded the discovery limit.");
    }
    body += decoder.decode(result.value, { stream: true });
    result = await reader.read();
  }

  body += decoder.decode();
  return body;
}

function isVerifiedManifest(
  url: URL,
  contentType: string,
  body: string,
): boolean {
  const pathname = url.pathname.toLowerCase();
  const normalizedBody = body.replace(/^\uFEFF/, "").trimStart();
  const hasHlsSignature = normalizedBody.startsWith("#EXTM3U");
  const hasDashSignature = /^(?:<\?xml[^>]*>\s*)?<MPD(?:\s|>)/u.test(
    normalizedBody,
  );
  const hlsHint =
    pathname.endsWith(".m3u8") ||
    /(?:mpegurl|vnd\.apple\.mpegurl)/i.test(contentType);
  const dashHint =
    pathname.endsWith(".mpd") || /application\/dash\+xml/i.test(contentType);

  if (hasHlsSignature) {
    return !dashHint || hlsHint;
  }
  if (hasDashSignature) {
    return !hlsHint || dashHint;
  }
  return false;
}

function isStaticTextResource(contentType: string, body: string): boolean {
  if (MANIFEST_CONTENT_TYPE.test(contentType)) {
    return true;
  }
  if (contentType === "") {
    return true;
  }
  if (/(?:html|javascript|json|text|xml)/i.test(contentType)) {
    return true;
  }
  return /^\s*</u.test(body);
}

function extractStaticUrls(
  body: string,
  baseUrl: URL,
  contentType: string,
): URL[] {
  const urls = new Map<string, URL>();
  const add = (rawValue: string): void => {
    const decodedValue = decodeStaticUrlValue(rawValue);
    const parsed = parseHttpUrl(decodedValue, baseUrl);
    if (parsed === undefined) {
      return;
    }
    const normalized = normalizeUrl(parsed);
    urls.set(normalized.href, normalized);
  };

  const $ = load(body);
  for (const [selector, attribute] of HTML_REFERENCES) {
    for (const element of $(selector).toArray()) {
      const value = $(element).attr(attribute);
      if (value !== undefined) {
        add(value);
      }
    }
  }

  for (const script of $("script:not([src])").toArray()) {
    extractScriptUrls($(script).text(), add);
  }
  if (
    /(?:javascript|json)/iu.test(contentType) ||
    /\.(?:js|json)$/iu.test(baseUrl.pathname)
  ) {
    extractScriptUrls(body, add);
  }

  for (const url of [...urls.values()]) {
    for (const nestedUrl of extractQueryUrls(url)) {
      urls.set(nestedUrl.href, nestedUrl);
    }
  }

  return [...urls.values()].sort(
    (left, right) => Number(isManifestPath(right)) - Number(isManifestPath(left)),
  );
}

function isManifestPath(url: URL): boolean {
  return /\.(?:m3u8|mpd)$/iu.test(url.pathname);
}

function extractScriptUrls(source: string, add: (value: string) => void): void {
  const assignmentPattern =
    /\b(?:file|manifestUrl|manifestURL|playbackUrl|playbackURL|source|src)\b\s*[:=]\s*["'`]([^"'`]+)["'`]/gu;
  const directManifestPattern =
    /["'`]([^"'`\s]+\.(?:m3u8|mpd)(?:\?[^"'`\s]*)?)["'`]/giu;

  for (const match of source.matchAll(assignmentPattern)) {
    const value = match[1];
    if (value !== undefined) {
      add(value);
    }
  }
  for (const match of source.matchAll(directManifestPattern)) {
    const value = match[1];
    if (value !== undefined) {
      add(value);
    }
  }
}

function decodeStaticUrlValue(value: string): string {
  return value
    .trim()
    .replaceAll("&amp;", "&")
    .replaceAll("\\/", "/")
    .replaceAll("\\u0026", "&")
    .replaceAll("\\x26", "&");
}

function extractQueryUrls(url: URL): URL[] {
  const urls = new Map<string, URL>();
  for (const value of url.searchParams.values()) {
    const directUrl = parseHttpUrl(value);
    if (directUrl !== undefined) {
      const normalized = normalizeUrl(directUrl);
      urls.set(normalized.href, normalized);
    }

    const decodedUrl = decodeBase64HttpUrl(value);
    if (decodedUrl !== undefined) {
      const normalized = normalizeUrl(decodedUrl);
      urls.set(normalized.href, normalized);
    }
  }
  return [...urls.values()];
}

function decodeBase64HttpUrl(value: string): URL | undefined {
  const compact = value.trim();
  if (
    compact.length < 8 ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(compact)
  ) {
    return undefined;
  }

  try {
    const normalized = compact.replaceAll("-", "+").replaceAll("_", "/");
    const paddingLength = (4 - (normalized.length % 4)) % 4;
    const decoded = Buffer.from(
      normalized + "=".repeat(paddingLength),
      "base64",
    ).toString("utf8");
    return parseHttpUrl(decoded.trim());
  } catch {
    return undefined;
  }
}
