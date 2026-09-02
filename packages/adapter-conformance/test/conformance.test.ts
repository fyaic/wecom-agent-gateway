import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeAdapter } from "@fyaic/wecom-runtime-contract";
import createCleanRoomAdapter from "../../../examples/clean-room-adapter/src/index.js";
import { runAdapterConformance } from "../src/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const imageFixture = resolve(
  repositoryRoot,
  "docs/assets/verified-kernel-cases/pi-wecom-private.png",
);

describe("Adapter conformance kit", () => {
  it("certifies the clean-room Adapter with text, resume, quote, image, actions and cancel", async () => {
    const adapter = await createCleanRoomAdapter({
      contractVersion: 1,
      config: { prefix: "certified: " },
      tools: [],
      reportDiagnostic() {},
    });
    const report = await runAdapterConformance(adapter, {
      exerciseCancel: true,
      mediaFixtures: { image: imageFixture },
    });

    expect(report.passed).toBe(true);
    expect(report.summary.failed).toBe(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        { id: "turn.text", status: "passed" },
        { id: "turn.session-resume", status: "passed" },
        { id: "turn.quoted-context", status: "passed" },
        { id: "turn.media.image", status: "passed" },
        { id: "interaction.reply-actions", status: "passed" },
        { id: "turn.cancel", status: "passed" },
      ]),
    );
    const evidence = JSON.parse(
      await readFile(
        resolve(
          repositoryRoot,
          "docs/evidence/adapter-conformance-clean-room.json",
        ),
        "utf8",
      ),
    );
    expect(report).toEqual(evidence);
  });

  it("reports capability lies with stable codes and never includes Adapter errors", async () => {
    const adapter: AgentRuntimeAdapter = {
      id: "lying-adapter",
      contractVersion: 1,
      capabilities: new Set(["streaming"]),
      async *run() {
        yield { type: "message-completed", text: "PRIVATE RESPONSE" };
      },
      async health() {
        throw new Error("PRIVATE CREDENTIAL VALUE");
      },
    };

    const report = await runAdapterConformance(adapter);
    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({
      id: "adapter.health",
      status: "failed",
      code: "adapter-operation-failed",
    });
    expect(report.checks).toContainEqual({
      id: "turn.text",
      status: "failed",
      code: "streaming-without-deltas",
    });
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
  });

  it("runs as a standalone JSON CLI against a module path", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve(repositoryRoot, "packages/adapter-conformance/src/cli.ts"),
        "--module",
        "./examples/clean-room-adapter/src/index.ts",
        "--base-directory",
        repositoryRoot,
        "--config",
        '{"prefix":"cli: "}',
        "--image",
        imageFixture,
        "--exercise-cancel",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const report = JSON.parse(output) as {
      passed: boolean;
      adapter: { id: string };
    };
    expect(report).toMatchObject({
      passed: true,
      adapter: { id: "clean-room-echo" },
    });
  });
});
