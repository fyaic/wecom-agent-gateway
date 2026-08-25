# Public release checklist

The repository must remain private until every blocking item below is complete.

## Source and documentation

- [x] Root README explains value, architecture, limits, maturity, and quick start.
- [x] English and Simplified Chinese entry points exist.
- [x] License selection follows official WeCom upstream declarations.
- [x] Third-party dependencies and architectural references are documented.
- [x] Contribution, security, support, conduct, changelog, and roadmap files exist.
- [x] Issues and pull requests use privacy-aware templates.
- [x] The current worktree passes `pnpm run public:check` and `pnpm run ci`.
- [x] A full-ref audit command exists and accepts an operator-owned private term
      file without committing those terms: set
      `PUBLIC_AUDIT_PRIVATE_TERMS_FILE=/private/path/terms.txt` and run
      `pnpm public:history-check`.

## Git history and GitHub data — blocking

- [x] Back up the private repository in a verified, mode `0600` Git bundle
      outside the worktree. Keep merges frozen during the final ref update.
- [x] Scan every branch, tag, commit, tree, and blob for secrets, personal names,
      conversation names, internal IDs, private paths, message bodies, and media
      URLs. The pre-sanitized refs intentionally fail `public:history-check` and
      therefore remain private.
- [x] Audit pull request bodies, reviews, comments, all workflow logs, artifacts,
      issue data, and release assets for the same classes of data. No GitHub-side
      finding or artifact was present at the time of audit.
- [x] Check whether any credential was committed or pasted into GitHub. No such
      evidence was found; any future finding still requires rotation even if the
      value was later deleted.
- [x] With repository-owner approval, rewrite affected Git history or publish a
      clean snapshot repository. Force-pushing rewritten refs is destructive and
      must not be done as an implicit cleanup step. The original repository is
      retained as a private, separately named archive; the public candidate was
      created as a new repository from a reviewed clean root commit.
- [x] Remove obsolete branches and tags from the public repository. Historical
      refs exist only in the separately named private archive and offline bundle.
- [x] Clone the sanitized repository into a fresh directory and repeat the full
      scan against all reachable refs. GitHub-created Dependabot refs are also
      scanned and contain no predecessor history.

## Repository settings — blocking

- [x] Confirm the repository name, description, topics, and public contact route.
- [ ] Upload and verify the final social preview image after the repository is
      public. The reviewed 1280×640 project asset is already tracked at
      [`assets/social-preview.png`](assets/social-preview.png).
- [x] Enable private vulnerability reporting after the repository is public and
      review the security policy from an unauthenticated session.
- [x] Enable branch rules for required CI, review, signed commits or vigilant
      mode as appropriate, and blocked force pushes after sanitization. The
      protected default branch now requires the `verify` check and linear
      history, applies to administrators, requires resolved conversations, and
      blocks force pushes and deletion.
- [x] Confirm squash-only merge, automatic branch deletion, Dependabot alerts,
      and automatic security updates.
- [x] Confirm GitHub Actions permissions are read-only by default and pin every
      external Action to an immutable commit SHA.
- [x] Change visibility only after a final maintainer review.

## First public release

- [x] Choose `v0.1.0` as the first Public Preview SemVer tag.
- [x] Move verified entries from Unreleased into the `v0.1.0` changelog section.
- [x] Prepare [`releases/v0.1.0.md`](releases/v0.1.0.md); re-run its links and
      claims from the sanitized default branch before publishing.
- [ ] Attach only reproducible, checksummed artifacts; never attach local config,
      databases, logs, transcripts, or media.
- [x] Announce Public Preview limitations and unsupported production guarantees.
- [x] Verify badges, documentation links, issue forms, and Security Advisory flow
      as an unauthenticated visitor.
