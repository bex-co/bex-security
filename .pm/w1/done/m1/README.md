# w1 · m1 — Make Muse ACP a trustworthy Bex Security agent

**Worker:** worker1 **Goal:** Make the existing `scan --agent muse` path obey the same ACP and evidence-backed completion contract as the other supported agents, without a Muse-specific scanning engine. **Status:** done

## Tasks (in order)

| id   | title | est | depends_on |
| ---- | ----- | --- | ---------- |
| t001 | Add shared ACP conformance coverage for the diagnosed Muse gaps — **DONE** | 45m | — |
| t002 | Fix Muse Code ACP protocol normalization and headless safety semantics — **DONE** | 60m | t001 |
| t003 | Consume a packed Muse ACP build through the generic Bex adapter — **DONE** | 45m | t002 |
| t004 | Make scan progress and completion evidence-backed for every ACP agent — **DONE** | 60m | t003 |
| t005 | Add a capability-driven host fallback when delegated workers are unavailable — **DONE** | 60m | t004 |
| t006 | Run the private adjacent-repository Muse verification loop — **DONE** | 60m | t005 |
| t007 | Publish the fixed Muse ACP package and repeat the installed-package verification — **DONE** | 45m | t006 |
| t008 | Verify ACP-to-CLI cross-surface parity — **DONE** | 30m | t007 |
| t009 | Simplify the milestone changes — **DONE** | 30m | t008 |
| t010 | Run CI and complete behavioral test coverage — **DONE** | 45m | t008, t009 |
| t011 | Close out the milestone — **DONE** | 15m | t010 |

## Definition of done

- The Muse adapter passes the same command-event, model/effort, workspace, permission, cancellation, usage, and terminal-state conformance checks used for the other ACP agents.
- Bex contains no Muse-specific scan orchestration or Muse event-shape parsing; agent-specific code is limited to launch/configuration mapping that ACP does not standardize.
- The existing Muse CLI invocation completes against the maintainer-provided adjacent repository without an approval deadlock, reports monotonic host-verified progress, writes valid canonical artifacts, and cannot claim complete coverage without evidence for the authoritative inventory.
- The end-to-end verification is repeated from a clean registry-installed `@bex-co/muse-code-acp` package. Any failure must produce a regression test and return to the owning adapter or Bex task; t006/t007 remain open until the same verification passes.
- All affected formatting, type, unit, integration, package, and CI checks pass. No new public command, flag, environment variable, or default is introduced.

## Source + Goal linkage

- **Source:** Maintainer-requested Muse ACP reliability diagnosis and local reproductions; target identity, findings, and environment details are intentionally excluded from this public board.
- **Goal linkage:** Advances Bex Security's goal of remaining a thin, trustworthy wrapper that supports multiple agents through ACP while preserving upstream compatibility.
- **Expected outcome:** Muse uses the same user-facing scan command and generic Bex pipeline as Codex, Claude, and Kimi, while ACP conformance tests and host-owned evidence prevent hangs and false completion.
- **Why now:** A reproduced Muse run reviewed a sparse set of files, self-reported the entire inventory as complete, and previously deadlocked on an internal approval. These are concrete trust failures on the newly shipped agent path and must be fixed before treating Muse results as full scans.
- **Cross-surface parity:** Included because normalized ACP events and coverage semantics are rendered by the user-facing CLI/dashboard. The milestone does not add public CLI surface.
