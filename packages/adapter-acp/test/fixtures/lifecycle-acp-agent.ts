// Fault-path fixture intentionally avoids loading the SDK. The regular
// fake-acp-agent fixture separately covers SDK-to-SDK protocol compatibility.
import { createInterface } from "node:readline";

process.stderr.write(`pid:${process.pid}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line) as {
    id?: number | string;
    method: string;
    params?: { protocolVersion: number };
  };
  if (request.method !== "initialize") return;
  const response = process.argv.includes("--reject-initialize")
    ? { error: { code: -32600, message: "initialization rejected" } }
    : {
        result: {
          protocolVersion: request.params?.protocolVersion,
          agentCapabilities: {},
        },
      };
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }) + "\n",
  );
});
