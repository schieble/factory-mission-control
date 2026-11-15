// Our install (AIF-173): the checker's shell starts every command in the product checkout, so a
// relative scratch file (a curl cookie jar holding a preview session) can land there. prepare
// snapshots the checkout; this node moves files the checker added into the run's artifacts and keeps
// its verdict. Any other change (a tracked file edited, an untracked file that was already there
// touched) fails. Git-ignored entries count too, since a jar named *.txt or put in tmp/ is still a
// secret; but an ignored entry that was already there may change (build caches), so it never fails.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emit } from "../../.shared/utils.ts";

export type Snapshot = Record<string, { status: string; hash: string }>;

function git(dir: string, args: string[]): string {
  // Not utils.run: it trims, and a porcelain record can start with a space.
  const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed in ${dir}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

const repositoryRoot = (dir: string) => git(dir, ["rev-parse", "--show-toplevel"]).replace(/\r?\n$/, "");

function porcelain(root: string): [status: string, path: string][] {
  // --ignored=matching lists an ignored folder once, never what is inside it (node_modules).
  const records = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]).split("\0");
  const entries: [string, string][] = [];
  for (let i = 0; i < records.length - 1; i++) {
    const record = records[i]!, status = record.slice(0, 2);
    entries.push([status, record.slice(3)]);
    // Porcelain -z puts a rename's or copy's source in the next record.
    if (status.includes("R") || status.includes("C")) entries.push([status, records[++i]!]);
  }
  return entries;
}

function fingerprint(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "unreadable";
  }
}

/** Every dirty or ignored path in the checkout, relative to its root, with its status and content hash. */
export function snapshotCheckout(dir: string): Snapshot {
  const root = repositoryRoot(dir), snapshot: Snapshot = {};
  for (const [status, path] of porcelain(root)) snapshot[path] = { status, hash: fingerprint(join(root, path)) };
  return snapshot;
}

function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(from, to);
    rmSync(from);
  }
}

function removeEmptyParents(dir: string, path: string): void {
  for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
    const absolute = join(dir, parent);
    if (!existsSync(absolute) || readdirSync(absolute).length > 0) return;
    rmdirSync(absolute);
  }
}

/** Moves untracked and ignored entries added since `before` into `strayDir`; lists every other change. */
export function tidyCheckout(dir: string, before: Snapshot, strayDir: string): { moved: string[]; changed: string[] } {
  const root = repositoryRoot(dir), after = snapshotCheckout(root);
  const moved: string[] = [], changed: string[] = [];
  for (const path of Object.keys({ ...before, ...after }).sort()) {
    const was = before[path], now = after[path];
    if (was?.status === now?.status && was?.hash === now?.hash) continue;
    if (was === undefined && (now!.status === "??" || now!.status === "!!")) moved.push(path);
    else if (was?.status !== "!!" && now?.status !== "!!") changed.push(path);
  }
  for (const path of moved) {
    move(join(root, path), join(strayDir, path));
    removeEmptyParents(root, path);
  }
  return { moved, changed };
}

if (import.meta.main) {
  const root = join(process.env.ARTIFACTS_DIR!, "app-check"), beforePath = join(root, "checkout-before.json");
  // No snapshot means prepare did not run, so no checker ran either.
  if (!existsSync(beforePath)) {
    emit({ checked: false, moved: [], changed: [] });
  } else {
    const result = tidyCheckout(process.cwd(), JSON.parse(readFileSync(beforePath, "utf8")) as Snapshot, join(root, "stray"));
    if (result.moved.length) {
      writeFileSync(join(root, "stray.json"), JSON.stringify(result.moved));
      console.error(`app check: moved ${result.moved.length} file(s) the checker left in the checkout to ${join(root, "stray")}: ${result.moved.join(", ")}`);
    }
    if (result.changed.length) throw new Error(`the app check changed the product checkout: ${result.changed.slice(0, 10).join(", ")}`);
    emit({ checked: true, ...result });
  }
}
