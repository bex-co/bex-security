---
name: release
description: Bump, validate, publish, and announce a public @bex-co/bex-security release using upstreamVersion-bex.N. Use only when explicitly asked to cut or publish a Bex Security release.
---

# Release Bex Security

Publish one immutable `@bex-co/bex-security` version from `main`. A successful
release has the same version in `sdk/typescript/package.json`, npm, the
`bex-v<version>` Git tag, and the GitHub release.

## Preconditions

1. Read the repository `AGENTS.md` instructions and review all material that
   will become public.
2. Require a clean worktree on `main`. Never stash, discard, amend, rebase a
   published commit, or force-push.
3. Fetch `origin` and the canonical `openai/codex-security` upstream. Bring
   local `main` to `origin/main` with a fast-forward only.
4. Confirm `sdk/typescript/package.json` names
   `@bex-co/bex-security`, points to the Bex repository, and retains
   `codex-security` only as a compatibility bin.
5. Authenticate to the public npm registry. When `.env` provides `NPM_TOKEN`,
   load it without printing it and pass it only through the process
   environment:

   ```bash
   env "npm_config_//registry.npmjs.org/:_authToken=$NPM_TOKEN" npm whoami --registry=https://registry.npmjs.org
   ```

   Do not create or commit an npm credentials file.

## Choose The Version

Resolve the merged upstream baseline with `git merge-base main upstream/main`.
Read the upstream package version from that commit rather than claiming an
unmerged upstream release.

- Versions are `<upstream-version>-bex.<release-number>`.
- Use `.1` for the first Bex release on a new upstream version.
- Otherwise increment the greatest published Bex release number for that exact
  upstream version.
- Never reuse, overwrite, deprecate, or unpublish a version.
- If npm already contains the intended version, enter recovery mode: do not
  bump or publish it again; verify the archive and complete only missing Git or
  GitHub release metadata.

Update these fields together:

- `version`
- `bex.upstreamVersion`
- `bex.upstreamCommit`
- `.github/bex-release-notes.md` release marker, heading, summary, highlights,
  and upstream base

Release notes must describe user-visible Bex behavior generically. Do not copy
private scan targets, findings, credentials, customer context, local paths, or
unreviewed commit messages into public metadata.

## Validate The Exact Package

Install from the frozen lockfile, then run formatting, generated-model checks,
types, tests, build, production audit, and the installed-package smoke test.
Pack into an ignored release directory and run `scripts/check-package.mjs` on
the exact tarball. Inspect its package metadata and file list before
publication.

The package must expose `bex-security`, preserve `codex-security` as an alias,
query `@bex-co/bex-security` for update notices, and contain no credentials or
private release material.

## Commit And Publish

1. Commit only the reviewed version, metadata, notes, documentation, tests,
   and release-workflow changes. Pull `origin/main` with rebase before the
   first push, resolve conflicts without losing either side, and push normally.
2. Wait for the pushed Node and container CI workflows to succeed. Fix and
   repeat when an in-scope failure is reproducible.
3. Create the annotated tag `bex-v<version>` on the verified commit and push
   the tag without force.
4. Publish the exact validated tarball with public access and the `latest`
   dist-tag:

   ```bash
   env "npm_config_//registry.npmjs.org/:_authToken=$NPM_TOKEN" npm publish <archive> --access public --tag latest --registry=https://registry.npmjs.org
   ```

5. Verify npm reports the expected name, version, description, repository,
   bins, `latest` dist-tag, and Bex upstream metadata. Install the registry
   version into a clean temporary consumer and run both CLI launchers.
6. Create a reviewed GitHub release from the existing tag, with title
   `Bex Security <version>` and `.github/bex-release-notes.md` as its body.

If npm publishing succeeds but a later step fails, do not create another
version. Resume from registry verification and finish the missing tag or
GitHub release. Report the version, upstream baseline, commit, npm URL, GitHub
release URL, checks run, and final `main...origin/main` status.
