import { describe, expect, it } from "vitest";

import { createProgram } from "../src/cli.js";

describe("CLI help", () => {
  it("documents the local UI and fallback monitoring options", () => {
    const program = createProgram(new AbortController().signal);
    const uiCommand = program.commands.find((command) => command.name() === "ui");
    const castCommand = program.commands.find(
      (command) => command.name() === "cast",
    );

    expect(uiCommand?.helpInformation()).toContain("start a loopback-only web UI");
    expect(uiCommand?.helpInformation()).toContain(
      "loopback host to bind (127.0.0.1 or ::1)",
    );
    expect(castCommand?.helpInformation()).toContain(
      "fallback page to inspect if earlier sources fail",
    );
    expect(castCommand?.helpInformation()).toContain("(repeatable)");
    expect(castCommand?.helpInformation()).toContain(
      "monitoring duration; 0 runs until interrupted",
    );
    expect(castCommand?.helpInformation()).toContain(
      "maximum recovery attempts; 0 retries forever",
    );
  });
});
