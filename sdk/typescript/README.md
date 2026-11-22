# `@bex-co/bex-security`

Open-source TypeScript SDK and CLI for running evidence-backed Bex Security
scans with Codex, Claude Code, Kimi Code, Muse Code, Qwen Code, MiMo Code, and
additional ACP agents. Scan a repository, selected paths, or Git changes for
vulnerabilities. The CLI and TypeScript SDK can validate findings, generate
patches, verify fixes, and export results as SARIF, JSON, or CSV. The package
includes the `bex-security` executable, the generated security plugin, and the
matching Codex runtime. The `codex-security` and `cs` executables run the same
CLI and remain available for compatibility.

> [!NOTE]
> Versions use `upstreamVersion-bex.N`, so the upstream Codex Security baseline
> and each Bex release on that baseline remain visible. The public API may
> change between minor versions before `1.0.0`.

## Install

Use Node.js 22.x (22.13.0 or later), 24.x, or 26.x on macOS, Linux, or Windows.
Scans also require Python 3.10 or later. On Python 3.10, install `tomli`.

### Install the CLI

```sh
npm install --global @bex-co/bex-security
```

The CLI runs as `bex-security`. To skip the global install, use
`npx @bex-co/bex-security` in place of `bex-security` in the examples below.

### Install the TypeScript SDK

Install the package in your project directory.

```sh
npm install @bex-co/bex-security
```

Before 1.0, minor releases may change the public API.

### Install from source

To run from a source checkout instead of the published npm package, install
both dependency trees before building the bundled plugin and CLI:

```sh
git clone https://github.com/bex-co/bex-security.git
cd bex-security
pnpm --dir sdk/typescript install --frozen-lockfile
npm ci --prefix plugins/codex-security/mcp-app --no-audit --no-fund
pnpm --dir sdk/typescript run build:plugin
pnpm --dir sdk/typescript run build
./bex-security scan /path/to/repository --agent claude
```

## Authentication

Codex remains the default agent. Run `bex-security login` to sign in with
ChatGPT. With a local SDK installation, run `npx @bex-co/bex-security login`
from your project. In CI, set `OPENAI_API_KEY` or `CODEX_API_KEY` in the scan
environment. Some requests require
[Trusted Access for Cyber](https://chatgpt.com/cyber).

### Choose an agent

To run the same Bex scan workflow through Claude Code instead, use:

```sh
bex-security scan . --agent claude
```

Claude Code owns authentication and advertises its available models and
reasoning levels over ACP. `--auth`, `--codex`, and `--safety-identifier` are
Codex-only options. Claude supports its native provider, Z.AI, and Kimi; other
`--provider` values remain Codex-only. When selecting a native Claude model or
reasoning level, pass values advertised by the installed Claude agent with
`--model` and `--effort`.

To run the Claude ACP agent with GLM through Z.AI:

```sh
export ZAI_API_KEY="<your-zai-api-key>"
bex-security scan . --agent claude --provider zai
```

The Z.AI path defaults to `glm-5.3[1m]`; use `--model glm-5.3` (or another GLM
model supported by your Z.AI account) to override it. The provider settings and
credential apply only to the Claude ACP subprocess. See the
[Z.AI Claude Code guide](https://docs.z.ai/devpack/tool/claude) for account and
model availability details.

To run Kimi models through the Claude ACP agent, set a Kimi API key. This path
defaults to `kimi-for-coding` and accepts `--model k3-256k` or another model
available to the account:

```sh
export KIMI_API_KEY="<your-kimi-api-key>"
bex-security scan . --agent claude --provider kimi
```

The provider credential and Anthropic-compatible settings are scoped to the
Claude subprocess and are not written to Claude Code configuration. See the
[Kimi Claude Code guide](https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html).

Kimi Code can also run as the ACP agent itself. Install it, put `kimi` on
`PATH`, and authenticate once:

```sh
kimi login
bex-security scan . --agent kimi
bex-security scan . --agent kimi --model kimi-code/k3-256k --effort high
```

Native Kimi uses its saved provider configuration and reports its negotiated
model and thinking level over ACP. See the
[Kimi ACP reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp).

Muse Code can run through the Bex-maintained
[`@bex-co/muse-code-acp`](https://github.com/bex-co/muse-code-acp) adapter.
The adapter ships with this package. Install Muse Code, authenticate it, and
select it for the scan:

```sh
muse login
bex-security scan . --agent muse
bex-security scan . --agent muse --model muse-spark-1.2-contributor --effort high
```

Bex forwards explicit Muse model IDs to the adapter, including when its initial
model catalog is deferred. Configuration updates from the running host update
the scan's model metadata. Sequential turns in the same thread reuse the ACP
connection; review assignments retain separate sessions and close them when the
attempt ends. Cancellation and scan completion close owned connections.

Unless `XDG_DATA_HOME` is explicitly set, registered scans use a persistent Muse
data directory under the Bex state directory, keyed by scan ID. This keeps
unrelated personal session history out of native startup work. Authentication
and Muse configuration paths remain unchanged. Retain the scan's agent data to
restore its sessions; switching data directories does not migrate existing
sessions. Native history traversal within a large scan still depends on Muse.

Invalid model configuration stops review recovery immediately. Structured turn
failures, whether or not the turn may have been submitted, receive at most two
attempts of the same read-only assignment before the scan stops with the
original error. Smaller-file recovery continues for incomplete read evidence;
files that still lack it are reported as deferred coverage, never as reviewed.
Binary files are assigned with a request for a shell byte read that names
their path, because some read tools return images without one.

Muse owns authentication and model selection. Bex passes its stdio security
workbench through ACP and uses noninteractive approval handling for automated
assignments. When the adapter reports that delegated workers are unavailable,
Bex uses capability-selected host review
assignments and accepts progress only from completed, non-truncated file reads.

Qwen Code can run through its native ACP mode. Install it, start `qwen`, and
use `/auth` once to configure a provider:

```sh
npm install --global @qwen-code/qwen-code@latest
qwen
bex-security scan . --agent qwen
bex-security scan . --agent qwen --model qwen3-coder-plus --effort high
```

Bex starts `qwen --acp`; Qwen owns authentication and advertises available
models and reasoning levels over ACP.

MiMo Code can likewise run through its native ACP mode. Install it and finish
its first-run provider setup before scanning:

```sh
npm install --global @mimo-ai/cli
mimo
bex-security scan . --agent mimo
bex-security scan . --agent mimo --model xiaomi/mimo-v2.5-pro --effort high
```

Bex starts `mimo acp` and preserves MiMo's current primary agent mode. MiMo
publishes reasoning choices as model variants, so `--effort` selects the
matching advertised variant or fails with the available choices.

## CLI

Run a scan from the repository you want to review.

```sh
bex-security scan .
```

To scan only committed changes from `origin/main` to `HEAD`, run
`bex-security scan . --diff origin/main`. A completed scan exits with code `0`
by default, even when it finds vulnerabilities. Add `--fail-on-severity high`
to exit with code `1` for high or critical findings.

## Run a scan from TypeScript

Run this ES module from the repository you want to scan.

```ts
import { CodexSecurity } from "@bex-co/bex-security";

const security = new CodexSecurity();
try {
  const result = await security.run(".");
  console.log(result.reportPath);
  console.log(`${result.findings.findings.length} findings`);
} finally {
  await security.close();
}
```

### Select an agent from TypeScript

The SDK uses the same agents as the CLI. Pass these constructor options in
addition to those in the
[SDK guide](https://github.com/bex-co/bex-security/blob/main/sdk/typescript/docs/sdk.md#configure-the-client):

| Option           | Description                                                                        |
| ---------------- | ---------------------------------------------------------------------------------- |
| `agent`          | Select `"codex"` (default), `"claude"`, `"kimi"`, `"muse"`, `"qwen"`, or `"mimo"`. |
| `claudeProvider` | Select `"zai"` or `"kimi"` to route the Claude agent through that provider.        |

### Read results

By default, results are saved in the private Bex Security state directory.
Open the Markdown report at the CLI’s **REPORT** path or the SDK’s
`result.reportPath`. Reports and logs can contain source code, credentials, and
vulnerability details. Review them before sharing.

## Host-review diagnostics

When an ACP agent cannot delegate workers, Bex manages review assignments and
saves diagnostics inside the existing scan output directory once the review
inventory has been generated and validated. Inventory/setup failures happen
before this assignment-diagnostic stage.

| Artifact                                                               | Contents                                                                                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts/01_context/host-review/inventory.json`                      | Registered review inventory.                                                                                                          |
| `artifacts/01_context/host-review/assignment-N-attempt-M/request.json` | Files requested, saved before agent startup.                                                                                          |
| `artifacts/01_context/host-review/assignment-N-attempt-M/result.json`  | Attempt phase, completed read evidence, claimed files, response validity, terminal status, unvalidated candidates and failure reason. |
| `artifacts/01_context/host-review/assignment-N.json`                   | Combined assignment outcome, remaining files and number of attempts.                                                                  |
| `artifacts/01_context/host-review/incomplete-review.json`              | Partial coverage, missing files, assignment history and unvalidated candidates after failure or cancellation.                         |
| `incomplete-report.md`                                                 | Readable incomplete-scan summary linking to the diagnostics.                                                                          |

Host reviews that verify at least one file produce `review.json` for the
coordinator. Files that still lack read evidence after recovery are listed
under its `uncoveredFiles` and recorded as deferred coverage, so the scan
completes with partial coverage instead of failing. Verified files are
checkpointed under the state directory's `host-review-checkpoints/`; rerunning
the same scan reuses those whose contents are unchanged, and the checkpoint is
removed after a scan completes with full coverage. Only the
normal validation/reporting workflow produces the canonical `report.md`.
An incomplete summary does not turn failure into success: SDK calls still reject,
CLI commands still exit nonzero, and coverage requirements remain unchanged.
Candidates from incomplete or failed attempts are evidence for later investigation,
not confirmed findings. Repeated candidates may appear in the attempt history.

Requests and terminal results are saved independently so completed attempts survive
a later failure. A request without a result has no recorded terminal outcome;
it does not prove the model ran or that files were read. Abrupt process termination
may prevent the final JSON and Markdown summary from being written. Diagnostic
write failures are warnings and do not replace the original scan error or stop an
otherwise successful review. SDK users receive these notices through `onWarning`;
the CLI displays them with its existing scan warnings.

Use the existing `--output-dir` (SDK: `outputDir`) to select a persistent directory
outside the target repository, or keep the existing default persistent scan-state
location. An explicit temporary directory can be removed by the operating system;
Bex does not back up diagnostics elsewhere. Container users should retain the
existing output/state volume. These local files can contain target paths and
candidate details; review them before sharing, as with other scan artifacts.

## Local security model

Scans run with your operating-system permissions. Start them with only the
credentials they need because subprocesses can inherit your environment.

## Documentation and security

- [CLI reference](https://github.com/bex-co/bex-security/blob/main/sdk/typescript/docs/cli.md) for scan options, authentication, and exports.
- [SDK guide](https://github.com/bex-co/bex-security/blob/main/sdk/typescript/docs/sdk.md) for configuration, progress events, and the full set of examples.
- [Upstream Codex Security documentation](https://learn.chatgpt.com/docs/security/cli) for upstream behavior this fork keeps.
- [Security policy](https://github.com/bex-co/bex-security/blob/main/SECURITY.md) for reporting vulnerabilities in this package privately.
