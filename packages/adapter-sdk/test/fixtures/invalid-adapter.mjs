export default function createAdapter() {
  return {
    id: "invalid",
    contractVersion: 999,
    capabilities: new Set(),
    async *run() {},
    async health() {
      return { ok: true };
    },
  };
}
