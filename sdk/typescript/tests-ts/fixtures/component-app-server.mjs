// Loaded through NODE_OPTIONS into every Node process of a component scan.
// Only the `CODEX_PATH app-server` child acts: it answers codex-acp, writes a
// completed scan for the first main-thread turn, and records what it received.
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

if (basename(process.argv[1] ?? "") === "app-server") {
  const send = (message) =>
    process.stdout.write(JSON.stringify(message) + "\n");
  const notify = (method, params) => send({ method, params });
  const authPath = join(process.env.CODEX_HOME, "auth.json");
  const ephemeral = process.argv.includes(
    "cli_auth_credentials_store=ephemeral",
  );
  let account =
    !ephemeral && existsSync(authPath)
      ? {
          type: "chatgpt",
          email: "synthetic@example.invalid",
          planType: "plus",
        }
      : null;
  let login = null;
  let scanned = false;
  const threads = new Map();
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
  const writeScan = () => {
    const scan = process.env.CODEX_SECURITY_SCAN_DIR;
    cpSync(process.env.BEX_TEST_COMPLETED_SCAN, scan, { recursive: true });
    writeFileSync(join(scan, "report.md"), "# Synthetic scan\n");
    const manifestPath = join(scan, "scan-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.scan.mode = "scoped_path";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const workerConfig = process.env.CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH;
    writeFileSync(
      process.env.BEX_TEST_RECEIPT,
      JSON.stringify({
        executable: process.execPath,
        home: process.env.CODEX_HOME,
        state: process.env.CODEX_SECURITY_STATE_DIR,
        key: process.env.CODEX_API_KEY ?? null,
        login,
        ephemeral,
        auth: existsSync(authPath)
          ? JSON.parse(readFileSync(authPath, "utf8"))
          : null,
        value: process.env.SYNTHETIC_COMPONENT,
        python: process.env.PYTHON,
        workerConfig: workerConfig ? readFileSync(workerConfig, "utf8") : null,
      }),
    );
  };
  const handlers = {
    initialize: () => ({
      userAgent: "synthetic-app-server/0.0.0",
      codexHome: process.env.CODEX_HOME,
      platformFamily: process.platform === "win32" ? "windows" : "unix",
      platformOs: process.platform,
    }),
    "account/read": () => ({ account, requiresOpenaiAuth: true }),
    "account/login/start": (params) => {
      login = params.apiKey ?? null;
      account = { type: "apiKey" };
      setTimeout(
        () =>
          notify("account/login/completed", {
            loginId: null,
            success: true,
            error: null,
          }),
        5,
      );
      return { type: "apiKey" };
    },
    "model/list": () => ({ data: [model], nextCursor: null }),
    "thread/start": (params) => {
      // codex-acp also starts an ephemeral thread to title the session.
      const id = `synthetic-thread-${threads.size + 1}`;
      threads.set(id, params.ephemeral === true);
      return {
        thread: {
          id,
          preview: "",
          ephemeral: params.ephemeral === true,
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
        },
        model: model.id,
        modelProvider: "openai",
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandbox: { type: "readOnly" },
        reasoningEffort: null,
      };
    },
    "turn/start": (params) => {
      if (threads.get(params.threadId) === false && !scanned) {
        scanned = true;
        writeScan();
      }
      const turn = {
        id: `turn-${params.threadId}`,
        items: [],
        status: "inProgress",
      };
      setTimeout(() => {
        notify("turn/started", { threadId: params.threadId, turn });
        notify("turn/completed", {
          threadId: params.threadId,
          turn: { ...turn, status: "completed" },
        });
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
  // Hold the process here so Node never loads the `app-server` entry point.
  await new Promise(() => {});
}
