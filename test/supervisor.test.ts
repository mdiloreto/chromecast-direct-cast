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

  public constructor(private readonly states: PlaybackState[]) {}

  public cast(manifestUrl: string): Promise<void> {
    this.casts.push(manifestUrl);
    return Promise.resolve();
  }

  public status(): Promise<CattStatus> {
    return Promise.resolve({ state: this.states.shift() ?? "PLAYING" });
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
});
