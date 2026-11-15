import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotCheckout, tidyCheckout } from "../scripts/tidy.ts";

// Our install (AIF-173): a checker that leaves scratch files in the product checkout keeps its verdict.
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

function checkout(): { dir: string; stray: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-tidy-test-"));
  const dir = join(root, "product");
  mkdirSync(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { dir, stray: join(root, "artifacts", "app-check", "stray") };
}

describe("app-check tidy", () => {
  test("moves files the checker left in the checkout into the run's artifacts", () => {
    const { dir, stray } = checkout();
    const before = snapshotCheckout(dir);
    writeFileSync(join(dir, "jar2.txt"), "session=secret");
    mkdirSync(join(dir, "tmp", "shots"), { recursive: true });
    writeFileSync(join(dir, "tmp", "shots", "a.png"), "png");

    const result = tidyCheckout(dir, before, stray);

    expect(result).toEqual({ moved: ["jar2.txt", "tmp/shots/a.png"], changed: [] });
    expect(readFileSync(join(stray, "jar2.txt"), "utf8")).toBe("session=secret");
    expect(existsSync(join(stray, "tmp", "shots", "a.png"))).toBe(true);
    expect(git(dir, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(existsSync(join(dir, "tmp"))).toBe(false);
  });

  test("reports an edited tracked file and leaves files that were already there", () => {
    const { dir, stray } = checkout();
    writeFileSync(join(dir, "old-jar.txt"), "stale");
    const before = snapshotCheckout(dir);
    writeFileSync(join(dir, "README.md"), "changed\n");

    expect(tidyCheckout(dir, before, stray)).toEqual({ moved: [], changed: ["README.md"] });
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("changed\n");
    expect(readFileSync(join(dir, "old-jar.txt"), "utf8")).toBe("stale");
    expect(existsSync(stray)).toBe(false);
  });

  test("moves a new git-ignored file or folder too, and leaves ignored ones that were already there", () => {
    const { dir, stray } = checkout();
    writeFileSync(join(dir, ".gitignore"), "*.txt\ncache/\n");
    git(dir, "add", ".gitignore");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "ignore");
    mkdirSync(join(dir, "cache"));
    writeFileSync(join(dir, "cache", "build.bin"), "old");
    const before = snapshotCheckout(dir);
    writeFileSync(join(dir, "jar.txt"), "session=secret");
    mkdirSync(join(dir, "cache", "more"));
    writeFileSync(join(dir, "cache", "build.bin"), "new");

    expect(tidyCheckout(dir, before, stray)).toEqual({ moved: ["jar.txt"], changed: [] });
    expect(readFileSync(join(stray, "jar.txt"), "utf8")).toBe("session=secret");
    expect(existsSync(join(dir, "jar.txt"))).toBe(false);
    expect(readFileSync(join(dir, "cache", "build.bin"), "utf8")).toBe("new");
  });

  test("works from the checkout's root when run in a subfolder", () => {
    const { dir, stray } = checkout();
    mkdirSync(join(dir, "app"));
    const before = snapshotCheckout(join(dir, "app"));
    writeFileSync(join(dir, "jar2.txt"), "session=secret");

    expect(tidyCheckout(join(dir, "app"), before, stray)).toEqual({ moved: ["jar2.txt"], changed: [] });
    expect(existsSync(join(stray, "jar2.txt"))).toBe(true);
  });

  test("reports a file that was already there and changed", () => {
    const { dir, stray } = checkout();
    writeFileSync(join(dir, "old-jar.txt"), "stale");
    const before = snapshotCheckout(dir);
    writeFileSync(join(dir, "old-jar.txt"), "session=new");

    expect(tidyCheckout(dir, before, stray)).toEqual({ moved: [], changed: ["old-jar.txt"] });
  });
});
