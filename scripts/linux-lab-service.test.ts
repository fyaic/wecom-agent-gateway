import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startLinuxLab } from "./linux-lab-service.js";

it("serves actual loopback health and reuses durable session without duplicate final", async () => {
  const root = await mkdtemp(join(tmpdir(), "wecom-linux-lab-"));
  let lab: Awaited<ReturnType<typeof startLinuxLab>> | undefined;
  try {
    lab = await startLinuxLab(join(root, "gateway.db"), 0);
    expect(lab.report).toMatchObject({
      realBot: false,
      realAgent: false,
      reusedSession: false,
      newFinals: 1,
    });
    const response = await fetch(`http://127.0.0.1:${lab.port}/readyz`);
    expect(await response.json()).toMatchObject({ ready: true });
    await lab.stop();
    lab = undefined;
    lab = await startLinuxLab(join(root, "gateway.db"), 0);
    expect(lab.report).toMatchObject({
      reusedSession: true,
      newFinals: 0,
      outbox: { pending: 0, leased: 0, dead: 0 },
    });
  } finally {
    await lab?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
