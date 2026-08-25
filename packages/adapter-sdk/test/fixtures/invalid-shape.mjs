export default function createAdapter(context) {
  return {
    contractVersion: context.contractVersion,
    capabilities: new Set(["invented-capability"]),
    async *run() {},
    async health() {
      return { ok: true };
    },
  };
}
