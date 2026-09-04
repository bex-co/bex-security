export function packageSmokeTimeouts(platform = process.platform) {
  const commandTimeoutMs = platform === "win32" ? 600_000 : 120_000;

  return {
    commandTimeoutMs,
    processTimeoutMs: commandTimeoutMs + 30_000,
  };
}
