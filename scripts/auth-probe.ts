import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { probeCliMessageSessions } from "./lib/cli-capability-probe.js";

/** Explicit, read-only capability evidence; does not enable maintenance or replay writes. */
export async function authProbeMain(
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    probe?: typeof probeCliMessageSessions;
    emit?: (result: unknown) => void;
  } = {},
): Promise<number> {
  const emit =
    options.emit ?? ((result) => console.log(JSON.stringify(result)));
  try {
    if (args.length !== 2 || args[0] !== "--env-file" || !isAbsolute(args[1]!))
      throw new Error();
    const raw = await readFile(args[1]!, "utf8");
    if (Buffer.byteLength(raw) > 65_536) throw new Error();
    const result = await (options.probe ?? probeCliMessageSessions)({
      env: { ...(options.env ?? process.env), ...parseEnv(raw) },
    });
    emit(result);
    return result.ok ? 0 : 2;
  } catch {
    emit({
      event: "cli_capability_probe",
      ok: false,
      code: "invalid-configuration",
      identity: "not-verified",
      capability: "message-sessions",
      businessVerified: false,
    });
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await authProbeMain(process.argv.slice(2));
