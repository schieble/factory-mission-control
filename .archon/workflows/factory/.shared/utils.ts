import { readFileSync } from "node:fs";

export function globRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export const matchingFiles = (files: string[], patterns: string[]) => {
  const regexes = patterns.map(globRegex);
  return files.filter(file => regexes.some(regex => regex.test(file.replace(/\\/g, "/").replace(/^\.\//, ""))));
};

export function env(name: string, fallback = ""): string { return process.env[`INPUTS_${name.toUpperCase()}`]?.trim() || fallback; }
export function jsonEnv<T>(name: string, fallback: T): T { const value = env(name); return value ? JSON.parse(value) as T : fallback; }
export function readJsonFile<T = unknown>(path: string): T {
  const text = readFileSync(path, "utf8");
  return JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text) as T;
}
export function emit(value: unknown): void { console.log(JSON.stringify(value)); }

// Our install (AIF-172): GitHub refusing the factory's credential, as gh and git say it. The same
// patterns are in factory-ops watcher/credential.ts and the SDLC pack's .shared/credential.ts.
const CREDENTIAL_FAILURE = [/\bHTTP 401\b/, /\bBad credentials\b/i, /token in \w+ is invalid/i, /Failed to log in to \S+ using token/i, /Invalid username or token/i, /Authentication failed for/i];
const refusesCredential = (text: string) => CREDENTIAL_FAILURE.some(pattern => pattern.test(text));

/** GitHub refused the credential: nothing this node does on GitHub can work until it is replaced. */
export class CredentialInvalidError extends Error {}

/**
 * Ends the node on an uncaught CredentialInvalidError with its message alone: the node fails as
 * `credential-invalid`, not as a stack trace from this file. Installed only once one is thrown,
 * so every other failure prints as it always did.
 */
let credentialExitInstalled = false;
function installCredentialExit(): void {
  if (credentialExitInstalled) return;
  credentialExitInstalled = true;
  const exit = (error: unknown) => {
    console.error(error instanceof CredentialInvalidError ? error.message : error);
    process.exitCode = 1;
  };
  process.on("uncaughtException", exit);
  process.on("unhandledRejection", exit);
}

export function run(command: string[], options: { cwd?: string; allowFailure?: boolean } = {}): string {
  const result = Bun.spawnSync(command, { cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = result.stderr.toString().trim();
  // Our install (AIF-172): even where a caller allows failure; no GitHub call can work after it.
  if (result.exitCode !== 0 && refusesCredential(stderr)) {
    installCredentialExit();
    // The last line that says so: git's "fatal: Authentication failed", after its "remote:" line.
    const reason = stderr.split("\n").map(line => line.trim()).reverse().find(refusesCredential) ?? stderr;
    throw new CredentialInvalidError(
      `credential-invalid: GitHub rejected the factory's credential (GH_TOKEN) on \`${command.slice(0, 3).join(" ")}\`: ${reason}. ` +
        "The watcher pauses this product's queues and alerts the Operator until it is replaced.",
    );
  }
  if (result.exitCode !== 0 && !options.allowFailure) throw new Error(`${command.slice(0, 3).join(" ")} failed: ${stderr}`);
  return result.stdout.toString().trim();
}

export function ghJson(args: string[]): any { const text = run(["gh", ...args]); return text ? JSON.parse(text) : null; }
// Our install (AIF-164): "error" too, for a deploy check a newer merge superseded.
export function postStatus(repo: string, head: string, state: "pending" | "success" | "failure" | "error", context: string, description: string): void {
  run(["gh", "api", "--method", "POST", `repos/${repo}/statuses/${head}`, "-f", `state=${state}`, "-f", `context=${context}`, "-f", `description=${description.slice(0, 140)}`]);
}

export function linkedIssue(body: string): number | null {
  const match = body.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/i);
  return match ? Number(match[1]) : null;
}
