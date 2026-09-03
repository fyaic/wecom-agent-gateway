## Summary

Describe the problem and the smallest coherent solution.

## Boundary impact

- Affected area: Transport / Core / Runtime Contract / Adapter / Tool / Docs
- Runtime Contract compatibility: unchanged / additive / breaking
- Real-world paths not tested:

## Validation

- [ ] Added or updated deterministic fake-backed tests.
- [ ] Ran `pnpm run ci` locally.
- [ ] Updated public docs, compatibility tables, or ADRs as needed.
- [ ] Capability claims follow `docs/evidence-claims.md`: implementation,
      deterministic automation, real-client evidence, and end-to-end
      certification are not conflated; untested paths are listed above.
- [ ] No credentials, internal IDs, real employee/conversation names, message
      contents, media URLs, private paths, or model output were committed.
- [ ] New or adapted third-party source is documented in
      `THIRD_PARTY_NOTICES.md`, or this change includes none.
- [ ] The change preserves the single Bot identity and keeps Agent reasoning,
      model selection, and business routing outside Gateway Core.
