/**
 * Our install (AIF-150): the factory workflows' work items, wherever factory.yaml's
 * `work_items` puts them. In the project's GitHub issues (the default) they go through `gh`,
 * as upstream. In a Linear team they go through `archon forge`, which hands them to the
 * forge-linear plugin.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WorkItems { readonly host: string; readonly path: string }

/**
 * Where this project's work items live: factory.yaml's `work_items`, else its project
 * repository. Only those two keys are read, so a script that only needs to know where the
 * items are does not depend on the rest of the file (factory-config.ts validates it all).
 */
export function workItems(path = ".archon/factory.yaml"): WorkItems {
  const config = (existsSync(path) ? Bun.YAML.parse(readFileSync(path, "utf8")) : null) as
    { work_items?: { host?: unknown; path?: unknown }; project?: { repo_host?: unknown; repo_path?: unknown } } | null;
  const host = typeof config?.work_items?.host === "string" ? config.work_items.host.trim() : "";
  if (host) return { host, path: String(config?.work_items?.path ?? "").trim() };
  return {
    host: typeof config?.project?.repo_host === "string" && config.project.repo_host.trim() ? config.project.repo_host.trim() : "github.com",
    path: typeof config?.project?.repo_path === "string" ? config.project.repo_path.trim() : "",
  };
}

export function isLinear(items: WorkItems): boolean {
  return items.host.toLowerCase() === "linear.app";
}

/** How an issue body names item `number`: `SNIP-12` in Linear, `#12` on GitHub. */
export function itemKey(items: WorkItems, number: number): string {
  return isLinear(items) ? `${(items.path.split("/").at(-1) ?? "").toUpperCase()}-${number}` : `#${number}`;
}

/** Run one `archon forge` operation and return its result value; any failure throws. */
export function forge(op: string, request: Record<string, unknown>): any {
  const command = JSON.parse(process.env.ARCHON_CLI_COMMAND || '["archon"]') as string[];
  const dir = mkdtempSync(join(tmpdir(), "factory-forge-"));
  try {
    const file = join(dir, "request.json");
    writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
    const result = Bun.spawnSync([...command, "forge", op, "--json", "--data-file", file], { stdout: "pipe", stderr: "pipe" });
    let response: any;
    try { response = JSON.parse(result.stdout.toString()); }
    catch { throw new Error(`forge ${op} failed: ${result.stderr.toString().trim()}`); }
    if (response?.ok !== true || response.result?.op !== op) {
      throw new Error(`forge ${op} failed: ${response?.error?.message ?? "no result"}${response?.mutation ? ` ${JSON.stringify(response.mutation)}` : ""}`);
    }
    return response.result.value;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A Linear issue's body, URL and labels. */
export function viewLinearIssue(items: WorkItems, number: number): { body: string; url: string; labels: string[] } {
  const value = forge("workitem.view", { ref: { repo: items, number } });
  const labels = Array.isArray(value.labels) ? value.labels.map((label: unknown) => typeof label === "string" ? label : String((label as { name?: unknown })?.name ?? "")) : [];
  return { body: String(value.body ?? ""), url: String(value.url ?? ""), labels };
}

/** The Linear issue a pull request body links (`Closes SNIP-12`, `Refs SNIP-12`), as utils' linkedIssue does `#12`. */
export function linkedLinearIssue(items: WorkItems, body: string): number | null {
  const team = (items.path.split("/").at(-1) ?? "").replace(/[^A-Za-z0-9]/g, "");
  const match = body.match(new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\\s+${team}-(\\d+)\\b`, "i"));
  return match ? Number(match[1]) : null;
}

/**
 * Create the Linear issue whose description begins with `marker`, or find the one an
 * earlier run created: the plugin recovers it by that first line, so a rerun files nothing
 * twice.
 */
export function createLinearIssue(items: WorkItems, title: string, body: string, marker: string): { number: number; url: string; created: boolean } {
  const value = forge("workitem.create", { repo: items, title, body, marker });
  const number = Number(value?.workitem?.ref?.number);
  if (!Number.isInteger(number) || number <= 0 || typeof value?.workitem?.url !== "string") throw new Error("forge workitem.create returned no issue");
  return { number, url: value.workitem.url, created: value.changed === true };
}
