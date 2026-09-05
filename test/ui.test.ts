import { Script } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CattStatus, ChromecastDevice } from "../src/catt.js";
import { SupervisorError, type SupervisorConfig } from "../src/supervisor.js";
import {
  startUiServer,
  UiServerError,
  type UiCattController,
  type UiServerDependencies,
  type UiServerHandle,
  type UiSupervisor,
} from "../src/ui.js";

class SyntheticUiCatt implements UiCattController {
  public readonly stops: string[] = [];

  public constructor(
    private readonly devices: ChromecastDevice[] = [
      {
        host: "192.0.2.10",
        manufacturer: "Synthetic Manufacturer",
        name: "Synthetic Receiver",
      },
    ],
  ) {}

  public cast(): Promise<void> {
    return Promise.resolve();
  }

  public scan(): Promise<ChromecastDevice[]> {
    return Promise.resolve(this.devices);
  }

  public status(): Promise<CattStatus> {
    return Promise.resolve({ state: "PLAYING" });
  }

  public stop(device: string): Promise<void> {
    this.stops.push(device);
    return Promise.resolve();
  }

  public volume(): Promise<void> {
    return Promise.resolve();
  }
}

const handles: UiServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("local web UI", () => {
  it("renders valid browser JavaScript and lists discovered devices", async () => {
    const handle = await startTestServer({ catt: new SyntheticUiCatt() });

    const pageResponse = await fetch(handle.origin);
    const page = await pageResponse.text();
    const scriptMatch = /<script nonce="([^"]+)">([\s\S]*?)<\/script>/u.exec(page);
    const nonce = scriptMatch?.[1];
    const script = scriptMatch?.[2];
    if (nonce === undefined || script === undefined) {
      throw new Error("Rendered browser script was not found.");
    }

    expect(pageResponse.status).toBe(200);
    expect(pageResponse.headers.get("cache-control")).toBe("no-store");
    expect(pageResponse.headers.get("content-security-policy")).toContain(
      `script-src 'nonce-${nonce}'`,
    );
    expect(() => new Script(script)).not.toThrow();
    expect(script).toContain("body.events.join('\\n')");
    expect(script).toContain(
      "manualDevice.value.trim() || device.value",
    );
    expect(script).not.toContain("manualDevice.value = body.devices");

    const devicesResponse = await fetch(`${handle.origin}/api/devices`);
    await expect(readJsonObject(devicesResponse)).resolves.toEqual({
      devices: [
        {
          host: "192.0.2.10",
          manufacturer: "Synthetic Manufacturer",
          name: "Synthetic Receiver",
        },
      ],
    });
  });

  it("runs one manual-device job and stops its monitor and playback", async () => {
    const catt = new SyntheticUiCatt();
    const run = deferred();
    const supervisorConfigs: SupervisorConfig[] = [];
    const supervise: UiSupervisor = (config) => {
      supervisorConfigs.push(config);
      return run.promise;
    };
    const handle = await startTestServer({ catt, supervise });
    const requestBody = {
      device: "203.0.113.20",
      fallbackPageUrls: [
        "https://fallback-one.example.invalid/player?access=private-fallback-one",
        "https://fallback-two.example.invalid/player?access=private-fallback-two",
      ],
      pageUrl: "https://primary.example.invalid/player?access=private-primary",
    };

    const startResponse = await postJson(
      handle.origin,
      "/api/start",
      requestBody,
    );
    const startText = await startResponse.text();
    const startBody = parseJsonObject(startText);

    expect(startResponse.status).toBe(202);
    expect(startBody.status).toBe("running");
    expect(startText).not.toContain("private-primary");
    expect(startText).not.toContain("private-fallback-one");
    expect(startText).not.toContain("private-fallback-two");
    expect(supervisorConfigs).toHaveLength(1);
    const supervisorConfig = supervisorConfigs[0];
    if (supervisorConfig === undefined) {
      throw new Error("Supervisor was not started.");
    }
    expect(supervisorConfig).toMatchObject({
      device: "203.0.113.20",
      fallbackPageUrls: requestBody.fallbackPageUrls,
      monitorSeconds: 0,
      pageUrl: requestBody.pageUrl,
      recoverAttempts: 0,
    });
    expect(supervisorConfig.signal?.aborted).toBe(false);

    const conflictResponse = await postJson(
      handle.origin,
      "/api/start",
      requestBody,
    );
    expect(conflictResponse.status).toBe(409);
    expect(supervisorConfigs).toHaveLength(1);

    const jobResponse = await fetch(`${handle.origin}/api/job`);
    const jobText = await jobResponse.text();
    expect(jobText).not.toContain("primary.example.invalid");
    expect(jobText).not.toContain("fallback-one.example.invalid");
    expect(jobText).not.toContain("fallback-two.example.invalid");

    const stopResponse = await postJson(handle.origin, "/api/stop", {});
    await expect(readJsonObject(stopResponse)).resolves.toMatchObject({
      status: "idle",
    });
    expect(catt.stops).toEqual(["203.0.113.20"]);
    expect(supervisorConfig.signal?.aborted).toBe(true);
    run.resolve();
  });

  it("validates JSON requests and rejects cross-origin writes", async () => {
    const supervisorConfigs: SupervisorConfig[] = [];
    const supervise: UiSupervisor = (config) => {
      supervisorConfigs.push(config);
      return Promise.resolve();
    };
    const handle = await startTestServer({
      catt: new SyntheticUiCatt(),
      supervise,
    });

    const wrongContentType = await fetch(`${handle.origin}/api/start`, {
      body: "{}",
      method: "POST",
    });
    expect(wrongContentType.status).toBe(415);

    const wrongOrigin = await fetch(`${handle.origin}/api/start`, {
      body: "{}",
      headers: {
        "content-type": "application/json",
        origin: "https://cross-origin.example.invalid",
      },
      method: "POST",
    });
    expect(wrongOrigin.status).toBe(403);

    const invalidBody = await postJson(handle.origin, "/api/start", {
      device: "Synthetic Receiver\nInjected",
      pageUrl: "file:///private/player",
      unexpected: true,
    });
    const invalidText = await invalidBody.text();
    expect(invalidBody.status).toBe(400);
    expect(invalidText).not.toContain("file:///private/player");
    expect(supervisorConfigs).toHaveLength(0);
  });

  it("redacts URLs from monitor failures", async () => {
    const supervise: UiSupervisor = () =>
      Promise.reject(
        new SupervisorError(
          "failed at https://media.example.invalid/live.m3u8?token=private",
        ),
      );
    const handle = await startTestServer({
      catt: new SyntheticUiCatt(),
      supervise,
    });

    const startResponse = await postJson(handle.origin, "/api/start", {
      device: "Synthetic Receiver",
      pageUrl: "https://page.example.invalid/player",
    });
    expect(startResponse.status).toBe(202);

    await vi.waitFor(async () => {
      const response = await fetch(`${handle.origin}/api/job`);
      const text = await response.text();
      expect(text).toContain("[redacted-url]");
      expect(text).not.toContain("media.example.invalid");
      expect(text).not.toContain("token=private");
    });
  });

  it("rejects non-loopback binding and closes on abort", async () => {
    await expect(
      startUiServer(
        {
          host: "0.0.0.0",
          pollSeconds: 1,
          port: 0,
        },
        { catt: new SyntheticUiCatt() },
      ),
    ).rejects.toEqual(new UiServerError("UI host must be 127.0.0.1 or ::1."));

    const controller = new AbortController();
    const handle = await startUiServer(
      {
        host: "127.0.0.1",
        pollSeconds: 1,
        port: 0,
        signal: controller.signal,
      },
      { catt: new SyntheticUiCatt() },
    );
    handles.push(handle);

    controller.abort();
    await expect(handle.closed).resolves.toBeUndefined();
  });
});

async function startTestServer(
  dependencies: UiServerDependencies,
): Promise<UiServerHandle> {
  const handle = await startUiServer(
    {
      host: "127.0.0.1",
      pollSeconds: 1,
      port: 0,
    },
    dependencies,
  );
  handles.push(handle);
  return handle;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function postJson(origin: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

async function readJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  return parseJsonObject(await response.text());
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
