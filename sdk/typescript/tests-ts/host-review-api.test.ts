import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { afterEach, expect, test } from "bun:test";
import { main } from "../src/cli.js";
import { capture, dependencies } from "./cli-fixtures.js";
import {
  TestClient,
  mockScanRegistration,
  mockWorkbench,
} from "./support/api-client.js";
import {
  completedEvents,
  createApiTestFixtures,
  preparedRuntime,
} from "./support/api-events.js";

const { temporaryDirectory, cleanup, copyCompletedScan } =
  createApiTestFixtures();
afterEach(cleanup);

test.each(["success", "failure"] as const)(
  "CLI and SDK host-review %s preserve their report contract",
  async (outcome) => {
    const root = await temporaryDirectory();
    const repository = join(root, "repository");
    const codexHome = join(root, "codex-home");
    const scanDir = join(root, "scan");
    await Promise.all([mkdir(repository), mkdir(codexHome), mkdir(scanDir)]);
    await writeFile(join(repository, "a.ts"), "export const value = 1;\n");
    const commands: string[] = [];
    let coordinatorStarted = false;
    const client = new TestClient(
      {},
      {
        environment: { CODEX_SECURITY_STATE_DIR: join(root, "state") },
        prepareRuntime: async () => preparedRuntime(codexHome),
        resolvePluginPython: async () => "/managed/python",
        prepareOutputDir: async () => scanDir,
        repositoryRevision: async () => "deadbeef",
        runWorkbench: async (_options, args, input) => {
          commands.push(args[0]!);
          return args[0] === "register-cli-scan"
            ? { ...mockScanRegistration(args, input), scopeFileCount: 1 }
            : mockWorkbench(args, input);
        },
        createCodex: () => ({
          capabilities: async () => ({
            delegatedWorkers: false,
            usage: "unavailable",
            interactivePermissions: false,
          }),
          startThread(options) {
            const assignment =
              options.workingDirectory?.includes("host-review");
            if (assignment && outcome === "failure")
              throw new Error("Synthetic host startup failed");
            return {
              id: null,
              async runStreamed(prompt) {
                if (!assignment) {
                  coordinatorStarted = true;
                  expect(prompt).toContain("review.json");
                  expect(prompt).toContain(
                    "This runtime has no delegated workers.",
                  );
                  expect(prompt).toContain(
                    "a launch acknowledgement is not a result",
                  );
                  await copyCompletedScan(root);
                  return { events: completedEvents() };
                }
                expect(
                  JSON.parse(
                    await readFile(
                      join(options.workingDirectory!, "request.json"),
                      "utf8",
                    ),
                  ),
                ).toMatchObject({ files: ["a.ts"] });
                return {
                  events: (async function* (): AsyncGenerator<ThreadEvent> {
                    yield {
                      type: "item.completed",
                      item: {
                        id: "read",
                        type: "command_execution",
                        command: `cat ${JSON.stringify(join(repository, "a.ts"))}`,
                        aggregated_output: "export const value = 1;",
                        status: "completed",
                        exit_code: 0,
                      },
                    };
                    yield {
                      type: "item.completed",
                      item: {
                        id: "answer",
                        type: "agent_message",
                        text: JSON.stringify({
                          reviewedFiles: ["a.ts"],
                          candidates: [],
                        }),
                      },
                    };
                    yield {
                      type: "turn.completed",
                      usage: {
                        input_tokens: 1,
                        cached_input_tokens: 0,
                        cache_write_input_tokens: 0,
                        output_tokens: 1,
                        reasoning_output_tokens: 0,
                      },
                    };
                  })(),
                };
              },
            };
          },
        }),
      },
    );
    const stdout = capture();
    const stderr = capture();
    try {
      const exit = await main(
        ["scan", repository, "--headless"],
        stdout.stream,
        stderr.stream,
        {
          ...dependencies({ currentDirectory: root }),
          createSecurity: () => client,
        },
      );
      if (outcome === "success") {
        expect(exit).toBe(0);
        expect(coordinatorStarted).toBe(true);
        expect(commands).toContain("complete-scan");
        expect(commands).not.toContain("fail-scan");
        expect(await readFile(join(scanDir, "report.md"), "utf8")).toContain(
          "Scan report",
        );
        expect(await readdir(scanDir)).not.toContain("incomplete-report.md");
      } else {
        expect(exit).not.toBe(0);
        expect(coordinatorStarted).toBe(false);
        expect(commands).toContain("fail-scan");
        expect(commands).not.toContain("complete-scan");
        expect(stderr.text()).toContain("incomplete-report.md");
        expect(stderr.text()).toContain("lacked completed read evidence");
        expect(
          await readFile(join(scanDir, "incomplete-report.md"), "utf8"),
        ).toContain("0 / 1");
        expect(await readdir(scanDir)).not.toContain("report.md");
        expect(
          JSON.parse(
            await readFile(
              join(
                scanDir,
                "artifacts",
                "01_context",
                "host-review",
                "assignment-1.json",
              ),
              "utf8",
            ),
          ),
        ).toMatchObject({ lastFailure: "Synthetic host startup failed" });
      }
    } finally {
      await client.close();
    }
  },
);
