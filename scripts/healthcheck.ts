const port = positiveInteger(process.env.GATEWAY_OBSERVABILITY_PORT, 9_464);
const timeoutMs = positiveInteger(
  process.env.GATEWAY_HEALTHCHECK_TIMEOUT_MS,
  2_000,
);
try {
  const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error("Gateway is not ready");
  console.log(JSON.stringify({ event: "gateway_healthcheck", ready: true }));
} catch {
  console.error(JSON.stringify({ event: "gateway_healthcheck", ready: false }));
  process.exitCode = 1;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("Healthcheck configuration must be a positive integer");
  }
  return parsed;
}
