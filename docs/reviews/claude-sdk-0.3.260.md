# Claude Agent SDK 0.3.260 dependency review

Review date: 2026-09-07. Baseline: SDK 0.3.258. Scope: optional experimental
Claude Adapter only; no default registration, Bot restart, or support-level change.

## Decision and original failure

Accept this exact dependency update under the existing optional-dependency and
user-owned authentication constraints below. This is an engineering provenance
review, not a legal opinion or permission to resell Anthropic services.

[Dependabot PR #62](https://github.com/fyaic/wecom-agent-gateway/pull/62)
passed its 334 Linux tests and both fresh-install jobs, but failed the license
gate for SDK 0.3.260 and its Linux x64 binary. The failure was correct: the gate
had reviewed only 0.3.258. Locally, the same gate rejected 0.3.260 before the
review was added. No unknown-license category or future version is exempted.

## Sources and actual package evidence

- [Tagged upstream README](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.260/README.md)
  continues to refer SDK use to Anthropic Commercial Terms, with separately licensed
  components retaining their own licenses.
- [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), effective
  2025-06-17 as displayed at review time, govern the customer's applicable service
  use; this repository does not relicense the SDK as MIT.
- [Official legal/compliance guidance](https://code.claude.com/docs/en/legal-and-compliance)
  requires the published binary to remain unmodified, users to authenticate under
  their own permitted agreements, and no resale/intermediation of their usage.
  Third-party products should use customer-owned API/cloud credentials; this
  Gateway does not offer Claude.ai login or handle subscription session tokens.
- The actual npm SDK package declares `SEE LICENSE IN README.md`; all eight
  version-matched platform packages declare `SEE LICENSE IN LICENSE.md` in the
  official registry. Their exact integrity values are retained in `pnpm-lock.yaml`.
- Read the installed SDK and Darwin arm64 README/LICENSE files, and the LICENSE.md
  extracted directly from the official Linux x64 0.3.260 tarball. SDK README and
  LICENSE.md match the previously reviewed 0.3.258 files byte-for-byte. The Darwin
  and Linux notices identify Anthropic copyright and refer to official legal terms.
- Reviewed LICENSE.md SHA-256 for SDK and the inspected binaries:
  `8ce94b9478bb9868f9641f818e06cd722fbe55d4c22e2d2ed11971b20146173a`.
  Other platforms were inspected through registry metadata, not run on this host;
  the gate checks each actually installed package's manifest and notice hash.

SDK tarball integrity:
`sha512-PmABtP4Rwd6l95itQrqzguv6rS9uACqikPB9g8BPeWRKZOpy3xpEOjJLYauof3BFk2wNZnfhr0Ttx8ttcZzq0w==`.
Linux x64 tarball integrity:
`sha512-JR6MS8KeETQoxSaNtBFqCFV66QM+gsNeuWjXIhac4wXb19gRGiOcsCjBqQU8kadUYCBUabd6lKN2edwG6ETSXg==`.

The gate now requires exact reviewed name/version, the corresponding installed
manifest declaration, and the reviewed LICENSE.md hash. Missing paths/files,
changed notices, unknown packages, or multiple/unreviewed versions fail closed.
The helper is limited to this Claude exception, not a general licensing platform.

Integration-review correction: a generic allowed-SPDX group previously skipped
the exact Claude check. The inventory dispatcher now handles these nine Claude
packages first, before ordinary SPDX categories; even a changed declaration to
MIT/Apache requires a new review. Tests exercise this dispatcher for all nine
names, both the reviewed and an unreviewed version, as well as unchanged ordinary
dependency policy. This closes the bypass rather than only testing the helper.
After this correction, local full CI passed 38 files / 355 tests, including
19 license-policy tests; the original upgrade-only result below remains dated
evidence of the preceding revision, not the current total.

## Compatibility and tests

[0.3.260 release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.260)
adds optional progress/correlation/latency metadata and improves structured-output
error diagnostics. The 0.3.259 intermediate release adds correlation metadata and
an optional permission setting. The Adapter continues to use isolated settings,
no tools and `permissionMode: dontAsk`; no new permissions or automatic mode are enabled.

- Existing text, quoted text, session matching, cancellation and terminal-state
  fake tests run against the new installed SDK exports/types.
- Added regression tests: new thinking/rate-limit/result metadata is not projected
  as user-visible text; structured-output diagnostics stay behind the existing
  fixed error message instead of leaking tool fields/values.
- Added license-gate tests for the actual installed notice and fail-closed cases.
- No runtime protocol change was needed; no binary modification or vendored source.
- Only the nine Claude package versions/integrities change in the lockfile;
  unrelated SDK/peer dependencies remain pinned as before.

Local full `pnpm run ci` passed: formatting, typecheck, 38 files / 344 tests and
public readiness. This includes 23 Claude Adapter tests and 8 license-policy
tests. It is not a claim that this review branch has completed remote Linux CI;
the Linux PR results above belong to the original Dependabot change.

## Real authentication boundary

The unmodified bundled Claude Code 2.1.260 `auth status` was invoked with a
15-second bound and the same minimal non-secret environment as the isolated
smoke. Output was projected only to booleans: `statusAvailable: true`,
`loggedIn: false`. No credential file was read or copied, no login was triggered,
and no model request or production Bot connection was made.

**The single remaining human prerequisite for this personal smoke is to complete
the user's own sign-in in the official, unmodified Claude Code flow on this host.**
Do not send tokens to the maintainer or put subscription tokens in Gateway config.
Then rerun `pnpm smoke:claude-code-adapter -- --confirm-real-claude` under the
existing authorization. This personal check is not a third-party login product.

Still unverified: authenticated text/session/cancel success, restart recovery,
WeCom direct/group delivery, media and interaction. The dependency review does
not close those gaps or upgrade Claude Code from experimental status.
