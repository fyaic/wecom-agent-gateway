#!/usr/bin/env node
import { resolve } from "node:path";
import {
  loadRuntimeAdapter,
  parseRuntimeAdapterConfig,
} from "@fyaic/wecom-adapter-sdk";
import { runAdapterConformance } from "./index.js";

const args = parseArguments(process.argv.slice(2));
try {
  const adapter = await loadRuntimeAdapter({
    moduleSpecifier: required(args, "module"),
    baseDirectory: resolve(args["base-directory"] ?? process.cwd()),
    packageBaseDirectory: process.cwd(),
    config: parseRuntimeAdapterConfig(args.config),
  });
  const report = await runAdapterConformance(adapter, {
    timeoutMs: positiveInteger(args.timeout, 10_000),
    exerciseCancel: args["exercise-cancel"] === "true",
    mediaFixtures: {
      ...(args.image ? { image: resolve(args.image) } : {}),
      ...(args.audio ? { audio: resolve(args.audio) } : {}),
      ...(args.video ? { video: resolve(args.video) } : {}),
      ...(args.file ? { file: resolve(args.file) } : {}),
    },
  });
  process.stdout.write(
    `${JSON.stringify(report, null, args.pretty ? 2 : 0)}\n`,
  );
  if (!report.passed) process.exitCode = 1;
} catch {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, passed: false, code: "conformance-runner-failed" })}\n`,
  );
  process.exitCode = 1;
}

function parseArguments(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  const known = new Set([
    "module",
    "base-directory",
    "config",
    "timeout",
    "image",
    "audio",
    "video",
    "file",
    "pretty",
    "exercise-cancel",
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error("Expected named arguments");
    const name = value.slice(2);
    if (!known.has(name)) throw new Error(`Unknown --${name}`);
    if (name === "pretty" || name === "exercise-cancel") {
      parsed[name] = "true";
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing --${name}`);
    parsed[name] = next;
    index += 1;
  }
  return parsed;
}

function required(values: Record<string, string>, name: string): string {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error("Invalid timeout");
  return parsed;
}
