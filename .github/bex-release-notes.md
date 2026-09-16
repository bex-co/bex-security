<!-- release-version: 0.1.27-bex.1 -->

# Bex Security 0.1.27-bex.1

This release updates Bex Security to the Codex Security 0.1.27 baseline while
preserving the Bex-branded multi-agent CLI and TypeScript SDK. The
`codex-security` command remains available as a compatibility alias.

Highlights:

- Keep host-managed reviews diagnosable: failed or interrupted reviews now
  retain per-attempt evidence and an incomplete-scan summary beside the scan
  output, while successful scans keep their existing report contract.
- Finish scans on agents whose runtime offers background workers but cannot
  delegate review work, instead of ending the coordinator turn before the
  canonical artifacts are written.
- Draft security policy with the new `policy` command, and load reusable scan
  settings from a project file with `-c`, `init`, and `info`.
- Read cost estimates as context-aware ranges, and follow the upstream
  packaging, recovery, and Windows reliability improvements.
- Reuse Muse Code sessions with isolated scan history, and scan through Codex,
  Claude Code, Kimi Code, Muse Code, Qwen Code, or MiMo Code over ACP.

Upstream base: `@openai/codex-security@0.1.27`
(`1a3ca64333f894426dde0c0a7721d717c99f8cba`).
