#!/usr/bin/env node

import { setDefaultResultOrder } from "node:dns";
import { pathToFileURL } from "node:url";

import { Command, InvalidArgumentError, Option } from "commander";

import { CattClient, CattError, redactUrls } from "./catt.js";
import { discoverManifest, DiscoveryError } from "./discovery.js";
import {
  superviseCast,
  SupervisorError,
  type SupervisorEvent,
} from "./supervisor.js";
import { startUiServer, UiServerError } from "./ui.js";

interface CastCommandOptions {
  device: string;
  fallback: string[];
  monitor: number;
  poll: number;
  recover: number;
  volume?: number;
}

interface DeviceCommandOptions {
  device: string;
}

interface UiCommandOptions {
  fallback: string[];
  host: string;
  poll: number;
  port: number;
  primary?: string;
}

const VERSION = "0.1.0";

setDefaultResultOrder("ipv4first");

export function createProgram(
  signal: AbortSignal,
  catt = new CattClient(),
): Command {
  const program = new Command();
  program
    .name("chromecast-direct-cast")
    .description("Discover an authorized stream and cast it directly.")
    .version(VERSION);

  program
    .command("ui")
    .description("start a loopback-only web UI")
    .option(
      "--host <host>",
      "loopback host to bind (127.0.0.1 or ::1)",
      parseUiHost,
      "127.0.0.1",
    )
    .option("--port <port>", "port to bind", parsePort, 8787)
    .option("--primary <page-url>", "default primary page URL")
    .option(
      "--fallback <page-url>",
      "default fallback page URL (repeatable)",
      collectValue,
      [],
    )
    .option("--poll <seconds>", "status polling interval", parsePositiveInteger, 5)
    .action(async (options: UiCommandOptions) => {
      const server = await startUiServer({
        ...(options.fallback.length === 0
          ? {}
          : { defaultFallbackUrls: options.fallback }),
        ...(options.primary === undefined
          ? {}
          : { defaultPageUrl: options.primary }),
        host: options.host,
        pollSeconds: options.poll,
        port: options.port,
        signal,
      });
      await server.closed;
    });

  program
    .command("cast")
    .description("Discover and cast an authorized stream")
    .argument("<page-url>", "HTTP(S) page to inspect")
    .addOption(deviceOption())
    .option(
      "--fallback <page-url>",
      "fallback page to inspect if earlier sources fail (repeatable)",
      collectValue,
      [],
    )
    .option("--volume <percent>", "set volume after casting", parseVolume)
    .option(
      "--monitor <seconds>",
      "monitoring duration; 0 runs until interrupted",
      parseNonNegativeInteger,
      300,
    )
    .option("--poll <seconds>", "status polling interval", parsePositiveInteger, 10)
    .option(
      "--recover <attempts>",
      "maximum recovery attempts; 0 retries forever",
      parseNonNegativeInteger,
      2,
    )
    .action(async (pageUrl: string, options: CastCommandOptions) => {
      await superviseCast(
        {
          device: options.device,
          ...(options.fallback.length === 0
            ? {}
            : { fallbackPageUrls: options.fallback }),
          monitorSeconds: options.monitor,
          pageUrl,
          pollSeconds: options.poll,
          recoverAttempts: options.recover,
          signal,
          ...(options.volume === undefined ? {} : { volume: options.volume }),
        },
        {
          catt,
          discover: (url, discoverySignal) =>
            discoverManifest(url, { signal: discoverySignal }),
          emit: printSupervisorEvent,
        },
      );
    });

  program
    .command("status")
    .description("show safe playback status fields")
    .addOption(deviceOption())
    .action(async (options: DeviceCommandOptions) => {
      const status = await catt.status(options.device, signal);
      process.stdout.write(`State: ${status.state}\n`);
      if (status.volume !== undefined) {
        process.stdout.write(`Volume: ${String(status.volume)}\n`);
      }
      if (status.muted !== undefined) {
        process.stdout.write(`Muted: ${status.muted ? "yes" : "no"}\n`);
      }
    });

  program
    .command("stop")
    .description("stop playback")
    .addOption(deviceOption())
    .action(async (options: DeviceCommandOptions) => {
      await catt.stop(options.device, signal);
      process.stdout.write("Playback stopped.\n");
    });

  program
    .command("volume")
    .description("set playback volume")
    .argument("<percent>", "volume from 0 to 100", parseVolume)
    .addOption(deviceOption())
    .action(async (percent: number, options: DeviceCommandOptions) => {
      await catt.volume(percent, options.device, signal);
      process.stdout.write("Volume updated.\n");
    });

  return program;
}

function deviceOption(): Option {
  return new Option("-d, --device <name>", "Chromecast device name")
    .env("CHROMECAST_DEVICE")
    .makeOptionMandatory();
}

function parseVolume(value: string): number {
  const volume = parseNonNegativeInteger(value);
  if (volume > 100) {
    throw new InvalidArgumentError("Volume must be between 0 and 100.");
  }
  return volume;
}

function collectValue(value: string, values: string[]): string[] {
  return [...values, value];
}

function parsePositiveInteger(value: string): number {
  const parsed = parseNonNegativeInteger(value);
  if (parsed === 0) {
    throw new InvalidArgumentError("Value must be a positive integer.");
  }
  return parsed;
}

function parsePort(value: string): number {
  const parsed = parsePositiveInteger(value);
  if (parsed > 65_535) {
    throw new InvalidArgumentError("Port must be between 1 and 65535.");
  }
  return parsed;
}

function parseUiHost(value: string): string {
  if (value !== "127.0.0.1" && value !== "::1") {
    throw new InvalidArgumentError("Host must be 127.0.0.1 or ::1.");
  }
  return value;
}

function parseNonNegativeInteger(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError("Value must be a non-negative integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("Value is outside the supported range.");
  }
  return parsed;
}

function printSupervisorEvent(event: SupervisorEvent): void {
  switch (event.type) {
    case "casting":
      process.stdout.write(`Casting ${event.source}.\n`);
      break;
    case "complete":
      process.stdout.write("Monitoring complete.\n");
      break;
    case "discovering":
      process.stdout.write(`Discovering ${event.source} stream.\n`);
      break;
    case "interrupted":
      process.stdout.write("Interrupted; playback left running.\n");
      break;
    case "recovering":
      process.stdout.write(
        event.maximum === undefined
          ? `Recovering playback (attempt ${String(event.attempt)}; unlimited).\n`
          : `Recovering playback (${String(event.attempt)}/${String(event.maximum)}).\n`,
      );
      break;
    case "state":
      process.stdout.write(`State: ${event.state}\n`);
      break;
  }
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

async function main(): Promise<void> {
  const controller = new AbortController();
  const interrupt = (): void => {
    controller.abort();
  };
  process.once("SIGINT", interrupt);

  try {
    await createProgram(controller.signal).parseAsync(process.argv);
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Error: ${publicErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
