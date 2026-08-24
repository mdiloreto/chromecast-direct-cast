import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

export type PlaybackState =
  | "BUFFERING"
  | "IDLE"
  | "PAUSED"
  | "PLAYING"
  | "UNKNOWN";

export interface CattStatus {
  state: PlaybackState;
  volume?: number;
  muted?: boolean;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessOptions,
) => Promise<ProcessResult>;

const MAX_CAPTURED_OUTPUT = 64 * 1024;
const CATT_PREFIX = ["--from", "catt==0.13.1", "catt"] as const;
const CATT_TIMEOUT_MS = 30_000;
const CAST_TIMEOUT_MS = 60_000;

export class CattError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CattError";
  }
}

export class CattClient {
  public constructor(private readonly runner: ProcessRunner = spawnRunner) {}

  public async cast(
    manifestUrl: string,
    device: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.run("cast", [...deviceArgs(device), "cast", "-"], {
      input: manifestUrl,
      timeoutMs: CAST_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async status(
    device: string,
    signal?: AbortSignal,
  ): Promise<CattStatus> {
    const result = await this.run("status", [...deviceArgs(device), "status"], {
      ...(signal === undefined ? {} : { signal }),
    });
    return parseCattStatus(result.stdout);
  }

  public async stop(device: string, signal?: AbortSignal): Promise<void> {
    await this.run("stop", [...deviceArgs(device), "stop"], {
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async volume(
    percent: number,
    device: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.run("volume", [
      ...deviceArgs(device),
      "volume",
      String(percent),
    ], {
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private async run(
    operation: "cast" | "status" | "stop" | "volume",
    args: readonly string[],
    options: ProcessOptions = {},
  ): Promise<ProcessResult> {
    let result: ProcessResult;
    try {
      result = await this.runner("uvx", [...CATT_PREFIX, ...args], {
        timeoutMs: CATT_TIMEOUT_MS,
        ...options,
      });
    } catch {
      throw new CattError(`Unable to run catt ${operation}.`);
    }

    if (result.exitCode !== 0) {
      throw new CattError(
        `catt ${operation} failed with exit code ${String(result.exitCode)}.`,
      );
    }
    return result;
  }
}

export function parseCattStatus(output: string): CattStatus {
  let state: PlaybackState = "UNKNOWN";
  let volume: number | undefined;
  let muted: boolean | undefined;

  for (const line of output.split(/\r?\n/u)) {
    const stateMatch =
      /^\s*(?:player\s+)?state\s*:\s*([A-Za-z]+)\s*$/iu.exec(line);
    if (stateMatch?.[1] !== undefined) {
      state = parsePlaybackState(stateMatch[1]);
      continue;
    }

    const volumeMatch = /^\s*volume\s*:\s*(\d+(?:\.\d+)?)\s*$/iu.exec(
      line,
    );
    if (volumeMatch?.[1] !== undefined) {
      const parsedVolume = Number(volumeMatch[1]);
      if (Number.isFinite(parsedVolume) && parsedVolume >= 0) {
        volume = parsedVolume;
      }
      continue;
    }

    const mutedMatch =
      /^\s*(?:volume\s+)?muted\s*:\s*(true|false)\s*$/iu.exec(line);
    if (mutedMatch?.[1] !== undefined) {
      muted = mutedMatch[1].toLowerCase() === "true";
    }
  }

  return {
    state,
    ...(volume === undefined ? {} : { volume }),
    ...(muted === undefined ? {} : { muted }),
  };
}

export function redactUrls(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
    .replace(
      /\b(?:authorization|key|sig|signature|token)=([^\s&]+)/giu,
      "credential=[redacted]",
    );
}

function deviceArgs(device: string): readonly string[] {
  return ["-d", device];
}

function parsePlaybackState(value: string): PlaybackState {
  switch (value.toUpperCase()) {
    case "BUFFERING":
      return "BUFFERING";
    case "IDLE":
      return "IDLE";
    case "PAUSED":
      return "PAUSED";
    case "PLAYING":
      return "PLAYING";
    default:
      return "UNKNOWN";
  }
}

async function spawnRunner(
  command: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const child = spawn(command, [...args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const processState = { timedOut: false };
  const terminate = (): void => {
    child.kill("SIGTERM");
  };
  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          processState.timedOut = true;
          terminate();
        }, options.timeoutMs);
  options.signal?.addEventListener("abort", terminate, { once: true });
  child.stdin.end(options.input);

  const stdoutPromise = collectOutput(child.stdout);
  const stderrPromise = collectOutput(child.stderr);
  const exitCodePromise = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      resolve(code ?? 1);
    });
  });

  let result: [string, string, number];
  try {
    result = await Promise.all([
      stdoutPromise,
      stderrPromise,
      exitCodePromise,
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    options.signal?.removeEventListener("abort", terminate);
  }
  if (processState.timedOut) {
    throw new Error("Process timed out.");
  }
  if (options.signal?.aborted === true) {
    throw new Error("Process was interrupted.");
  }
  const [stdout, stderr, exitCode] = result;
  return { exitCode, stderr, stdout };
}

function collectOutput(stream: Readable): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: unknown) => {
      if (typeof chunk === "string" && output.length < MAX_CAPTURED_OUTPUT) {
        output += chunk.slice(0, MAX_CAPTURED_OUTPUT - output.length);
      }
    });
    stream.once("end", () => {
      resolve(output);
    });
    stream.once("error", () => {
      resolve(output);
    });
  });
}
