import { describe, expect, it } from "vitest";

import {
  CattClient,
  CattError,
  parseCattScan,
  parseCattStatus,
  redactUrls,
  type ProcessRunner,
} from "../src/catt.js";

describe("parseCattScan", () => {
  it("extracts Chromecast devices from catt scan output", () => {
    const output = [
      "Scanning Chromecasts...",
      "192.168.1.54 - PiezaTV - Google Inc. Chromecast",
      "fe80::1234 - Desk TV - Google Inc. Chromecast",
    ].join("\n");

    expect(parseCattScan(output)).toEqual([
      {
        host: "192.168.1.54",
        manufacturer: "Google Inc. Chromecast",
        name: "PiezaTV",
      },
      {
        host: "fe80::1234",
        manufacturer: "Google Inc. Chromecast",
        name: "Desk TV",
      },
    ]);
  });
});

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

  it("captures safe receiver health fields from catt info", () => {
    const output = [
      "player_state: PLAYING",
      "content_id: https://example.invalid/media/stream.m3u8?token=secret",
      "display_name: Default Media Receiver",
      "volume_level: 0.75",
      "volume_muted: False",
    ].join("\n");

    expect(parseCattStatus(output)).toEqual({
      hasContent: true,
      muted: false,
      receiverApp: "Default Media Receiver",
      state: "PLAYING",
      volume: 0.75,
    });
  });

  it("detects playback without media content", () => {
    const output = [
      "player_state: PLAYING",
      "content_id: None",
      "display_name: Chrome Mirroring",
    ].join("\n");

    expect(parseCattStatus(output)).toEqual({
      hasContent: false,
      receiverApp: "Chrome Mirroring",
      state: "PLAYING",
    });
  });
});

describe("CattClient", () => {
  it("scans for devices", async () => {
    const invocations: { args: readonly string[]; command: string }[] = [];
    const runner: ProcessRunner = (command, args) => {
      invocations.push({ args, command });
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: "192.168.1.54 - PiezaTV - Google Inc. Chromecast\n",
      });
    };
    const client = new CattClient(runner);

    await expect(client.scan()).resolves.toEqual([
      {
        host: "192.168.1.54",
        manufacturer: "Google Inc. Chromecast",
        name: "PiezaTV",
      },
    ]);
    expect(invocations).toEqual([
      {
        args: ["--from", "catt==0.13.1", "catt", "scan"],
        command: "uvx",
      },
    ]);
  });

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
          "--stream-type",
          "live",
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

  it("removes standalone credential query fields", () => {
    const redacted = redactUrls("token=private&quality=high");

    expect(redacted).toBe("credential=[redacted]&quality=high");
  });
});
