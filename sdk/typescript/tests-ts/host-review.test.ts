import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ConfigurationError } from "../src/errors.js";
import {
  runHostReviewAssignments,
  type HostReviewClient,
} from "../src/host-review.js";

interface FakeTurn {
  read: string[];
  claimed: string[];
  trailingMessages?: string[];
  repeatStructuredResponse?: boolean;
  startError?: Error;
  message?: string;
  failure?: string;
  noCompletion?: boolean;
}

function client(repository: string, turns: FakeTurn[]): HostReviewClient {
  let next = 0;
  return {
    startThread() {
      const turn = turns[next++] ?? { read: [], claimed: [] };
      if (turn.startError) throw turn.startError;
      return {
        async runStreamed() {
          async function* events() {
            if (turn.read.length > 0) {
              yield {
                type: "item.completed",
                item: {
                  id: `read-${next}`,
                  type: "command_execution",
                  command: `cat ${turn.read
                    .map((path) => JSON.stringify(join(repository, path)))
                    .join(" ")}`,
                  aggregated_output: "reviewed",
                  exit_code: 0,
                  status: "completed",
                },
              };
            }
            const structuredResponse = JSON.stringify({
              reviewedFiles: turn.claimed,
              candidates:
                turn.claimed.length === 0
                  ? []
                  : [
                      {
                        title: "Candidate",
                        path: turn.claimed[0],
                        summary: "Validate this data flow.",
                      },
                    ],
            });
            yield {
              type: "item.completed",
              item: {
                id: `message-${next}`,
                type: "agent_message",
                text:
                  turn.message ??
                  (turn.repeatStructuredResponse
                    ? `${structuredResponse}${structuredResponse}`
                    : structuredResponse),
              },
            };
            for (const text of turn.trailingMessages ?? []) {
              yield {
                type: "item.completed",
                item: {
                  id: `message-${next}-trailing`,
                  type: "agent_message",
                  text,
                },
              };
            }
            if (turn.failure) {
              yield { type: "turn.failed", error: { message: turn.failure } };
            } else if (!turn.noCompletion) {
              yield { type: "turn.completed", usage: null };
            }
          }
          return { events: events() };
        },
      };
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bex-host-review-"));
  const repository = join(root, "repository");
  const scanDirectory = join(root, "scan");
  await Promise.all([mkdir(repository), mkdir(scanDirectory)]);
  await Promise.all([
    writeFile(join(repository, "a.ts"), "export const a = 1;\n"),
    writeFile(join(repository, "b.ts"), "export const b = 2;\n"),
  ]);
  return { root, repository, scanDirectory };
}

async function largeFixture(files: number) {
  const value = await fixture();
  await Promise.all(
    Array.from({ length: files }, (_, index) =>
      writeFile(
        join(value.repository, `file-${String(index).padStart(2, "0")}.ts`),
        `export const value${index} = ${index};\n`,
      ),
    ),
  );
  return value;
}

function reviewOptions(value: Awaited<ReturnType<typeof fixture>>) {
  return {
    repository: value.repository,
    target: { kind: "repository" as const, paths: [] },
    scanDirectory: value.scanDirectory,
    pluginRoot: value.root,
    python: process.execPath,
    expectedFilesTotal: 2,
    workers: 2,
    signal: new AbortController().signal,
  };
}

function diagnosticRoot(value: Awaited<ReturnType<typeof fixture>>) {
  return join(value.scanDirectory, "artifacts", "01_context", "host-review");
}

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("host ACP review assignments", () => {
  test("retains every startup failure and lists missing files without a canonical report", async () => {
    const value = await fixture();
    const warnings: string[] = [];
    let starts = 0;
    try {
      await expect(
        runHostReviewAssignments({
          ...reviewOptions(value),
          onWarning: (warning) => warnings.push(warning),
          client: {
            startThread() {
              starts++;
              throw new Error("Synthetic host initialization timed out");
            },
          },
        }),
      ).rejects.toThrow(/lacked completed read evidence/);
      const root = diagnosticRoot(value);
      const attempts = (await readdir(root)).filter((name) =>
        name.includes("-attempt-"),
      );
      expect(attempts.length).toBe(starts);
      expect(starts).toBeGreaterThan(2);
      for (const name of attempts) {
        const request = await json(join(root, name, "request.json"));
        expect(await json(join(root, name, "result.json"))).toMatchObject({
          files: request.files,
          phase: "starting",
          status: "failed",
          responseStatus: "none",
          turnCompleted: false,
          readFiles: [],
          failure: "Synthetic host initialization timed out",
        });
      }
      expect(await json(join(root, "incomplete-review.json"))).toMatchObject({
        status: "incomplete",
        filesReviewed: 0,
        missingFiles: ["a.ts", "b.ts"],
      });
      const summary = await readFile(
        join(value.scanDirectory, "incomplete-report.md"),
        "utf8",
      );
      expect(summary).toContain("0 / 2");
      expect(summary).toContain("a.ts");
      expect(summary).toContain("not a validated security report");
      expect(warnings).toContainEqual(
        expect.stringContaining("incomplete-report.md"),
      );
      expect(await readdir(value.scanDirectory)).not.toContain("report.md");
      expect(await readdir(root)).not.toContain("review.json");
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("retains partial coverage, candidates and exact missing-file retries", async () => {
    const value = await fixture();
    try {
      await expect(
        runHostReviewAssignments({
          ...reviewOptions(value),
          client: client(value.repository, [
            { read: ["a.ts"], claimed: ["a.ts"] },
          ]),
        }),
      ).rejects.toThrow("(1/2 files)");
      const root = diagnosticRoot(value);
      expect(await json(join(root, "incomplete-review.json"))).toMatchObject({
        filesReviewed: 1,
        missingFiles: ["b.ts"],
        candidates: [{ path: "a.ts" }],
      });
      expect(
        await json(join(root, "assignment-1-attempt-1", "result.json")),
      ).toMatchObject({
        status: "incomplete",
        readFiles: ["a.ts"],
        claimedFiles: ["a.ts"],
        missingFiles: ["b.ts"],
        responseStatus: "valid",
        turnCompleted: true,
      });
      expect(
        await json(join(root, "assignment-1-attempt-2", "request.json")),
      ).toMatchObject({ files: ["b.ts"] });
      expect(await json(join(root, "assignment-1.json"))).toMatchObject({
        attempts: 2,
        reviewedFiles: ["a.ts"],
        missingFiles: ["b.ts"],
      });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "malformed output",
      message: "not JSON",
      responseStatus: "invalid",
      phase: "validating",
      reason: "no valid structured response",
    },
    {
      name: "missing terminal event",
      noCompletion: true,
      responseStatus: "valid",
      phase: "validating",
      reason: "ended before completion",
    },
    {
      name: "stream failure",
      failure: "Synthetic stream disconnected",
      responseStatus: "valid",
      phase: "streaming",
      reason: "Synthetic stream disconnected",
    },
  ])(
    "distinguishes $name from missing reads and re-requests unaccepted files",
    async (scenario) => {
      const value = await fixture();
      try {
        await runHostReviewAssignments({
          ...reviewOptions(value),
          client: client(value.repository, [
            { read: ["a.ts", "b.ts"], claimed: ["a.ts", "b.ts"], ...scenario },
            { read: ["a.ts", "b.ts"], claimed: ["a.ts", "b.ts"] },
          ]),
        });
        const root = diagnosticRoot(value);
        const first = await json(
          join(root, "assignment-1-attempt-1", "result.json"),
        );
        expect(first).toMatchObject({
          status: "failed",
          phase: scenario.phase,
          responseStatus: scenario.responseStatus,
          readFiles: ["a.ts", "b.ts"],
          missingFiles: ["a.ts", "b.ts"],
        });
        expect(first.failure).toContain(scenario.reason);
        expect(
          await json(join(root, "assignment-1-attempt-2", "request.json")),
        ).toMatchObject({ files: ["a.ts", "b.ts"] });
        expect(await readdir(value.scanDirectory)).not.toContain(
          "incomplete-report.md",
        );
      } finally {
        await rm(value.root, { recursive: true, force: true });
      }
    },
  );

  test("cancellation saves in-flight evidence and candidates without accepting an unfinished turn", async () => {
    const value = await fixture();
    const controller = new AbortController();
    const reason = new Error("Synthetic caller canceled");
    let observed!: () => void;
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    try {
      const run = runHostReviewAssignments({
        ...reviewOptions(value),
        signal: controller.signal,
        client: {
          startThread(options) {
            return {
              async runStreamed() {
                expect(
                  await json(join(options.workingDirectory!, "request.json")),
                ).toMatchObject({ files: ["a.ts", "b.ts"] });
                return {
                  events: (async function* () {
                    yield {
                      type: "item.completed",
                      item: {
                        id: "read",
                        type: "mcp_tool_call",
                        tool: "read_file",
                        arguments: { path: join(value.repository, "a.ts") },
                        status: "completed",
                      },
                    };
                    yield {
                      type: "item.completed",
                      item: {
                        id: "answer",
                        type: "agent_message",
                        text: JSON.stringify({
                          reviewedFiles: ["a.ts"],
                          candidates: [
                            {
                              path: "a.ts",
                              title: "Candidate",
                              summary: "Needs validation",
                            },
                          ],
                        }),
                      },
                    };
                    await new Promise<void>((_resolve, reject) => {
                      controller.signal.addEventListener(
                        "abort",
                        () => reject(controller.signal.reason),
                        { once: true },
                      );
                      observed();
                    });
                  })(),
                };
              },
            };
          },
        },
      });
      void run.catch(() => {});
      await Promise.race([started, run]);
      controller.abort(reason);
      await expect(run).rejects.toBe(reason);
      const root = diagnosticRoot(value);
      expect(
        await json(join(root, "assignment-1-attempt-1", "result.json")),
      ).toMatchObject({
        status: "canceled",
        phase: "streaming",
        readFiles: ["a.ts"],
        claimedFiles: ["a.ts"],
        turnCompleted: false,
      });
      expect(await json(join(root, "incomplete-review.json"))).toMatchObject({
        status: "canceled",
        filesReviewed: 0,
        missingFiles: ["a.ts", "b.ts"],
        candidates: [{ path: "a.ts" }],
      });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("cancellation retains completed assignments beside an active worker", async () => {
    const value = await largeFixture(49);
    const controller = new AbortController();
    const reason = new Error("Synthetic cancellation");
    const reviewed = [
      "a.ts",
      "b.ts",
      ...Array.from(
        { length: 48 },
        (_, index) => `file-${String(index).padStart(2, "0")}.ts`,
      ),
    ];
    const completedClient = client(value.repository, [
      { read: reviewed, claimed: reviewed },
    ]);
    let started!: () => void;
    let progressed!: () => void;
    const ready = Promise.all([
      new Promise<void>((resolve) => {
        started = resolve;
      }),
      new Promise<void>((resolve) => {
        progressed = resolve;
      }),
    ]);
    try {
      const run = runHostReviewAssignments({
        ...reviewOptions(value),
        expectedFilesTotal: 51,
        signal: controller.signal,
        onProgress: () => progressed(),
        client: {
          startThread(options) {
            if (options.workingDirectory?.includes("assignment-1-")) {
              return completedClient.startThread(options);
            }
            return {
              async runStreamed() {
                return {
                  events: (async function* () {
                    const aborted = new Promise<void>((resolve) => {
                      controller.signal.addEventListener(
                        "abort",
                        () => resolve(),
                        { once: true },
                      );
                    });
                    started();
                    await aborted;
                    controller.signal.throwIfAborted();
                  })(),
                };
              },
            };
          },
        },
      });
      void run.catch(() => {});
      await Promise.race([ready, run]);
      controller.abort(reason);
      await expect(run).rejects.toBe(reason);
      const root = diagnosticRoot(value);
      expect(await json(join(root, "incomplete-review.json"))).toMatchObject({
        status: "canceled",
        filesReviewed: 50,
        missingFiles: ["file-48.ts"],
        assignments: [
          { reviewedFiles: reviewed, missingFiles: [] },
          {
            reviewedFiles: [],
            missingFiles: ["file-48.ts"],
            lastFailure: "Synthetic cancellation",
          },
        ],
      });
      expect(
        await json(join(root, "assignment-2-attempt-1", "result.json")),
      ).toMatchObject({ status: "canceled" });
    } finally {
      controller.abort(reason);
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("diagnostic write and observer failures cannot stop successful review", async () => {
    const value = await fixture();
    const root = diagnosticRoot(value);
    await mkdir(join(root, "assignment-1-attempt-1"), { recursive: true });
    await writeFile(
      join(root, "assignment-1-attempt-1", "request.json"),
      "existing diagnostic",
    );
    await mkdir(join(root, "assignment-1-attempt-1", "result.json"));
    const warnings: string[] = [];
    try {
      const result = await runHostReviewAssignments({
        ...reviewOptions(value),
        client: client(value.repository, [
          { read: ["a.ts", "b.ts"], claimed: ["a.ts", "b.ts"] },
        ]),
        onWarning(warning) {
          warnings.push(warning);
          throw new Error("observer failed");
        },
      });
      expect(result.filesReviewed).toBe(2);
      expect(warnings).toHaveLength(2);
      expect(
        await readFile(
          join(root, "assignment-1-attempt-1", "request.json"),
          "utf8",
        ),
      ).toBe("existing diagnostic");
      expect(await json(join(root, "assignment-1.json"))).toMatchObject({
        reviewedFiles: ["a.ts", "b.ts"],
      });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
  test("summary write failures preserve the original coverage error", async () => {
    const value = await fixture();
    const root = diagnosticRoot(value);
    await mkdir(join(root, "incomplete-review.json"), { recursive: true });
    await mkdir(join(value.scanDirectory, "incomplete-report.md"));
    const warnings: string[] = [];
    try {
      await expect(
        runHostReviewAssignments({
          ...reviewOptions(value),
          client: client(value.repository, []),
          onWarning(warning) {
            warnings.push(warning);
            throw new Error("observer failed");
          },
        }),
      ).rejects.toThrow(/lacked completed read evidence/);
      expect(warnings).toHaveLength(2);
      expect(
        warnings.every((warning) => warning.startsWith("Could not save")),
      ).toBe(true);
      expect(await json(join(root, "assignment-1.json"))).toMatchObject({
        reviewedFiles: [],
        missingFiles: ["a.ts", "b.ts"],
      });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("backs complete progress with exact completed read evidence", async () => {
    const value = await fixture();
    const progress: number[] = [];
    try {
      const result = await runHostReviewAssignments({
        client: client(value.repository, [
          { read: ["a.ts", "b.ts"], claimed: ["a.ts", "b.ts"] },
        ]),
        repository: value.repository,
        target: { kind: "repository", paths: [] },
        scanDirectory: value.scanDirectory,
        pluginRoot: value.root,
        python: process.execPath,
        expectedFilesTotal: 2,
        workers: 2,
        signal: new AbortController().signal,
        onProgress: (update) => progress.push(update.filesCompleted),
      });

      expect(result).toMatchObject({ filesReviewed: 2, assignments: 1 });
      expect(progress.at(-1)).toBe(2);
      expect(
        JSON.parse(await readFile(result.artifactPath, "utf8")),
      ).toMatchObject({
        schemaVersion: 1,
        filesReviewed: 2,
      });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("requeues missing evidence and combines successful attempts", async () => {
    const value = await fixture();
    try {
      const result = await runHostReviewAssignments({
        client: client(value.repository, [
          { read: ["a.ts"], claimed: ["a.ts", "b.ts"] },
          { read: ["b.ts"], claimed: ["b.ts"] },
        ]),
        repository: value.repository,
        target: { kind: "repository", paths: [] },
        scanDirectory: value.scanDirectory,
        pluginRoot: value.root,
        python: process.execPath,
        expectedFilesTotal: 2,
        workers: 1,
        signal: new AbortController().signal,
      });

      const artifact = JSON.parse(await readFile(result.artifactPath, "utf8"));
      expect(artifact.assignments[0]).toMatchObject({ attempts: 2 });
      expect(artifact.assignments[0].reviewedFiles).toEqual(["a.ts", "b.ts"]);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("keeps a valid structured response when later agent prose arrives", async () => {
    const value = await fixture();
    try {
      const result = await runHostReviewAssignments({
        client: client(value.repository, [
          {
            read: ["a.ts", "b.ts"],
            claimed: ["a.ts", "b.ts"],
            trailingMessages: ["Both files were reviewed successfully."],
          },
        ]),
        repository: value.repository,
        target: { kind: "repository", paths: [] },
        scanDirectory: value.scanDirectory,
        pluginRoot: value.root,
        python: process.execPath,
        expectedFilesTotal: 2,
        workers: 1,
        signal: new AbortController().signal,
      });

      expect(result.filesReviewed).toBe(2);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("extracts a strict response when ACP aggregates repeated JSON output", async () => {
    const value = await fixture();
    try {
      const result = await runHostReviewAssignments({
        client: client(value.repository, [
          {
            read: ["a.ts", "b.ts"],
            claimed: ["a.ts", "b.ts"],
            repeatStructuredResponse: true,
          },
        ]),
        repository: value.repository,
        target: { kind: "repository", paths: [] },
        scanDirectory: value.scanDirectory,
        pluginRoot: value.root,
        python: process.execPath,
        expectedFilesTotal: 2,
        workers: 1,
        signal: new AbortController().signal,
      });

      expect(result.filesReviewed).toBe(2);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("keeps draining the worker queue and recovers failed batches at a smaller size", async () => {
    const value = await largeFixture(49);
    const firstBatch = [
      "a.ts",
      "b.ts",
      ...Array.from(
        { length: 48 },
        (_, index) => `file-${String(index).padStart(2, "0")}.ts`,
      ),
    ];
    const lastFile = ["file-48.ts"];
    const recoveryBatches = Array.from({ length: 5 }, (_, index) =>
      firstBatch.slice(index * 10, (index + 1) * 10),
    );
    try {
      const result = await runHostReviewAssignments({
        client: client(value.repository, [
          { read: [], claimed: firstBatch },
          { read: [], claimed: firstBatch },
          { read: lastFile, claimed: lastFile },
          ...recoveryBatches.map((files) => ({ read: files, claimed: files })),
        ]),
        repository: value.repository,
        target: { kind: "repository", paths: [] },
        scanDirectory: value.scanDirectory,
        pluginRoot: value.root,
        python: process.execPath,
        expectedFilesTotal: 51,
        workers: 1,
        signal: new AbortController().signal,
      });

      const artifact = JSON.parse(await readFile(result.artifactPath, "utf8"));
      expect(result.filesReviewed).toBe(51);
      expect(artifact.assignments).toHaveLength(7);
      expect(artifact.assignments[0]).toMatchObject({
        attempts: 2,
        reviewedFiles: [],
        missingFiles: firstBatch,
      });
      expect(artifact.assignments[1]).toMatchObject({
        attempts: 1,
        reviewedFiles: lastFile,
      });
      expect(artifact.assignments.slice(2)).toEqual(
        expect.arrayContaining(
          recoveryBatches.map((files) =>
            expect.objectContaining({
              attempts: 1,
              reviewedFiles: files,
              missingFiles: [],
            }),
          ),
        ),
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("fails instead of accepting unsupported completion claims", async () => {
    const value = await fixture();
    try {
      await expect(
        runHostReviewAssignments({
          client: client(value.repository, [
            { read: [], claimed: ["a.ts", "b.ts"] },
            { read: [], claimed: ["a.ts", "b.ts"] },
          ]),
          repository: value.repository,
          target: { kind: "repository", paths: [] },
          scanDirectory: value.scanDirectory,
          pluginRoot: value.root,
          python: process.execPath,
          expectedFilesTotal: 2,
          workers: 1,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow(/lacked completed read evidence/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("does not publish progress for read evidence the agent did not claim", async () => {
    const value = await fixture();
    const progress: number[] = [];
    try {
      await expect(
        runHostReviewAssignments({
          client: client(value.repository, [
            { read: ["a.ts"], claimed: [] },
            { read: [], claimed: [] },
          ]),
          repository: value.repository,
          target: { kind: "repository", paths: [] },
          scanDirectory: value.scanDirectory,
          pluginRoot: value.root,
          python: process.execPath,
          expectedFilesTotal: 2,
          workers: 1,
          signal: new AbortController().signal,
          onProgress: (update) => progress.push(update.filesCompleted),
        }),
      ).rejects.toThrow(/lacked completed read evidence/);
      expect(progress).toEqual([]);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
});

describe("host review failure handling", () => {
  for (const [execution, expectedAttempts] of [
    ["configuration", 1],
    ["notSubmitted", 2],
    ["possiblySubmitted", 1],
  ] as const) {
    test(`does not fan out ${execution} failures into smaller batches`, async () => {
      const value = await fixture();
      let starts = 0;
      let closes = 0;
      const cause =
        execution === "configuration"
          ? new ConfigurationError("unavailable synthetic model")
          : Object.assign(new Error("synthetic host failure"), {
              data: { failure: { execution, phase: "initializing" } },
            });
      const original = new Error("host diagnostics", { cause });
      const client: HostReviewClient = {
        startThread() {
          starts++;
          return {
            async close() {
              closes++;
              throw new Error(
                "synthetic cleanup failure must not replace the initiating failure",
              );
            },
            async runStreamed() {
              throw original;
            },
          };
        },
      };
      try {
        await expect(
          runHostReviewAssignments({
            client,
            repository: value.repository,
            scanDirectory: value.scanDirectory,
            target: { kind: "repository", paths: [] },
            pluginRoot: value.root,
            python: process.execPath,
            expectedFilesTotal: 2,
            workers: 2,
            signal: new AbortController().signal,
          }),
        ).rejects.toBe(original);
        expect(starts).toBe(expectedAttempts);
        expect(closes).toBe(expectedAttempts);
      } finally {
        await rm(value.root, { recursive: true, force: true });
      }
    });
  }
});
