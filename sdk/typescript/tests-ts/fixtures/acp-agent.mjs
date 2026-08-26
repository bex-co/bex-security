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

const app = agent({ name: "bex-security-test-agent" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { resume: {} },
    },
  }))
  .onRequest(methods.agent.session.new, () => ({
    sessionId: "thread-acp",
    configOptions,
  }))
  .onRequest(methods.agent.session.resume, () => {
    resumed = true;
    return { configOptions };
  })
  .onRequest(methods.agent.session.setMode, () => ({}))
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
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
          rawInput: { command: "printf test", cwd: process.cwd() },
        },
      });
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "command-1",
          status: "completed",
          rawOutput: { formatted_output: "test", exit_code: 0 },
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
