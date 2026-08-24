import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  discoverManifest,
  DiscoveryError,
  type FetchLike,
} from "../src/discovery.js";

interface SyntheticPage {
  body: string;
  contentType: string;
}

function syntheticFetch(
  pages: ReadonlyMap<string, SyntheticPage>,
  calls: string[],
): FetchLike {
  return (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("manual");

    const page = pages.get(url);
    if (page === undefined) {
      return Promise.resolve(new Response("missing", { status: 404 }));
    }
    return Promise.resolve(
      new Response(page.body, {
        headers: { "content-type": page.contentType },
        status: 200,
      }),
    );
  };
}

describe("discoverManifest", () => {
  it("decodes an arbitrary Base64 query wrapper and follows a nested player", async () => {
    const calls: string[] = [];
    const playerUrl = "https://example.invalid/player";
    const wrapperValue = Buffer.from(playerUrl, "utf8")
      .toString("base64url")
      .replace(/=+$/u, "");
    const wrapperUrl = `https://example.invalid/wrapper?x=${wrapperValue}`;
    const manifestUrl = "https://example.invalid/live/master.m3u8";
    const pages = new Map<string, SyntheticPage>([
      [
        wrapperUrl,
        { body: "<html><body>Wrapper</body></html>", contentType: "text/html" },
      ],
      [
        playerUrl,
        {
          body: `<script>const playbackURL = "${manifestUrl}";</script>`,
          contentType: "text/html",
        },
      ],
      [
        manifestUrl,
        {
          body: "#EXTM3U\n#EXT-X-VERSION:3\n",
          contentType: "application/vnd.apple.mpegurl",
        },
      ],
    ]);

    await expect(
      discoverManifest(wrapperUrl, { fetchFn: syntheticFetch(pages, calls) }),
    ).resolves.toBe(manifestUrl);
    expect(calls).toContain(playerUrl);
    expect(calls).toContain(manifestUrl);
  });

  it("follows iframe and source references to a direct manifest", async () => {
    const calls: string[] = [];
    const rootUrl = "https://example.invalid/start";
    const playerUrl = "https://example.invalid/embed/player";
    const manifestUrl = "https://example.invalid/media/stream.mpd";
    const pages = new Map<string, SyntheticPage>([
      [
        rootUrl,
        {
          body: '<iframe src="/embed/player"></iframe>',
          contentType: "text/html",
        },
      ],
      [
        playerUrl,
        {
          body: '<video><source src="/media/stream.mpd"></video>',
          contentType: "text/html",
        },
      ],
      [
        manifestUrl,
        {
          body: '<?xml version="1.0"?><MPD type="static"></MPD>',
          contentType: "application/dash+xml",
        },
      ],
    ]);

    await expect(
      discoverManifest(rootUrl, { fetchFn: syntheticFetch(pages, calls) }),
    ).resolves.toBe(manifestUrl);
  });

  it("prevents cycles and returns a stable no-manifest error", async () => {
    const calls: string[] = [];
    const firstUrl = "https://example.invalid/first";
    const secondUrl = "https://example.invalid/second";
    const pages = new Map<string, SyntheticPage>([
      [
        firstUrl,
        {
          body: '<iframe src="/second"></iframe>',
          contentType: "text/html",
        },
      ],
      [
        secondUrl,
        {
          body: '<iframe src="/first"></iframe>',
          contentType: "text/html",
        },
      ],
    ]);

    await expect(
      discoverManifest(firstUrl, { fetchFn: syntheticFetch(pages, calls) }),
    ).rejects.toEqual(
      new DiscoveryError("No supported manifest was discovered."),
    );
    expect(calls).toEqual([firstUrl, secondUrl]);
  });

  it("prioritizes a manifest over irrelevant markup URLs", async () => {
    const calls: string[] = [];
    const rootUrl = "https://example.invalid/noisy";
    const manifestUrl = "https://example.invalid/live/master.m3u8";
    const images = Array.from(
      { length: 25 },
      (_, index) => `<img src="/images/${String(index)}.png">`,
    ).join("");
    const pages = new Map<string, SyntheticPage>([
      [
        rootUrl,
        {
          body: `${images}<script>const playbackURL = "${manifestUrl}";</script>`,
          contentType: "text/html",
        },
      ],
      [
        manifestUrl,
        {
          body: "#EXTM3U\n#EXT-X-VERSION:3\n",
          contentType: "application/vnd.apple.mpegurl",
        },
      ],
    ]);

    await expect(
      discoverManifest(rootUrl, { fetchFn: syntheticFetch(pages, calls) }),
    ).resolves.toBe(manifestUrl);
    expect(calls).toEqual([rootUrl, manifestUrl]);
  });
});
