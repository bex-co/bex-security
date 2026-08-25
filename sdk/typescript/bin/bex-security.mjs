#!/usr/bin/env node
async function launch() {
  const [{ realpathSync }, { dirname, join }, { pathToFileURL }] =
    await Promise.all([
      import("node:fs"),
      import("node:path"),
      import("node:url"),
    ]);
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    throw new Error("Cannot resolve CLI entrypoint.");
  }
  const cli = join(dirname(realpathSync(entrypoint)), "..", "dist", "cli.js");
  const { main } = await import(pathToFileURL(cli).href);
  return await main(
    process.argv.slice(2),
    process.stdout,
    process.stderr,
    undefined,
    "bex-security",
  );
}

void launch().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  () => {
    process.stderr.write("bex-security: Failed to start Bex Security.\n");
    process.exitCode = 2;
  },
);
