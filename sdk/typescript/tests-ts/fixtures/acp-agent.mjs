#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  agent,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

let resumed = false;

let configOptions = [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [{ value: "default", name: "Manual" }],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "sonnet", name: "Sonnet" },
      { value: "kimi-code/k3-256k", name: "K3-256k" },
      { value: "muse-spark-1.2", name: "Muse Spark 1.2" },
      { value: "qwen3-coder-plus", name: "Qwen3 Coder Plus" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

if (process.env.BEX_TEST_AGENT === "muse") {
  configOptions = configOptions.filter((option) => option.category !== "mode");
}

if (process.env.BEX_TEST_AGENT === "mimo") {
  configOptions = [
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: "build",
      options: [
        { value: "build", name: "build" },
        { value: "plan", name: "plan" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "xiaomi/mimo-v2.5-pro",
      options: [
        { value: "xiaomi/mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
        {
          value: "xiaomi/mimo-v2.5-pro/low",
          name: "MiMo V2.5 Pro (low)",
        },
        {
          value: "xiaomi/mimo-v2.5-pro/high",
          name: "MiMo V2.5 Pro (high)",
        },
      ],
    },
  ];
}

const app = agent({ name: "bex-security-test-agent" })
  .onRequest(methods.agent.initialize, () => {
    if (process.env.BEX_TEST_AUTH_ERROR) {
      process.stderr.write("authentication required\n");
      throw new Error("authentication required");
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        sessionCapabilities: { resume: {} },
      },
      ...(process.env.BEX_TEST_AGENT === "muse"
        ? {
            _meta: {
              "bex.security/capabilities": {
                delegatedWorkers: false,
                usage: "unavailable",
                interactivePermissions: false,
              },
            },
          }
        : {}),
    };
  })
  .onRequest(methods.agent.session.new, ({ params }) => {
    if (
      process.env.BEX_TEST_EXPECT_CWD &&
      params.cwd !== process.env.BEX_TEST_EXPECT_CWD
    ) {
      throw new Error(`unexpected cwd: ${params.cwd}`);
    }
    if (
      process.env.BEX_TEST_EXPECT_MCP_NAME &&
      params.mcpServers[0]?.name !== process.env.BEX_TEST_EXPECT_MCP_NAME
    ) {
      throw new Error(`unexpected MCP name: ${params.mcpServers[0]?.name}`);
    }
    return {
      sessionId: "thread-acp",
      configOptions,
    };
  })
  .onRequest(methods.agent.session.resume, () => {
    resumed = true;
    return { configOptions };
  })
  .onRequest(methods.agent.session.setMode, ({ params }) => {
    if (
      process.env.BEX_TEST_EXPECT_MODE &&
      params.modeId !== process.env.BEX_TEST_EXPECT_MODE
    ) {
      throw new Error(`unexpected mode: ${params.modeId}`);
    }
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    if (process.env.BEX_TEST_REJECT_MODE_CONFIG && params.configId === "mode") {
      throw new Error("mode configuration must remain unchanged");
    }
    configOptions = configOptions.map((option) =>
      option.id === params.configId
        ? { ...option, currentValue: params.value }
        : option,
    );
    return { configOptions };
  })
  .onRequest(
    methods.agent.session.prompt,
    async ({ params, client, signal }) => {
      const text = params.prompt
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (
        process.env.BEX_TEST_EXPECT_PROMPT &&
        !text.includes(process.env.BEX_TEST_EXPECT_PROMPT)
      ) {
        throw new Error(
          `prompt did not contain: ${process.env.BEX_TEST_EXPECT_PROMPT}`,
        );
      }
      if (text === "wait for cancellation") {
        if (!signal.aborted) {
          await new Promise((resolve) =>
            signal.addEventListener("abort", resolve, { once: true }),
          );
        }
        return { stopReason: "cancelled" };
      }
      const permission = await client.request(
        methods.client.session.requestPermission,
        {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: "command-1",
            title: "Run test command",
            kind: "execute",
            status: "pending",
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      );
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "command-1",
          title: "printf test",
          kind: "execute",
          status: "in_progress",
          ...(process.env.BEX_TEST_AGENT === "muse"
            ? { rawInput: { command: "printf test" } }
            : { rawInput: { command: "printf test", cwd: process.cwd() } }),
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "command-1",
          status: "completed",
          rawOutput:
            process.env.BEX_TEST_AGENT === "muse"
              ? {
                  command: "printf test",
                  formatted_output:
                    'CODEX_SECURITY_SCAN_PROGRESS {"phase":"discovery","filesCompleted":1,"filesTotal":2}\n',
                  exit_code: 0,
                  truncated: false,
                }
              : { formatted_output: "test", exit_code: 0 },
        },
      });
      const responseText = `${resumed ? "resumed" : "new"}:${permission.outcome.outcome === "selected" ? permission.outcome.optionId : "cancelled"}`;
      for (const chunk of [responseText.slice(0, 4), responseText.slice(4)]) {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "message-1",
            content: { type: "text", text: chunk },
          },
        });
      }
      return {
        stopReason: "end_turn",
        usage: {
          totalTokens: 10,
          inputTokens: 6,
          outputTokens: 4,
          cachedReadTokens: 2,
          thoughtTokens: 1,
        },
      };
    },
  );

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);
await app.connect(stream).closed;
