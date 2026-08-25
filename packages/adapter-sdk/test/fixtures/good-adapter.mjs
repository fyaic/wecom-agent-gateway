export default async function createAdapter(context) {
  context.reportDiagnostic("info", "fixture loaded");
  return {
    id: context.config.id ?? "external-fixture",
    contractVersion: context.contractVersion,
    sessionCompatibilityId: "external-fixture:v1",
    capabilities: new Set(["streaming", "resume"]),
    async *run(request) {
      if (!request.sessionId) {
        yield { type: "session-started", sessionId: "fixture-session" };
      }
      yield { type: "text-delta", text: "external" };
      yield { type: "message-completed", text: "external" };
    },
    async health() {
      return { ok: true };
    },
  };
}
