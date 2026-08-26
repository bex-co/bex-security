import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import {
  AcpAgentClient,
  AcpCodex,
  pluginMcpServers,
  withoutCodexProviderCredentials,
} from "../src/acp-adapter.js";

const AGENT_PATH = fileURLToPath(
  new URL("./fixtures/acp-agent.mjs", import.meta.url),
);

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
    const thread = new AcpAgentClient(
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
    const thread = new AcpAgentClient(
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
    const thread = new AcpAgentClient(
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
