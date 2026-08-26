export default function createAdapter(context) {
  return {
    id: "invalid-interaction",
    contractVersion: context.contractVersion,
    capabilities: new Set(["streaming", "resume", "reply-actions"]),
    async *run() {},
    async health() {
      return { ok: true };
    },
  };
}
