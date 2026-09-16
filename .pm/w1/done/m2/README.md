# w1 · m2 — Durable host-review failure evidence and incomplete summaries

**Worker:** worker1 **Goal:** Failed or interrupted host reviews retain actionable evidence and partial work while complete scans retain their existing integrity contract. **Status:** done

## Tasks (in order)

| id   | title                                                                | est | depends_on |
| ---- | -------------------------------------------------------------------- | --- | ---------- |
| t001 | Persist host-review attempts and assignment results — **DONE**       | 45m | —          |
| t002 | Retain incomplete review artifacts and a readable summary — **DONE** | 45m | t001       |
| t003 | Verify SDK and CLI failure delivery — **DONE**                       | 45m | t002       |
| t004 | Surface parity and documentation — **DONE**                          | 30m | t003       |
| t005 | Simplify milestone changes — **DONE**                                | 30m | t004       |
| t006 | Test coverage and required checks — **DONE**                         | 45m | t005       |
| t007 | Close out the milestone — **DONE**                                   | 15m | t006       |

## Definition of done

- Every launched attempt has assigned-file metadata on disk; terminal attempts retain read evidence, response state, safe errors and candidate data before retry or exit.
- Exhausted or interrupted reviews preserve completed work, list missing files and provide a clearly incomplete Markdown summary. Unvalidated candidates never become confirmed findings or successful reports.
- Diagnostics failures do not replace the original scan error or stop an otherwise valid scan. Existing coverage validation, failed status and nonzero CLI exits remain intact.
- Deterministic regression/integration tests cover both successful report delivery and failed/canceled review retention; required checks and documentation are complete.

## Source + Goal linkage

- **Source:** Maintainer request to implement the diagnosed host-review failure-retention fix. A review can exhaust retries before all reads are evidenced; the old flow throws before saving its in-memory assignment results.
- **Goal linkage:** Keep the wrapper trustworthy and make failed scans diagnosable using existing agent and output mechanisms.
- **Expected outcome:** Users can inspect completed work and exact failure categories without rerunning an entire target merely to learn why it failed.
- **Why now:** Startup, output and coverage failures currently collapse into a coverage error without durable per-assignment evidence.
- **Surface parity:** Included for the SDK/CLI diagnostic and output behavior. Container paths use existing output mounts; no new public settings or defaults.
- **Privacy:** Synthetic fixtures only; no real scan targets, findings, session transcripts or machine-specific logs belong in this public board.

## Validation evidence

- Focused host-review and CLI/SDK integration coverage: 18 passed, 0 failed (Bun 1.3.14).
- `pnpm run types`, `pnpm run format`, `pnpm run build`, `git diff --check` and built CLI `--version` passed. PM Markdown formatting passed. Plugin sources were unchanged.
- Seeded full suite (`12345`): 2473 passed, 43 skipped; one existing workflow test failed because the local PATH lacked `python`. Adding the existing Python 3.12 executable directory made that test pass without code changes. Final full-suite run in the corrected environment passed: 2475 passed, 43 skipped, 0 failed across 122 files (seed `2315222805`, Bun 1.3.14).
- Coverage includes startup failures, invalid responses, absent completion events, stream failures, partial candidates, cancellation with another completed worker, diagnostic/observer write failures, and successful versus failed SDK/CLI delivery using synthetic runtime/workbench fixtures.
- No real-provider scan was run for this milestone; these checks establish the host retention/reporting behavior, not resolution of a provider startup or performance problem.
