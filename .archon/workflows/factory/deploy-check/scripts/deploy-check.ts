// Our install (AIF-164): checks that production serves the default branch's newest commit, for a
// product Vercel deploys (factory.yaml `deploy.host: vercel`). Vercel's GitHub integration deploys
// every merge on its own; nothing here deploys. The check waits for GitHub's deployment status of
// that commit in production, which Vercel posts, then asks the production URL's health route,
// which must answer 2xx and report the commit it was built from (`{ "commit": "<sha>" }`, from
// VERCEL_GIT_COMMIT_SHA). The result is the commit's `factory/deploy` status. A failed, missing
// or mismatched deploy is also recorded for the discoveries workflow, which files it as new work,
// as factory-deploy records a failed deployment.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig } from "../../../../scripts/factory-config.ts";
import { listDeployments, type Lookup, productionOf, settle } from "../../.shared/deployments.ts";
import { emit, env, ghJson, jsonEnv, postStatus, run } from "../../.shared/utils.ts";
import { recordFailedDeployment } from "../../deploy/scripts/verify.ts";

export const CONTEXT = "factory/deploy";
/** A check still pending after this died before it recorded a result, and is run again. */
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;
const HEALTH_TIMEOUT_MS = 20_000;

export interface Health { status: number; body: string; error?: string }
export type Verdict = { state: "success" | "failure" | "superseded"; reason: string };
interface CommitStatus { context: string; state: string; created_at?: string }

const short = (sha: string) => sha.slice(0, 7);

/** The commit a health response says it was built from, if it says. */
function reportedCommit(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as { commit?: unknown };
    return typeof value?.commit === "string" && value.commit ? value.commit.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export function judgeProduction({ merge, tip, lookup, health, timeoutMinutes = 15 }: {
  merge: string;
  /** The default branch's tip once the check is done: a newer merge replaces this one in production. */
  tip: string;
  lookup: Lookup | { kind: "timeout"; detail: string };
  health: Health | null;
  timeoutMinutes?: number;
}): Verdict {
  const failure = (reason: string): Verdict => ({ state: "failure", reason });
  if (lookup.kind === "failed") return failure(`Vercel's production deploy of ${short(merge)} failed (${lookup.detail})`);
  if (lookup.kind !== "found") return failure(`no production deploy of ${short(merge)} succeeded within ${timeoutMinutes} minutes (${lookup.detail})`);
  if (!health || health.error) return failure(`production's health route could not be reached: ${health?.error ?? "not asked"}`);
  if (health.status < 200 || health.status > 299) return failure(`production's health route answered HTTP ${health.status}`);
  const commit = reportedCommit(health.body);
  if (!commit) return failure('production\'s health route reports no commit: it must answer JSON with "commit" set to VERCEL_GIT_COMMIT_SHA');
  if (commit !== merge.toLowerCase()) {
    // Only a newer merge that production already serves replaces this one; any other commit is a mismatch.
    if (tip.toLowerCase() !== merge.toLowerCase() && commit === tip.toLowerCase()) return { state: "superseded", reason: `superseded: ${short(tip)} was merged after it` };
    return failure(`production serves ${short(commit)}, not the merge commit ${short(merge)}`);
  }
  return { state: "success", reason: `production serves ${short(merge)} and is healthy` };
}

/** Whether the commit still needs its deploy checked: no result yet, or a check that died. */
export function needsCheck(statuses: CommitStatus[], now = Date.now()): boolean {
  // GitHub lists a commit's statuses newest first.
  const latest = statuses.find(status => status.context === CONTEXT);
  if (!latest) return true;
  if (latest.state !== "pending") return false;
  const created = Date.parse(latest.created_at ?? "");
  return !Number.isFinite(created) || now - created > PENDING_MAX_AGE_MS;
}

async function askHealth(url: string): Promise<Health> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS), headers: { "cache-control": "no-cache" } });
    return { status: response.status, body: (await response.text()).slice(0, 4000) };
  } catch (error) {
    return { status: 0, body: "", error: error instanceof Error ? error.message : String(error) };
  }
}

function tipOf(repo: string): { branch: string; sha: string } {
  const branch = run(["gh", "repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  const sha = run(["gh", "api", `repos/${repo}/commits/${encodeURIComponent(branch)}`, "--jq", ".sha"]);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GitHub returned no commit for ${repo}'s default branch`);
  return { branch, sha };
}

if (import.meta.main) {
  const repo = env("repo_path");
  const config = jsonEnv<FactoryConfig>("config", {} as FactoryConfig);
  if (config.deploy?.host !== "vercel") {
    emit({ checked: false, state: "", commit: "", reason: "skipped: factory.yaml names no deploy host" });
    process.exit(0);
  }
  const { sha } = tipOf(repo);
  const statuses = (ghJson(["api", `repos/${repo}/commits/${sha}/statuses?per_page=100`]) ?? []) as CommitStatus[];
  if (!needsCheck(statuses)) {
    emit({ checked: false, state: "", commit: sha, reason: `${short(sha)} already has a ${CONTEXT} result` });
    process.exit(0);
  }
  postStatus(repo, sha, "pending", CONTEXT, "waiting for Vercel's production deploy");
  const root = join(process.env.ARTIFACTS_DIR!, "deploy");
  mkdirSync(root, { recursive: true });
  const write = (name: string, value: unknown) => {
    const path = join(root, name);
    writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
    return path;
  };
  const deploymentsFile = join(root, "deployments.json");
  const lookup = await settle(() => {
    const deployments = listDeployments(repo, sha);
    write("deployments.json", deployments);
    return productionOf(deployments);
  }, config.deploy.timeout_minutes * 60_000);
  const healthUrl = `${config.deploy.production_url}${config.deploy.health_path}`;
  const health = lookup.kind === "found" ? await askHealth(healthUrl) : null;
  const evidence = [deploymentsFile];
  if (health) evidence.push(write("health.json", { url: healthUrl, at: new Date().toISOString(), ...health }));
  const tip = health ? tipOf(repo).sha : sha;
  const verdict = judgeProduction({ merge: sha, tip, lookup, health, timeoutMinutes: config.deploy.timeout_minutes });
  const report = [
    `# Deploy check: ${verdict.state}`,
    "",
    `Commit: \`${sha}\` of ${repo}`,
    `Production deployment: ${lookup.kind === "found" ? lookup.url : lookup.kind} (${lookup.kind === "found" ? "succeeded" : lookup.detail})`,
    `Health: ${healthUrl} -> ${health ? (health.error ?? `HTTP ${health.status}`) : "not asked"}`,
    `Result: ${verdict.reason}`,
    "",
    ...evidence.map(file => `- ${file}`),
  ].join("\n");
  evidence.unshift(write("report.md", `${report}\n`));
  postStatus(repo, sha, verdict.state === "superseded" ? "error" : verdict.state, CONTEXT, verdict.reason);
  if (verdict.state === "failure") recordFailedDeployment(process.env.ARTIFACTS_DIR!, sha, verdict.reason, evidence);
  emit({ checked: true, state: verdict.state, commit: sha, reason: verdict.reason });
}
