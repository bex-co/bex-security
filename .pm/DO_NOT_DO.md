# DO NOT DO — roadmap anti-goals and guardrails

Use this file as a hard constraint when running `/pm-brainstorm` and `/pm`. If a proposed milestone/task conflicts with any item below, reject it.

## Anti-goals

- Do not propose roadmap work that is not clearly tied to bex-security's project goals (a thin, trustworthy wrapper around Codex and its security plugin — see `AGENTS.md`) or current roadmap intent.
- Do not create milestones that are vague, non-testable, or missing observable outcomes.
- Do not create milestones for sub-hour work; keep those as inbox notes (`wN/NNN.md`).
- Do not add "nice-to-have" work that has no clear sequence/dependency/risk rationale for why it must happen now.
- Do not duplicate existing milestones/tasks without a clear gap analysis and replacement intent.
- Do not include tasks that cannot define concrete files/commands/systems they touch.
- Do not treat speculative ideas as committed roadmap items without explicit source context.
- **Do not propose speculative defenses.** No sanitization, redaction, validation, or fallback work for hypothetical problems; every hardening item must state the concrete failure it fixes (`AGENTS.md` — "Avoid speculative defenses").
- **Do not invent public CLI surface.** Commands, flags, accepted values, public env vars, and defaults are public API; do not propose adding or changing them unless the underlying user need is explicit and existing behavior is demonstrably insufficient (`AGENTS.md` — "Public CLI changes").
- **Do not propose work that would publish sensitive information.** Everything in this repository is public: no customer/tenant identifiers, credentials, scan targets or findings, undisclosed vulnerabilities, or nonpublic links in board items, commits, or PRs (`AGENTS.md` — "Public repository and pull requests").
- Do not propose rebasing, force-pushing, or rewriting `main`; upstream syncs go through `/merge-upstream-main` (merge, never rebase).
