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
  device: string;
  volume?: number;
  monitorSeconds: number;
  pollSeconds: number;
  recoverAttempts: number;
  signal?: AbortSignal;
}

export type SupervisorEvent =
  | { type: "casting" }
  | { type: "complete" }
  | { type: "discovering" }
  | { type: "interrupted" }
  | { type: "recovering"; attempt: number; maximum: number }
  | { type: "state"; state: PlaybackState };

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

const INITIAL_PLAYBACK_TIMEOUT_SECONDS = 60;
const INACTIVE_OBSERVATIONS_BEFORE_RECOVERY = 3;
const BUFFERING_OBSERVATIONS_BEFORE_RECOVERY = 6;

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
      return status.state;
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

  const waitForPlaying = async (): Promise<boolean> => {
    const maximumObservations = Math.max(
      1,
      Math.ceil(INITIAL_PLAYBACK_TIMEOUT_SECONDS / config.pollSeconds),
    );

    for (let observation = 0; observation < maximumObservations; observation += 1) {
      if (signal.aborted) {
        return false;
      }
      const state = await observeState();
      reportState(state);
      if (state === "PLAYING") {
        return true;
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

  const castFreshManifest = async (): Promise<boolean> => {
    emit({ type: "discovering" });
    let manifestUrl: string;
    try {
      manifestUrl = await dependencies.discover(config.pageUrl, signal);
    } catch (error) {
      if (signal.aborted) {
        return false;
      }
      throw error;
    }
    if (isAborted()) {
      return false;
    }

    emit({ type: "casting" });
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
    return waitForPlaying();
  };

  if (!(await castFreshManifest())) {
    emit({ type: "interrupted" });
    return;
  }

  const deadline = now() + config.monitorSeconds * 1_000;
  let bufferingObservations = 0;
  let inactiveObservations = 0;
  let recoveries = 0;

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
      if (recoveries >= config.recoverAttempts) {
        throw new SupervisorError("Playback became inactive.");
      }
      recoveries += 1;
      bufferingObservations = 0;
      inactiveObservations = 0;
      emit({
        attempt: recoveries,
        maximum: config.recoverAttempts,
        type: "recovering",
      });
      if (!(await castFreshManifest())) {
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
