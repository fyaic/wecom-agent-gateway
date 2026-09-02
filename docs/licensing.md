# Licensing and upstream provenance

Updated 2026-09-02.

## Project license

Original code in this repository is released under the [MIT License](../LICENSE).
MIT was selected after reviewing the open-source declarations of the official
WeCom components on which this project directly depends or relies:

- `WecomTeam/wecom-cli`: repository LICENSE and package manifest both declare
  MIT.
- `@wecom/aibot-node-sdk`: package manifest declares MIT. At the review date,
  GitHub did not detect a standalone repository LICENSE file.
- `@wecom/wecom-openclaw-plugin`: package manifest declares MIT. At the review
  date, GitHub did not detect a standalone repository LICENSE file.
- OpenClaw and `@openclaw/gateway-client`: MIT.

The Codex SDK and ACP TypeScript SDK are Apache-2.0 dependencies. Their licenses
permit use from this MIT-licensed project and continue to govern those
dependencies. The dependency tree also contains permissive licenses and
MPL-2.0 packages; no dependency is relicensed by this repository.

Claude Code has an isolated, optional C0 protocol Adapter package but is not
registered by the default Gateway or advertised as a production-supported
Kernel. Its exact official Agent SDK dependency is `0.3.258`; the npm manifest
uses the non-SPDX value `SEE LICENSE IN README.md`, and the package README points
to Anthropic's Commercial Terms. The published platform binary remains
unmodified. The SDK is an optional dependency and the default production image's
`--no-optional` install does not include it. Every user must bring and directly manage a permitted credential;
the Gateway does not collect or intermediate Claude.ai login/session tokens.
The dependency and its terms are recorded in `THIRD_PARTY_NOTICES.md`. See
[`claude-code-adapter-evaluation.md`](claude-code-adapter-evaluation.md).

## Source provenance rule

This project uses published SDKs as dependencies and studies upstream public
protocols and behavior. It does not vendor the official WeCom OpenClaw plugin
or other reference repository source. If source is copied, translated, or
substantially adapted in the future, the change must:

1. verify the exact upstream version and license;
2. preserve required notices;
3. record the source path and commit in
   [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md);
4. pass maintainer review before merge.

Run `pnpm licenses list` for the complete lockfile-derived inventory. CI rejects
unreviewed SPDX categories and permits a non-SPDX package only by exact reviewed
package name and version; a future Agent SDK upgrade therefore fails closed
until its terms are reviewed again.

## Names and trademarks

WeCom, 企业微信, Tencent, Codex, Claude, Anthropic, Kimi, OpenClaw, and Pi are
names or marks of their respective owners. This independent project is not an
official Tencent WeCom or Anthropic product and does not imply endorsement by
any upstream project.
