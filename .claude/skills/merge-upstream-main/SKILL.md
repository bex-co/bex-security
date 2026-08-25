---
name: merge-upstream-main
description: Merge the public openai/codex-security main branch into this fork's main branch and push the result to the fork remote. Use when asked to sync or merge upstream main for this repository.
---

# Merge Upstream Main

Sync this fork from `https://github.com/openai/codex-security.git` with a Git
merge. Do not rebase or rewrite `main`.

## Inspect The Repository

1. Confirm the current repository, branch, worktree, and remotes with
   `git rev-parse --show-toplevel`, `git branch --show-current`, `git status
--short --branch`, and `git remote -v`.
2. Continue only on `main` with a clean worktree, including no untracked files.
   Do not switch branches, stash changes, or discard work automatically. Report
   the state and ask the user how to proceed when either condition is not met.
3. Read the applicable `AGENTS.md` instructions before resolving conflicts or
   running checks.

## Identify The Remotes

- The canonical upstream is the remote whose normalized GitHub repository is
  `openai/codex-security`. Reuse an existing matching remote. If none exists,
  add it as `upstream` with the canonical URL above when that remote name is
  available. If `upstream` already points elsewhere, stop and ask rather than
  rewriting it.
- The fork remote is the remote tracked by local `main`, when that remote is not
  the canonical repository; otherwise prefer a noncanonical `origin`, then the
  sole remaining noncanonical remote.
- Never select the canonical repository as the fork remote. If no fork remote
  exists, or multiple candidates make the destination ambiguous, stop and ask
  the user to identify or configure the fork remote. Do not guess a repository
  URL or rewrite an existing remote.

Show the selected upstream and fork remote names and URLs before fetching. This
guards against pushing the fork merge to the canonical repository.

Use task-specific `upstream_remote` and `fork_remote` shell variables for the
selected remote names, and quote their expansions in commands.

## Merge And Verify

1. Fetch both selected remotes with `git fetch "$upstream_remote"` and
   `git fetch "$fork_remote"`.
2. Fast-forward local `main` to the fork's remote-tracking `main` with
   `git merge --ff-only "$fork_remote/main"`. If local and fork `main` have
   diverged, stop and report the commits on each side instead of choosing a
   history strategy.
3. Merge upstream with `git merge --no-edit "$upstream_remote/main"`. A
   fast-forward is acceptable when the fork has no unique commits.
4. If conflicts occur, inspect each one and reconcile the fork's behavior with
   the upstream change. Do not resolve all conflicts with a blanket `ours` or
   `theirs` strategy. Continue the merge only after the result is coherent.
5. Run the repository checks relevant to the merged or conflict-resolved files.
   A clean, conflict-free upstream merge does not require inventing new tests.
6. Push local `main` with `git push "$fork_remote" main:main` without force.
7. Fetch both remotes again, then verify:
   - `git merge-base --is-ancestor "$upstream_remote/main" main` succeeds.
   - `git rev-list --left-right --count "$fork_remote/main...main"` reports
     `0 0`.
   - `git status --short --branch` is clean.

Never force-push, rebase `main`, skip hooks, or discard changes. If a command
fails, diagnose it and continue only when doing so preserves both upstream and
fork history.

Report the selected remotes, whether the update fast-forwarded or created a
merge commit, the resulting commit, checks run, push result, and final
verification.
