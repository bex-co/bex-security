# Security policy

Bex Security is a local tool for reviewing repositories you trust and have
permission to assess. This policy explains which security issues are in scope
and how to report them.

## Report a vulnerability

Report vulnerabilities in Bex-specific CLI, SDK, ACP, packaging, or release
behavior through this repository's private
[GitHub security advisory form](https://github.com/bex-co/bex-security/security/advisories/new).
Report vulnerabilities that reproduce in the unmodified upstream Codex
Security project through
[OpenAI's Bugcrowd program](https://bugcrowd.com/engagements/openai).
The **Codex** section defines the scope, supported configurations, and reward
eligibility. That policy takes precedence over this summary. Keep vulnerability
details out of public issues and pull requests.

## What qualifies

A report must show a software flaw that lets a less-privileged attacker bypass
an enforced security restriction in a current, supported release and
configuration. Examples include bypassing a filesystem or network restriction,
a required approval, or an administrator-enforced control.

Prompt injection or a model misusing access it already has does not qualify
by itself, even if it leaks data or performs an unwanted action. A report must
identify a separate flaw in an enforced security control. Model-behavior
reports may qualify under the separate
[Safety Bug Bounty](https://bugcrowd.com/engagements/openai-safety).

Missed findings, false positives, incorrect scan results, and performance issues
are ordinary bugs unless they also demonstrate such a flaw. Report ordinary
bugs through GitHub issues.

## Bex package scope

- The published `@bex-co/bex-security` package and its `bex-security` and
  compatibility `codex-security` CLIs.
- The TypeScript SDK, including target selection, authentication,
  configuration, execution, and result validation.
- The Codex Security plugin, interpreter, and Codex runtime bundled with an
  official release.
- Scan output, including manifests, findings, coverage, reports, SARIF, and
  scan history.
- Official package, build, and release integrity.

## Scan permissions

Codex Security runs under your local account. Scan only repositories you trust
and have permission to assess.

Deep-scan workers use read-only execution to prevent concurrent workspace
writes. This does not make the worker an isolated, offline environment or
disable inherited MCP servers. Workers must stay within the parent session's
permissions. Use of an inherited tool's existing access is not, by itself, a
security-boundary bypass; enforced restrictions that apply to that tool or
operation still matter.

## What to report

Include the product version, operating system, active configuration, attacker's
starting permissions, control that fails, and steps that reproduce the security
impact. Remove credentials and unrelated private data from examples and logs.

For vulnerabilities found in a repository you scan, follow that project's
security policy.
