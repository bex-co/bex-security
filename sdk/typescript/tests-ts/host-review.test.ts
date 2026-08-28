import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  runHostReviewAssignments,
  type HostReviewClient,
} from "../src/host-review.js";

interface FakeTurn {
  read: string[];
  claimed: string[];
  trailingMessages?: string[];
  repeatStructuredResponse?: boolean;
}

function client(repository: string, turns: FakeTurn[]): HostReviewClient {
  let next = 0;
  return {
    startThread() {
      const turn = turns[next++] ?? { read: [], claimed: [] };
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
                text: turn.repeatStructuredResponse
                  ? `${structuredResponse}${structuredResponse}`
                  : structuredResponse,
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
            yield { type: "turn.completed", usage: null };
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

describe("host ACP review assignments", () => {
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
