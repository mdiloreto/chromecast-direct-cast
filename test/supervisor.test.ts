import { describe, expect, it } from "vitest";

import type { CattStatus, PlaybackState } from "../src/catt.js";
import {
  superviseCast,
  type CattController,
  type SupervisorEvent,
} from "../src/supervisor.js";

class SyntheticCatt implements CattController {
  public readonly casts: string[] = [];
  public readonly volumes: number[] = [];

  public constructor(
    private readonly statuses: (CattStatus | PlaybackState)[],
  ) {}

  public cast(manifestUrl: string): Promise<void> {
    this.casts.push(manifestUrl);
    return Promise.resolve();
  }

  public status(): Promise<CattStatus> {
    const status = this.statuses.shift() ?? "PLAYING";
    return Promise.resolve(
      typeof status === "string" ? { state: status } : status,
    );
  }

  public volume(percent: number): Promise<void> {
    this.volumes.push(percent);
    return Promise.resolve();
  }
}

describe("superviseCast", () => {
  it("rediscovers and recasts after consecutive inactive observations", async () => {
    const catt = new SyntheticCatt([
      "BUFFERING",
      "PLAYING",
      "IDLE",
      "IDLE",
      "IDLE",
      "PLAYING",
    ]);
    const events: SupervisorEvent[] = [];
    let discoveries = 0;
    let now = 0;

    await superviseCast(
      {
        device: "synthetic receiver",
        monitorSeconds: 5,
        pageUrl: "https://example.invalid/watch",
        pollSeconds: 1,
        recoverAttempts: 1,
        volume: 35,
      },
      {
        catt,
        discover: () => {
          discoveries += 1;
          return Promise.resolve(
            `https://example.invalid/media/stream-${String(discoveries)}.m3u8`,
          );
        },
        emit: (event) => {
          events.push(event);
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      },
    );

    expect(discoveries).toBe(2);
    expect(catt.casts).toEqual([
      "https://example.invalid/media/stream-1.m3u8",
      "https://example.invalid/media/stream-2.m3u8",
    ]);
    expect(catt.volumes).toEqual([35, 35]);
    expect(events).toContainEqual({ attempt: 1, maximum: 1, type: "recovering" });
    expect(events.at(-1)).toEqual({ type: "complete" });
  });

  it("recovers after buffering remains stuck", async () => {
    const catt = new SyntheticCatt([
      "PLAYING",
      "BUFFERING",
      "BUFFERING",
      "BUFFERING",
      "PLAYING",
    ]);
    let discoveries = 0;
    let now = 0;

    await superviseCast(
      {
        device: "synthetic receiver",
        monitorSeconds: 7,
        pageUrl: "https://example.invalid/watch",
        pollSeconds: 1,
        recoverAttempts: 1,
      },
      {
        catt,
        discover: () => {
          discoveries += 1;
          return Promise.resolve(
            `https://example.invalid/media/stream-${String(discoveries)}.m3u8`,
          );
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      },
    );

    expect(discoveries).toBe(2);
    expect(catt.casts).toHaveLength(2);
  });

  it("tries the fallback after startup remains buffering", async () => {
    const catt = new SyntheticCatt(["BUFFERING", "BUFFERING", "PLAYING"]);
    const discoveries: string[] = [];
    let now = 0;

    await superviseCast(
      {
        device: "synthetic receiver",
        fallbackPageUrls: ["https://example.invalid/fallback"],
        monitorSeconds: 1,
        pageUrl: "https://example.invalid/primary",
        pollSeconds: 1,
        recoverAttempts: 1,
      },
      {
        catt,
        discover: (pageUrl) => {
          discoveries.push(pageUrl);
          return Promise.resolve(`${pageUrl}/stream.m3u8`);
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      },
    );

    expect(discoveries).toEqual([
      "https://example.invalid/primary",
      "https://example.invalid/fallback",
    ]);
  });

  it("tries the fallback page after repeated inactive startup states", async () => {
    const catt = new SyntheticCatt(["UNKNOWN", "IDLE", "PLAYING"]);
    const discoveries: string[] = [];
    let now = 0;

    await superviseCast(
      {
        device: "synthetic receiver",
        fallbackPageUrls: ["https://example.invalid/fallback"],
        monitorSeconds: 1,
        pageUrl: "https://example.invalid/primary",
        pollSeconds: 1,
        recoverAttempts: 1,
      },
      {
        catt,
        discover: (pageUrl) => {
          discoveries.push(pageUrl);
          return Promise.resolve(`${pageUrl}/stream.m3u8`);
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      },
    );

    expect(discoveries).toEqual([
      "https://example.invalid/primary",
      "https://example.invalid/fallback",
    ]);
    expect(catt.casts).toEqual([
      "https://example.invalid/primary/stream.m3u8",
      "https://example.invalid/fallback/stream.m3u8",
    ]);
  });

  it("tries multiple fallback pages in order", async () => {
    const catt = new SyntheticCatt(["PLAYING"]);
    const discoveries: string[] = [];
    let now = 0;

    await superviseCast(
      {
        device: "synthetic receiver",
        fallbackPageUrls: [
          "https://example.invalid/fallback-one",
          "https://example.invalid/fallback-two",
        ],
        monitorSeconds: 1,
        pageUrl: "https://example.invalid/primary",
        pollSeconds: 1,
        recoverAttempts: 1,
      },
      {
        catt,
        discover: (pageUrl) => {
          discoveries.push(pageUrl);
          if (!pageUrl.endsWith("fallback-two")) {
            return Promise.reject(new Error("source unavailable"));
          }
          return Promise.resolve(`${pageUrl}/stream.m3u8`);
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      },
    );

    expect(discoveries).toEqual([
      "https://example.invalid/primary",
      "https://example.invalid/fallback-one",
      "https://example.invalid/fallback-two",
    ]);
    expect(catt.casts).toEqual([
      "https://example.invalid/fallback-two/stream.m3u8",
    ]);
  });

  it("does not accept Chrome Mirroring as successful media playback", async () => {
    const catt = new SyntheticCatt([
      {
        hasContent: false,
        receiverApp: "Chrome Mirroring",
        state: "PLAYING",
      },
      {
        hasContent: false,
        receiverApp: "Chrome Mirroring",
        state: "PLAYING",
      },
      {
        hasContent: true,
        receiverApp: "Default Media Receiver",
        state: "PLAYING",
      },
    ]);
    const discoveries: string[] = [];
    let now = 0;

    await superviseCast(
      {
        device: "synthetic receiver",
        fallbackPageUrls: ["https://example.invalid/fallback"],
        monitorSeconds: 1,
        pageUrl: "https://example.invalid/primary",
        pollSeconds: 1,
        recoverAttempts: 1,
      },
      {
        catt,
        discover: (pageUrl) => {
          discoveries.push(pageUrl);
          return Promise.resolve(`${pageUrl}/stream.m3u8`);
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      },
    );

    expect(discoveries).toEqual([
      "https://example.invalid/primary",
      "https://example.invalid/fallback",
    ]);
  });

  it("rediscovers a fresh fallback manifest during recovery", async () => {
    const catt = new SyntheticCatt([
      "PLAYING",
      "IDLE",
      "IDLE",
      "IDLE",
      "PLAYING",
    ]);
    const discoveries: string[] = [];
    let fallbackDiscoveries = 0;
    let now = 0;

    await superviseCast(
      {
        device: "synthetic receiver",
        fallbackPageUrls: ["https://example.invalid/fallback"],
        monitorSeconds: 4,
        pageUrl: "https://example.invalid/primary",
        pollSeconds: 1,
        recoverAttempts: 1,
      },
      {
        catt,
        discover: (pageUrl) => {
          discoveries.push(pageUrl);
          if (pageUrl.endsWith("/primary")) {
            return Promise.reject(new Error("primary unavailable"));
          }
          fallbackDiscoveries += 1;
          return Promise.resolve(
            `https://example.invalid/media/fallback-${String(fallbackDiscoveries)}.m3u8`,
          );
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      },
    );

    expect(discoveries).toEqual([
      "https://example.invalid/primary",
      "https://example.invalid/fallback",
      "https://example.invalid/primary",
      "https://example.invalid/fallback",
    ]);
    expect(catt.casts).toEqual([
      "https://example.invalid/media/fallback-1.m3u8",
      "https://example.invalid/media/fallback-2.m3u8",
    ]);
  });

  it("treats zero recovery attempts as unlimited", async () => {
    const catt = new SyntheticCatt([
      "PLAYING",
      "IDLE",
      "IDLE",
      "IDLE",
      "PLAYING",
      "IDLE",
      "IDLE",
      "IDLE",
      "PLAYING",
    ]);
    const events: SupervisorEvent[] = [];
    let discoveries = 0;
    let now = 0;

    await superviseCast(
      {
        device: "synthetic receiver",
        monitorSeconds: 6,
        pageUrl: "https://example.invalid/watch",
        pollSeconds: 1,
        recoverAttempts: 0,
      },
      {
        catt,
        discover: () => {
          discoveries += 1;
          return Promise.resolve(
            `https://example.invalid/media/stream-${String(discoveries)}.m3u8`,
          );
        },
        emit: (event) => {
          events.push(event);
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      },
    );

    expect(discoveries).toBe(3);
    expect(catt.casts).toHaveLength(3);
    expect(events).toContainEqual({ attempt: 1, type: "recovering" });
  });

  it("keeps retrying when every source fails during startup", async () => {
    const catt = new SyntheticCatt(["PLAYING"]);
    const events: SupervisorEvent[] = [];
    let discoveries = 0;
    let now = 0;

    await superviseCast(
      {
        device: "synthetic receiver",
        fallbackPageUrls: ["https://example.invalid/fallback"],
        monitorSeconds: 1,
        pageUrl: "https://example.invalid/primary",
        pollSeconds: 1,
        recoverAttempts: 0,
      },
      {
        catt,
        discover: (pageUrl) => {
          discoveries += 1;
          if (discoveries <= 2) {
            return Promise.reject(new Error("source unavailable"));
          }
          return Promise.resolve(`${pageUrl}/stream.m3u8`);
        },
        emit: (event) => {
          events.push(event);
        },
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      },
    );

    expect(discoveries).toBe(3);
    expect(events).toContainEqual({ attempt: 1, type: "recovering" });
    expect(catt.casts).toEqual([
      "https://example.invalid/primary/stream.m3u8",
    ]);
  });
});
