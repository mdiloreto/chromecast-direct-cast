import { describe, expect, it } from "vitest";

import {
  CattClient,
  CattError,
  parseCattStatus,
  redactUrls,
  type ProcessRunner,
} from "../src/catt.js";

describe("parseCattStatus", () => {
  it("returns only whitelisted status fields", () => {
    const output = [
      "State: PLAYING",
      "Volume: 0.75",
      "Volume muted: False",
      "Content ID: https://example.invalid/media/stream.m3u8",
      "Media title: Synthetic title",
    ].join("\n");

    expect(parseCattStatus(output)).toEqual({
      muted: false,
      state: "PLAYING",
      volume: 0.75,
    });
  });

  it("maps unrecognized states to UNKNOWN", () => {
    expect(parseCattStatus("State: SURPRISE")).toEqual({ state: "UNKNOWN" });
  });
});

describe("CattClient", () => {
  it("uses exact safe uvx argv with hostile device text as one argument", async () => {
    const invocations: {
      args: readonly string[];
      command: string;
      input?: string;
    }[] = [];
    const runner: ProcessRunner = (command, args, options) => {
      invocations.push({
        args,
        command,
        ...(options?.input === undefined ? {} : { input: options.input }),
      });
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
    };
    const client = new CattClient(runner);
    const device = "receiver; touch should-not-run";

    await client.cast("https://example.invalid/media/stream.m3u8", device);

    expect(invocations).toEqual([
      {
        args: [
          "--from",
          "catt==0.13.1",
          "catt",
          "-d",
          device,
          "cast",
          "-",
        ],
        command: "uvx",
        input: "https://example.invalid/media/stream.m3u8",
      },
    ]);
  });

  it("does not expose captured output when catt fails", async () => {
    const runner: ProcessRunner = () =>
      Promise.resolve({
        exitCode: 7,
        stderr: "failure at https://example.invalid/private/path",
        stdout: "unexpected output",
      });
    const client = new CattClient(runner);

    await expect(client.status("synthetic receiver")).rejects.toEqual(
      new CattError("catt status failed with exit code 7."),
    );
  });
});

describe("redactUrls", () => {
  it("removes HTTP URLs", () => {
    const redacted = redactUrls(
      "request failed at https://example.invalid/private/path?q=value",
    );

    expect(redacted).not.toContain("example.invalid");
    expect(redacted).toContain("[redacted-url]");
  });
});
