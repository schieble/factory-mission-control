import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Our install (AIF-172): a node whose gh or git call GitHub refuses for the credential ends as
// `credential-invalid`, with gh's or git's reason and no stack trace.
const UTILS = join(import.meta.dir, "../../.shared/utils.ts");

/** Runs `body` as a script importing run() from utils.ts, with a fake gh that prints `stderr`. */
function script(stderr: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), "factory-credential-test-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!/bin/sh\nprintf '%b\\n' ${JSON.stringify(stderr)} >&2\nexit 1\n`);
  chmodSync(gh, 0o755);
  const file = join(dir, "node.ts");
  writeFileSync(file, `import { run } from ${JSON.stringify(UTILS)};\n${body}\n`);
  const r = Bun.spawnSync(["bun", file], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stderr: r.stderr.toString() };
}

const UNAUTHORIZED = "HTTP 401: Bad credentials (https://api.github.com/graphql)";

describe("run and the credential", () => {
  test("a 401 from gh ends the node as credential-invalid, naming the token, without a stack trace", () => {
    const r = script(UNAUTHORIZED, `run(["gh", "pr", "list"]);`);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith("credential-invalid: GitHub rejected the factory's credential (GH_TOKEN) on `gh pr list`: HTTP 401: Bad credentials");
    expect(r.stderr).not.toContain("at run");
  });

  test("git's authentication failure ends the node the same way, with git's reason", () => {
    const r = script(
      "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
      `run(["gh", "repo", "clone"]);`,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith("credential-invalid: GitHub rejected the factory's credential (GH_TOKEN) on `gh repo clone`: fatal: Authentication failed for 'https://github.com/o/r.git/'");
  });

  test("a 401 ends the node even where the caller allows the command to fail", () => {
    const r = script(UNAUTHORIZED, `run(["gh", "api", "x"], { allowFailure: true }); console.log("went on");`);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith("credential-invalid:");
  });

  test("a 401 thrown after an await ends the node the same way", () => {
    const r = script(UNAUTHORIZED, `await Bun.sleep(1); run(["gh", "pr", "list"]);`);
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith("credential-invalid:");
  });

  test("any other failure is the error it always was", () => {
    const r = script("gh: Not Found (HTTP 404)", `run(["gh", "api", "x"]);`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("error: gh api x failed: gh: Not Found (HTTP 404)");
    expect(r.stderr).not.toMatch(/^credential-invalid/m);
  });
});
