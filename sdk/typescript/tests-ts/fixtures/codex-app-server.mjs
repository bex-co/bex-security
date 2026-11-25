#!/usr/bin/env node
// A minimal `codex app-server` for driving the real codex-acp bridge.
// It records its arguments and sign-in requests, then completes each turn.
import { appendFileSync } from "node:fs";

const trace = (entry) => {
  if (process.env.BEX_TEST_APP_SERVER_TRACE)
    appendFileSync(
      process.env.BEX_TEST_APP_SERVER_TRACE,
      JSON.stringify(entry) + "\n",
    );
};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => send({ method, params });

trace({
  argv: process.argv.slice(2),
  codexPath: process.env.CODEX_PATH ?? null,
});

// A saved sign-in, as the shared Codex home would provide.
let account = process.env.BEX_TEST_APP_SERVER_SIGNED_IN
  ? { type: "chatgpt", email: "synthetic@example.invalid", planType: "plus" }
  : null;
const thread = {
  id: "app-server-thread",
  preview: "",
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 0,
  updatedAt: 0,
  status: { type: "idle" },
  path: null,
  cwd: process.cwd(),
  cliVersion: "0.0.0",
  source: "appServer",
  gitInfo: null,
  turns: [],
};
const model = {
  id: "synthetic-model",
  model: "synthetic-model",
  displayName: "Synthetic model",
  description: "Synthetic model",
  isDefault: true,
  hidden: false,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Medium" },
  ],
};
const handlers = {
  initialize: () => ({
    userAgent: "synthetic-app-server/0.0.0",
    codexHome: process.env.CODEX_HOME ?? null,
    platformFamily: process.platform === "win32" ? "windows" : "unix",
    platformOs: process.platform,
  }),
  "account/read": () => ({ account, requiresOpenaiAuth: true }),
  "account/login/start": (params) => {
    trace({ login: params });
    account = { type: "apiKey" };
    setTimeout(() => {
      notify("account/login/completed", {
        loginId: null,
        success: true,
        error: null,
      });
      notify("account/updated", { authMode: "apikey" });
    }, 5);
    return { type: "apiKey" };
  },
  "model/list": () => ({ data: [model], nextCursor: null }),
  "thread/start": () => ({
    thread,
    model: model.id,
    modelProvider: "openai",
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: { type: "readOnly" },
    reasoningEffort: null,
  }),
  "turn/start": () => {
    const turn = { id: "app-server-turn", items: [], status: "inProgress" };
    const turnError = process.env.BEX_TEST_APP_SERVER_TURN_ERROR
      ? JSON.parse(process.env.BEX_TEST_APP_SERVER_TURN_ERROR)
      : null;
    setTimeout(() => {
      notify("turn/started", { threadId: thread.id, turn });
      if (turnError !== null) {
        notify("turn/completed", {
          threadId: thread.id,
          turn: {
            ...turn,
            status: "failed",
            error: {
              message: turnError.message,
              codexErrorInfo: turnError.codexErrorInfo ?? null,
              additionalDetails: turnError.additionalDetails ?? null,
              misalignment: null,
            },
          },
        });
      } else {
        notify("turn/completed", {
          threadId: thread.id,
          turn: { ...turn, status: "completed" },
        });
      }
    }, 5);
    return { turn };
  },
};

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (
    let index = buffer.indexOf("\n");
    index >= 0;
    index = buffer.indexOf("\n")
  ) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    const message = JSON.parse(line);
    if (message.id === undefined || message.method === undefined) continue;
    const handler = handlers[message.method];
    send({ id: message.id, result: handler ? handler(message.params) : {} });
  }
});
process.stdin.on("end", () => process.exit(0));
