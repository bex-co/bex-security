import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { ConfigurationError } from "../src/errors.js";
import {
  AcpAgentClient,
  AcpCodex,
  pluginMcpServers,
  museEnvironment,
  shellCodexPath,
  withoutCodexProviderCredentials,
} from "../src/acp-adapter.js";

const AGENT_PATH = fileURLToPath(
  new URL("./fixtures/acp-agent.mjs", import.meta.url),
);
const APP_SERVER_PATH = fileURLToPath(
  new URL("./fixtures/codex-app-server.mjs", import.meta.url),
);

const clients: AcpAgentClient[] = [];
function agentClient(...args: ConstructorParameters<typeof AcpAgentClient>) {
  const instance = new AcpAgentClient(...args);
  clients.push(instance);
  return instance;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function collect(events: AsyncGenerator<ThreadEvent>) {
  return await Array.fromAsync(events);
}

function completedMessage(events: ThreadEvent[]): string | undefined {
  for (const event of events) {
    if (
      event.type === "item.completed" &&
      event.item.type === "agent_message"
    ) {
      return event.item.text;
    }
  }
  return undefined;
}

describe("ACP adapter", () => {
  test.each(["inherited", "override"] as const)(
    "uses the %s Codex executable for concurrent fresh and resumed turns",
    async (selection) => {
      await Promise.all(
        ["first", "second"].map(async (scan) => {
          const selected = join(tmpdir(), scan, "selected runtime", "codex");
          const override = join(tmpdir(), scan, "explicit runtime", "codex");
          const client = agentClient(
            {
              env: {
                ...process.env,
                CODEX_CLI_PATH: selected,
                CODEX_PATH: join(tmpdir(), "ambient runtime", "codex"),
                BEX_TEST_EXPECT_CODEX_PATH:
                  selection === "override" ? override : selected,
              },
              ...(selection === "override"
                ? { codexPathOverride: override }
                : {}),
            },
            { agent: "codex" },
            AGENT_PATH,
          );
          const thread = client.startThread({
            workingDirectory: process.cwd(),
          });
          expect((await thread.run("first turn")).finalResponse).toBe(
            "new:reject",
          );
          expect((await thread.run("second turn")).finalResponse).toBe(
            "resumed:reject",
          );
        }),
      );
    },
  );

  test("forwards native command authentication overrides to Codex ACP", async () => {
    const config = {
      model_provider: "synthetic",
      model_providers: {
        synthetic: {
          name: "Synthetic provider",
          base_url: "https://example.invalid/v1",
          auth: { command: "synthetic-auth", args: ["token"] },
        },
      },
    };
    const thread = new AcpCodex(
      {
        env: {
          ...process.env,
          BEX_TEST_EXPECT_CODEX_CONFIG: JSON.stringify(config),
        },
        config: { model_provider: "synthetic" },
        configOverrides: [
          'model_providers={synthetic={name="Synthetic provider",base_url="https://example.invalid/v1",auth={command="synthetic-auth",args=["token"]}}}',
        ],
      },
      AGENT_PATH,
    ).startThread({ workingDirectory: process.cwd() });
    expect((await thread.run("scan the repository")).finalResponse).toBe(
      "new:reject",
    );
  });

  test("negotiates namespaced agent capabilities", async () => {
    const capabilities = await agentClient(
      { env: { ...process.env, BEX_TEST_AGENT: "muse" } },
      { agent: "muse" },
      AGENT_PATH,
    ).capabilities();

    expect(capabilities).toEqual({
      delegatedWorkers: false,
      usage: "unavailable",
      interactivePermissions: false,
    });
  });

  test("keeps unadvertised capabilities unknown", async () => {
    const capabilities = await agentClient(
      {},
      { agent: "claude" },
      AGENT_PATH,
    ).capabilities();

    expect(capabilities).toEqual({
      delegatedWorkers: null,
      usage: "unknown",
      interactivePermissions: null,
    });
  });

  test("streams ACP messages, permissions, tools, and usage as Codex events", async () => {
    const thread = new AcpCodex({}, AGENT_PATH).startThread({
      workingDirectory: process.cwd(),
    });

    const events = await collect(
      (await thread.runStreamed("scan the repository")).events,
    );

    expect(thread.id).toBe("thread-acp");
    expect(events[0]).toEqual({
      type: "thread.started",
      thread_id: "thread-acp",
    });
    expect(events).toContainEqual({
      type: "item.completed",
      item: {
        id: "command-1",
        type: "command_execution",
        command: "printf test",
        aggregated_output: "test",
        exit_code: 0,
        status: "completed",
      },
    });
    expect(completedMessage(events)).toBe("new:reject");
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      usage: {
        input_tokens: 6,
        cached_input_tokens: 2,
        cache_write_input_tokens: 0,
        output_tokens: 4,
        reasoning_output_tokens: 1,
      },
    });
  });

  test("resumes the ACP session for a second turn", async () => {
    const thread = new AcpCodex({}, AGENT_PATH).startThread({
      workingDirectory: process.cwd(),
    });
    await collect((await thread.runStreamed("first turn")).events);

    const events = await collect(
      (await thread.runStreamed("second turn")).events,
    );

    expect(thread.id).toBe("thread-acp");
    expect(completedMessage(events)).toBe("resumed:reject");
  });

  test("forwards turn cancellation through ACP", async () => {
    const controller = new AbortController();
    const thread = new AcpCodex({}, AGENT_PATH).startThread({
      workingDirectory: process.cwd(),
    });
    const { events } = await thread.runStreamed("wait for cancellation", {
      signal: controller.signal,
    });
    const iterator = events[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({
      type: "thread.started",
      thread_id: "thread-acp",
    });
    controller.abort();
    const remaining: ThreadEvent[] = [];
    for (;;) {
      const result = await iterator.next();
      if (result.done) break;
      remaining.push(result.value);
    }

    expect(remaining.at(-1)).toEqual({
      type: "turn.failed",
      error: { message: "ACP agent stopped the turn: cancelled" },
    });
  });

  test("selects Claude through the same ACP runtime and negotiates config options", async () => {
    const thread = agentClient(
      {},
      { agent: "claude", model: "sonnet", reasoningEffort: "high" },
      AGENT_PATH,
    ).startThread({ workingDirectory: process.cwd() });

    const events = await collect(
      (await thread.runStreamed("scan with claude")).events,
    );

    expect(thread.id).toBe("thread-acp");
    expect(thread.modelConfiguration).toEqual({
      model: "sonnet",
      reasoningEffort: "high",
    });
    expect(completedMessage(events)).toBe("new:allow");
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  test("reports the resolved model behind a Claude model alias", async () => {
    const thread = agentClient(
      {},
      {
        agent: "claude",
        model: "sonnet",
        resolvedModel: "glm-5.3[1m]",
        reasoningEffort: "high",
      },
      AGENT_PATH,
    ).startThread({ workingDirectory: process.cwd() });

    await collect((await thread.runStreamed("scan with GLM")).events);

    expect(thread.modelConfiguration).toEqual({
      model: "glm-5.3[1m]",
      reasoningEffort: "high",
    });
  });

  test("runs native Kimi through ACP and maps Codex effort names", async () => {
    const thread = agentClient(
      {},
      {
        agent: "kimi",
        model: "kimi-code/k3-256k",
        reasoningEffort: "xhigh",
      },
      AGENT_PATH,
    ).startThread({ workingDirectory: process.cwd() });

    const events = await collect(
      (await thread.runStreamed("scan with Kimi")).events,
    );

    expect(thread.modelConfiguration).toEqual({
      model: "kimi-code/k3-256k",
      reasoningEffort: "max",
    });
    expect(completedMessage(events)).toBe("new:allow");
  });

  test("runs Qwen through ACP and negotiates its model and effort", async () => {
    const thread = agentClient(
      {
        env: {
          ...process.env,
          BEX_TEST_EXPECT_PROMPT: "keep the target source read-only",
        },
      },
      {
        agent: "qwen",
        model: "qwen3-coder-plus",
        reasoningEffort: "high",
      },
      AGENT_PATH,
    ).startThread({ workingDirectory: process.cwd() });

    const events = await collect(
      (await thread.runStreamed("scan with Qwen")).events,
    );

    expect(thread.modelConfiguration).toEqual({
      model: "qwen3-coder-plus",
      reasoningEffort: "high",
    });
    expect(completedMessage(events)).toBe("new:allow");
  });

  test("maps MiMo effort to an advertised model variant", async () => {
    const thread = agentClient(
      {
        env: {
          ...process.env,
          BEX_TEST_AGENT: "mimo",
          BEX_TEST_REJECT_MODE_CONFIG: "1",
          BEX_TEST_EXPECT_PROMPT: "keep the target source read-only",
        },
      },
      { agent: "mimo", reasoningEffort: "high" },
      AGENT_PATH,
    ).startThread({ workingDirectory: process.cwd() });

    const events = await collect(
      (await thread.runStreamed("scan with MiMo")).events,
    );

    expect(thread.modelConfiguration).toEqual({
      model: "xiaomi/mimo-v2.5-pro/high",
      reasoningEffort: "high",
    });
    expect(completedMessage(events)).toBe("new:allow");
  });

  test("reports unavailable MiMo effort variants", async () => {
    const thread = agentClient(
      {
        env: { ...process.env, BEX_TEST_AGENT: "mimo" },
      },
      { agent: "mimo", reasoningEffort: "max" },
      AGENT_PATH,
    ).startThread({ workingDirectory: process.cwd() });

    await expect(
      collect((await thread.runStreamed("scan with MiMo")).events),
    ).rejects.toThrow(
      'MiMo ACP does not offer effort "max" for model "xiaomi/mimo-v2.5-pro". Available variants: low, high.',
    );
  });

  test("switches between advertised MiMo effort variants", async () => {
    const thread = agentClient(
      {
        env: { ...process.env, BEX_TEST_AGENT: "mimo" },
      },
      {
        agent: "mimo",
        model: "xiaomi/mimo-v2.5-pro/low",
        reasoningEffort: "high",
      },
      AGENT_PATH,
    ).startThread({ workingDirectory: process.cwd() });

    await collect((await thread.runStreamed("scan with MiMo")).events);

    expect(thread.modelConfiguration).toEqual({
      model: "xiaomi/mimo-v2.5-pro/high",
      reasoningEffort: "high",
    });
  });

  test.each([
    ["qwen", "Qwen Code"],
    ["mimo", "MiMo Code"],
  ] as const)("reports missing %s executables", async (agent, label) => {
    await expect(
      agentClient({ env: { PATH: "" } }, { agent }).capabilities(),
    ).rejects.toThrow(`${label} CLI was not found on PATH`);
  });

  test("adds Qwen authentication setup guidance", async () => {
    await expect(
      agentClient(
        {
          env: { ...process.env, BEX_TEST_AUTH_ERROR: "1" },
        },
        { agent: "qwen" },
        AGENT_PATH,
      ).capabilities(),
    ).rejects.toThrow("configure authentication with `/auth`");
  });

  test("runs Muse through ACP session modes without additional directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "bex-muse-acp-"));
    const repository = join(root, "repository");
    const pluginRoot = join(root, "plugin");
    const scanOutput = join(root, "scan-output");
    await Promise.all([mkdir(repository), mkdir(pluginRoot)]);
    await writeFile(join(repository, ".keep"), "");
    await writeFile(
      join(pluginRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "codex-security": {
            command: process.execPath,
            args: [],
            env: {},
          },
        },
      }),
    );
    try {
      const thread = agentClient(
        {
          env: {
            ...process.env,
            BEX_TEST_AGENT: "muse",
            BEX_TEST_EXPECT_CWD: scanOutput,
            BEX_TEST_EXPECT_MCP_NAME: "bex",
            BEX_TEST_EXPECT_MODE: "readOnly",
            BEX_TEST_EXPECT_PROMPT:
              "Omit optional string fields when no meaningful value is available",
            CODEX_SECURITY_PLUGIN_ROOT: pluginRoot,
            CODEX_SECURITY_REPOSITORY: repository,
          },
        },
        {
          agent: "muse",
          model: "muse-spark-1.2",
          reasoningEffort: "high",
        },
        AGENT_PATH,
      ).startThread({
        workingDirectory: scanOutput,
        additionalDirectories: [tmpdir()],
        sandboxMode: "read-only",
      });

      const events = await collect(
        (await thread.runStreamed("scan with Muse")).events,
      );

      expect(thread.modelConfiguration).toEqual({
        model: "muse-spark-1.2",
        reasoningEffort: "high",
      });
      expect(events as unknown[]).toContainEqual({
        type: "item.completed",
        item: {
          id: "command-1",
          type: "command_execution",
          command: "printf test",
          aggregated_output:
            'CODEX_SECURITY_SCAN_PROGRESS {"phase":"discovery","filesCompleted":1,"filesTotal":2}\n',
          exit_code: 0,
          output_truncated: false,
          status: "completed",
        },
      });
      expect(completedMessage(events)).toBe("new:allow");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bypasses unanswerable Muse approvals while keeping its sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "bex-muse-mode-"));
    try {
      const thread = agentClient(
        {
          env: {
            ...process.env,
            BEX_TEST_AGENT: "muse",
            BEX_TEST_EXPECT_CWD: root,
            BEX_TEST_EXPECT_MODE: "bypassApprovals",
          },
        },
        { agent: "muse" },
        AGENT_PATH,
      ).startThread({
        workingDirectory: root,
        sandboxMode: "workspace-write",
      });

      const events = await collect(
        (await thread.runStreamed("scan with Muse")).events,
      );

      expect(events.at(-1)?.type).toBe("turn.completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps model credentials out of the Claude workbench MCP process", async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), "bex-acp-plugin-"));
    try {
      await writeFile(
        join(pluginRoot, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            workbench: {
              command: process.execPath,
              env_vars: [
                "PYTHON",
                "CODEX_API_KEY",
                "OPENROUTER_API_KEY",
                "FIREWORKS_API_KEY",
                "ZAI_API_KEY",
                "KIMI_API_KEY",
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "AWS_ACCESS_KEY_ID",
              ],
            },
          },
        }),
      );

      const [server] = await pluginMcpServers({
        env: {
          CODEX_SECURITY_PLUGIN_ROOT: pluginRoot,
          PYTHON: "/managed/python",
          CODEX_API_KEY: "synthetic-codex-key",
          OPENROUTER_API_KEY: "synthetic-openrouter-key",
          FIREWORKS_API_KEY: "synthetic-fireworks-key",
          ZAI_API_KEY: "synthetic-zai-key",
          KIMI_API_KEY: "synthetic-kimi-key",
          ANTHROPIC_API_KEY: "synthetic-anthropic-key",
          ANTHROPIC_AUTH_TOKEN: "synthetic-anthropic-token",
          AWS_ACCESS_KEY_ID: "synthetic-aws-key",
        },
      });

      expect(
        server !== undefined && "env" in server ? server.env : undefined,
      ).toEqual([{ name: "PYTHON", value: "/managed/python" }]);
    } finally {
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  test("keeps Kimi credentials out of generic ACP agent environments", () => {
    expect(
      withoutCodexProviderCredentials({
        PATH: "/synthetic/bin",
        KIMI_API_KEY: "synthetic-kimi-key",
        CODEX_API_KEY: "synthetic-codex-key",
      }),
    ).toEqual({ PATH: "/synthetic/bin" });
  });
});

test.each([
  ["\\\\?\\C:\\tools\\node.exe", "C:\\tools\\node.exe"],
  ["\\\\?\\UNC\\server\\share\\codex.exe", "\\\\server\\share\\codex.exe"],
  ["C:\\tools\\codex.cmd", "C:\\tools\\codex.cmd"],
] as const)(
  "passes cmd.exe a non-namespaced Codex path for %s",
  (namespaced, expected) => {
    expect(shellCodexPath(namespaced, "win32")).toBe(expected);
    expect(shellCodexPath(namespaced, "linux")).toBe(namespaced);
  },
);

describe("Codex app-server sign-in", () => {
  // codex-acp runs `CODEX_PATH app-server`, here the synthetic app-server.
  async function appServerLauncher(directory: string): Promise<string> {
    if (process.platform === "win32") {
      const launcher = join(directory, "codex.cmd");
      await writeFile(
        launcher,
        `@"${process.execPath}" "${APP_SERVER_PATH}" %*\r\n`,
      );
      return launcher;
    }
    const launcher = join(directory, "codex");
    await writeFile(
      launcher,
      `#!/bin/sh\nexec '${process.execPath}' '${APP_SERVER_PATH}' "$@"\n`,
      { mode: 0o700 },
    );
    return launcher;
  }

  async function signIn(options: { apiKey?: string; signedIn?: boolean }) {
    const root = await mkdtemp(join(tmpdir(), "bex-app-server-"));
    try {
      const traceFile = join(root, "trace.jsonl");
      const codexHome = join(root, "codex-home");
      await mkdir(codexHome);
      const launcher = await appServerLauncher(root);
      const client = agentClient(
        {
          codexPathOverride: launcher,
          ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) =>
                /^(path|pathext|systemroot|comspec|temp|tmp|tmpdir)$/iu.test(
                  key,
                ),
              ),
            ),
            CODEX_HOME: codexHome,
            OPENAI_API_KEY: "synthetic-ambient-key",
            BEX_TEST_APP_SERVER_TRACE: traceFile,
            ...(options.signedIn ? { BEX_TEST_APP_SERVER_SIGNED_IN: "1" } : {}),
          },
        },
        { agent: "codex" },
      );
      const thread = client.startThread({
        workingDirectory: root,
        skipGitRepoCheck: true,
      });
      await thread.run("scan the repository");
      await client.close();
      const trace = (await readFile(traceFile, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              argv?: string[];
              codexPath?: string | null;
              login?: unknown;
            },
        );
      const started = trace.filter((entry) => entry.argv !== undefined);
      expect(started.length).toBeGreaterThan(0);
      return {
        launcher,
        started,
        logins: trace.flatMap((entry) =>
          entry.login === undefined ? [] : [entry.login],
        ),
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("signs in with the scan API key without saving it", async () => {
    const { launcher, started, logins } = await signIn({
      apiKey: "synthetic-scan-key",
    });
    expect(logins).toEqual([{ type: "apiKey", apiKey: "synthetic-scan-key" }]);
    for (const { argv, codexPath } of started) {
      expect(argv).toEqual([
        "app-server",
        "-c",
        "cli_auth_credentials_store=ephemeral",
      ]);
      expect(codexPath).not.toBe(launcher);
    }
    // The private launcher is removed once codex-acp exits.
    const launchers = started.map(({ codexPath }) => dirname(codexPath!));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (launchers.every((directory) => !existsSync(directory))) break;
      await Bun.sleep(20);
    }
    for (const directory of launchers)
      expect(existsSync(directory)).toBe(false);
  });

  test.each([
    ["without an API key", undefined],
    ["with an empty API key", ""],
  ] as const)("keeps the saved sign-in %s", async (_case, apiKey) => {
    const { launcher, started, logins } = await signIn({
      ...(apiKey === undefined ? {} : { apiKey }),
      signedIn: true,
    });
    // An ambient OPENAI_API_KEY must not replace the saved sign-in.
    expect(logins).toEqual([]);
    for (const { argv, codexPath } of started) {
      expect(argv).toEqual(["app-server"]);
      expect(codexPath).toBe(launcher);
    }
  });
});

describe("Muse session configuration", () => {
  test("selects manual models with a deferred catalog and on resume", async () => {
    const thread = agentClient(
      {
        env: {
          ...process.env,
          BEX_TEST_AGENT: "muse",
          BEX_TEST_MUSE_LAZY_MODELS: "1",
          BEX_TEST_EXPECT_MODEL: "alternate",
        },
      },
      { agent: "muse", model: "alternate", reasoningEffort: "high" },
      AGENT_PATH,
    ).startThread();
    for (let turn = 0; turn < 2; turn++) {
      const result = await thread.run("synthetic review");
      expect(result.finalResponse).toContain(":allow");
      expect(thread.modelConfiguration).toEqual({
        model: "alternate",
        reasoningEffort: "high",
      });
      await thread.close();
    }
  });

  test("isolates scan history while keeping configuration and explicit data roots", () => {
    const env = {
      HOME: join(tmpdir(), "synthetic-home"),
      XDG_CONFIG_HOME: join(tmpdir(), "synthetic-config"),
      CODEX_SECURITY_STATE_DIR: join(tmpdir(), "synthetic-state"),
      CODEX_SECURITY_SCAN_ID: "scan/one",
    };
    const first = museEnvironment(env);
    expect(first["XDG_DATA_HOME"]).toBe(
      join(
        env.CODEX_SECURITY_STATE_DIR,
        "agent-data",
        "muse",
        "scan-scan%2Fone",
      ),
    );
    expect(museEnvironment({ ...env })["XDG_DATA_HOME"]).toBe(
      first["XDG_DATA_HOME"],
    );
    expect(
      museEnvironment({ ...env, CODEX_SECURITY_SCAN_ID: "two" })[
        "XDG_DATA_HOME"
      ],
    ).not.toBe(first["XDG_DATA_HOME"]);
    expect(first["HOME"]).toBe(env["HOME"]);
    expect(first["XDG_CONFIG_HOME"]).toBe(env["XDG_CONFIG_HOME"]);
    expect(
      museEnvironment({ ...env, XDG_DATA_HOME: "explicit" })["XDG_DATA_HOME"],
    ).toBe("explicit");
    expect(
      museEnvironment({ HOME: env["HOME"] })["XDG_DATA_HOME"],
    ).toBeUndefined();
  });
});

test("Muse keeps a connection for sequential turns and closes it explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "bex-acp-lifecycle-"));
  const trace = join(root, "requests.jsonl");
  const client = agentClient(
    { env: { ...process.env, BEX_TEST_AGENT: "muse", BEX_TEST_TRACE: trace } },
    { agent: "muse" },
    AGENT_PATH,
  );
  const thread = client.startThread();
  try {
    await thread.run("first synthetic turn");
    await thread.run("second synthetic turn");
    const requests = (await readFile(trace, "utf8")).trim().split("\n");
    expect(requests.filter((method) => method === "initialize")).toHaveLength(
      1,
    );
    expect(requests.filter((method) => method === "prompt")).toHaveLength(2);
    expect(requests).not.toContain("resume");
    await thread.close();
    await thread.run("restored synthetic turn");
    const restored = (await readFile(trace, "utf8")).trim().split("\n");
    expect(restored.filter((method) => method === "initialize")).toHaveLength(
      2,
    );
    expect(restored.filter((method) => method === "resume")).toHaveLength(1);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Muse observes model configuration updates from its execution host", async () => {
  const thread = agentClient(
    {
      env: {
        ...process.env,
        BEX_TEST_AGENT: "muse",
        BEX_TEST_LATE_CONFIG: "1",
      },
    },
    { agent: "muse", model: "alternate", reasoningEffort: "high" },
    AGENT_PATH,
  ).startThread();
  await thread.run("synthetic review");
  expect(thread.modelConfiguration).toEqual({
    model: "alternate",
    reasoningEffort: "max",
  });
});

for (const interruption of ["cancel", "return", "close"] as const) {
  test(`Muse cleans up its process after stream ${interruption}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "bex-acp-interruption-"));
    const trace = join(root, "requests.jsonl");
    const controller = new AbortController();
    const client = agentClient(
      {
        env: { ...process.env, BEX_TEST_AGENT: "muse", BEX_TEST_TRACE: trace },
      },
      { agent: "muse" },
      AGENT_PATH,
    );
    const thread = client.startThread();
    try {
      const { events } = await thread.runStreamed("wait for cancellation", {
        signal: controller.signal,
      });
      expect((await events.next()).value?.type).toBe("thread.started");
      if (interruption === "cancel") controller.abort();
      if (interruption === "return") await events.return(undefined);
      if (interruption === "close") await thread.close();
      try {
        await collect(events);
      } catch {
        /* Closing an active request can reject it. */
      }
      expect((await readFile(trace, "utf8")).trim().split("\n")).toContain(
        "exit",
      );
      await thread.run("explicit next turn");
      expect(
        (await readFile(trace, "utf8"))
          .trim()
          .split("\n")
          .filter((method) => method === "initialize"),
      ).toHaveLength(2);
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("turn failures include the agent's error detail", async () => {
  const thread = agentClient(
    {
      env: {
        ...process.env,
        BEX_TEST_USAGE_LIMIT: "Synthetic usage limit reached.",
      },
    },
    { agent: "codex" },
    AGENT_PATH,
  ).startThread({ workingDirectory: process.cwd() });
  await expect(thread.run("synthetic scan")).rejects.toThrow(
    "Internal error: Synthetic usage limit reached.",
  );
});

test("Muse invalid model errors retain the protocol cause for review classification", async () => {
  const thread = agentClient(
    {
      env: {
        ...process.env,
        BEX_TEST_AGENT: "muse",
        BEX_TEST_INVALID_MODEL: "1",
      },
    },
    { agent: "muse", model: "unknown" },
    AGENT_PATH,
  ).startThread();
  try {
    await thread.run("synthetic review");
    throw new Error("expected model validation failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).cause).toMatchObject({
      code: -32602,
      data: { failure: { execution: "notSubmitted" } },
    });
  }
});
