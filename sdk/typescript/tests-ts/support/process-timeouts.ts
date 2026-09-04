// Windows runners start Bash, Git, Node, Python, and PowerShell processes
// several times slower than the Linux and macOS runners, so child-process
// budgets scale there instead of reporting ETIMEDOUT for a healthy command.
// The scale keeps every scaled budget below the two-minute per-test timeout the
// Windows CI runner applies.
const WINDOWS_TIMEOUT_SCALE = 3;

export function childProcessTimeout(
  milliseconds: number,
  platform: NodeJS.Platform = process.platform,
): number {
  return platform === "win32"
    ? milliseconds * WINDOWS_TIMEOUT_SCALE
    : milliseconds;
}
