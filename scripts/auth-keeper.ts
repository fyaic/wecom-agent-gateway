import { pathToFileURL } from "node:url";
import { inspectAuthKeeper } from "./lib/auth-keeper.js";

export async function authKeeperMain(args: string[]): Promise<number> {
  const command = args[0] ?? "doctor";
  if (args.length > 1 || !["doctor", "inspect", "renew"].includes(command)) {
    console.log(
      JSON.stringify({
        event: "auth_keeper",
        ok: false,
        status: "invalid-arguments",
      }),
    );
    return 2;
  }
  const result = await inspectAuthKeeper({
    mode: command as "doctor" | "inspect" | "renew",
  });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await authKeeperMain(process.argv.slice(2));
