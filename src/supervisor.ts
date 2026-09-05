import { setTimeout as delay } from "node:timers/promises";

import type { CattStatus, PlaybackState } from "./catt.js";

export interface CattController {
  cast(
    manifestUrl: string,
    device: string,
    signal?: AbortSignal,
  ): Promise<void>;
  status(device: string, signal?: AbortSignal): Promise<CattStatus>;
  volume(percent: number, device: string, signal?: AbortSignal): Promise<void>;
}

export interface SupervisorConfig {
  pageUrl: string;
  fallbackPageUrls?: readonly string[];
  device: string;
  volume?: number;
  monitorSeconds: number;
  pollSeconds: number;
  recoverAttempts: number;
  signal?: AbortSignal;
}

export type SupervisorEvent =
  | { type: "casting"; source: CastSourceName }
  | { type: "complete" }
  | { type: "discovering"; source: CastSourceName }
  | { type: "interrupted" }
  | { type: "recovering"; attempt: number; maximum?: number }
  | { type: "state"; state: PlaybackState };

export type CastSourceName = "fallback" | "primary";

export type DiscoverManifest = (
  pageUrl: string,
  signal: AbortSignal,
) => Promise<string>;
export type Sleep = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export interface SupervisorDependencies {
  catt: CattController;
  discover: DiscoverManifest;
  emit?: (event: SupervisorEvent) => void;
  now?: () => number;
  sleep?: Sleep;
}

const INITIAL_PLAYBACK_TIMEOUT_SECONDS = 30;
const STARTUP_INACTIVE_OBSERVATIONS_BEFORE_SOURCE_FAIL = 2;
const STARTUP_BUFFERING_OBSERVATIONS_BEFORE_SOURCE_FAIL = 2;
const INACTIVE_OBSERVATIONS_BEFORE_RECOVERY = 3;
const BUFFERING_OBSERVATIONS_BEFORE_RECOVERY = 3;

interface CastSource {
  name: CastSourceName;
  pageUrl: string;
}

export class SupervisorError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SupervisorError";
  }
}

export async function superviseCast(
  config: SupervisorConfig,
  dependencies: SupervisorDependencies,
): Promise<void> {
  const signal = config.signal ?? new AbortController().signal;
  const emit = dependencies.emit ?? (() => undefined);
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const pollMilliseconds = config.pollSeconds * 1_000;
  const isAborted = (): boolean => signal.aborted;
  let lastReportedState: PlaybackState | undefined;

  const reportState = (state: PlaybackState): void => {
    if (state !== lastReportedState) {
      lastReportedState = state;
      emit({ state, type: "state" });
    }
  };

  const observeState = async (): Promise<PlaybackState> => {
    try {
      const status = await dependencies.catt.status(config.device, signal);
      return effectivePlaybackState(status);
    } catch {
      return "UNKNOWN";
    }
  };

  const pause = async (milliseconds: number): Promise<boolean> => {
    if (isAborted()) {
      return false;
    }
    try {
      await sleep(milliseconds, signal);
      return !isAborted();
    } catch {
      if (isAborted()) {
        return false;
      }
      throw new SupervisorError("Playback monitoring failed.");
    }
  };

  const waitForPlaying = async (failFastInactiveStartup: boolean): Promise<boolean> => {
    const maximumObservations = Math.max(
      1,
      Math.ceil(INITIAL_PLAYBACK_TIMEOUT_SECONDS / config.pollSeconds),
    );
    let startupBufferingObservations = 0;
    let startupInactiveObservations = 0;

    for (let observation = 0; observation < maximumObservations; observation += 1) {
      if (signal.aborted) {
        return false;
      }
      const state = await observeState();
      reportState(state);
      if (state === "PLAYING") {
        return true;
      }
      if (failFastInactiveStartup && (state === "IDLE" || state === "UNKNOWN")) {
        startupInactiveObservations += 1;
        if (
          startupInactiveObservations >=
          STARTUP_INACTIVE_OBSERVATIONS_BEFORE_SOURCE_FAIL
        ) {
          throw new SupervisorError("Playback did not start.");
        }
      } else {
        startupInactiveObservations = 0;
      }
      if (failFastInactiveStartup && state === "BUFFERING") {
        startupBufferingObservations += 1;
        if (
          startupBufferingObservations >=
          STARTUP_BUFFERING_OBSERVATIONS_BEFORE_SOURCE_FAIL
        ) {
          throw new SupervisorError("Playback did not start.");
        }
      } else {
        startupBufferingObservations = 0;
      }
      if (
        observation < maximumObservations - 1 &&
        !(await pause(pollMilliseconds))
      ) {
        return false;
      }
    }

    throw new SupervisorError("Playback did not start.");
  };

  let recoveries = 0;
  const recoveriesExhausted = (): boolean =>
    config.recoverAttempts > 0 && recoveries >= config.recoverAttempts;

  const castFreshManifest = async (
    source: CastSource,
    failFastInactiveStartup: boolean,
  ): Promise<boolean> => {
    emit({ source: source.name, type: "discovering" });
    try {
      const manifestUrl = await dependencies.discover(source.pageUrl, signal);
      if (isAborted()) {
        return false;
      }

      emit({ source: source.name, type: "casting" });
      await dependencies.catt.cast(manifestUrl, config.device, signal);
      if (isAborted()) {
        return false;
      }
      if (config.volume !== undefined) {
        await dependencies.catt.volume(config.volume, config.device, signal);
      }
      if (isAborted()) {
        return false;
      }
      return await waitForPlaying(failFastInactiveStartup);
    } catch {
      if (signal.aborted) {
        return false;
      }
      return false;
    }

  };

  const castFreshManifestFromAnySource = async (): Promise<boolean> => {
    const sources: CastSource[] = [
      { name: "primary", pageUrl: config.pageUrl },
      ...(config.fallbackPageUrls ?? []).map((pageUrl) => ({
        name: "fallback" as const,
        pageUrl,
      })),
    ];

    for (const source of sources) {
      if (await castFreshManifest(source, sources.length > 1)) {
        return true;
      }
      if (signal.aborted) {
        return false;
      }
    }

    throw new SupervisorError("Playback did not start.");
  };

  const castWithRecovery = async (recovery: boolean): Promise<boolean> => {
    let isRecoveryAttempt = recovery;

    while (!signal.aborted) {
      if (isRecoveryAttempt) {
        if (recoveriesExhausted()) {
          throw new SupervisorError("Playback became inactive.");
        }
        recoveries += 1;
        emit({
          attempt: recoveries,
          ...(config.recoverAttempts === 0
            ? {}
            : { maximum: config.recoverAttempts }),
          type: "recovering",
        });
      }

      try {
        return await castFreshManifestFromAnySource();
      } catch {
        if (isAborted()) {
          return false;
        }
      }

      isRecoveryAttempt = true;
      if (!(await pause(pollMilliseconds))) {
        return false;
      }
    }

    return false;
  };

  if (!(await castWithRecovery(false))) {
    emit({ type: "interrupted" });
    return;
  }

  const deadline =
    config.monitorSeconds === 0
      ? Number.POSITIVE_INFINITY
      : now() + config.monitorSeconds * 1_000;
  let bufferingObservations = 0;
  let inactiveObservations = 0;

  while (now() < deadline && !signal.aborted) {
    const state = await observeState();
    reportState(state);

    if (state === "IDLE" || state === "UNKNOWN") {
      inactiveObservations += 1;
    } else {
      inactiveObservations = 0;
    }
    if (state === "BUFFERING") {
      bufferingObservations += 1;
    } else {
      bufferingObservations = 0;
    }

    if (
      inactiveObservations >= INACTIVE_OBSERVATIONS_BEFORE_RECOVERY ||
      bufferingObservations >= BUFFERING_OBSERVATIONS_BEFORE_RECOVERY
    ) {
      bufferingObservations = 0;
      inactiveObservations = 0;
      if (!(await castWithRecovery(true))) {
        emit({ type: "interrupted" });
        return;
      }
      continue;
    }

    const remainingMilliseconds = deadline - now();
    if (
      remainingMilliseconds > 0 &&
      !(await pause(Math.min(pollMilliseconds, remainingMilliseconds)))
    ) {
      emit({ type: "interrupted" });
      return;
    }
  }

  if (signal.aborted) {
    emit({ type: "interrupted" });
    return;
  }
  emit({ type: "complete" });
}

async function defaultSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  }
}

function effectivePlaybackState(status: CattStatus): PlaybackState {
  if (
    status.state === "PLAYING" &&
    (status.hasContent === false ||
      (status.receiverApp !== undefined &&
        status.receiverApp !== "Default Media Receiver"))
  ) {
    return "UNKNOWN";
  }
  return status.state;
}
