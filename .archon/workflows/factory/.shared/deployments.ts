// Our install (AIF-164): a commit's deployments, as the host reports them to GitHub. Vercel's GitHub
// integration posts a deployment for every commit it builds, preview or production, with statuses
// that end in success (with the address it serves) or failure. So the factory needs no Vercel
// token: GitHub's deployment statuses are the signal. Ported from the ai Factory's preview lookup
// (src/preview.ts, ADR-0001).

import { ghJson } from "./utils.ts";

export interface DeploymentStatus { state: string; url?: string; description?: string }
/** One deployment of a commit, its statuses newest first, as GitHub lists them. */
export interface Deployment { id: number; sha: string; environment: string; production: boolean; statuses: DeploymentStatus[] }
export type Lookup = { kind: "found"; url: string } | { kind: "failed"; detail: string } | { kind: "pending"; detail: string };

const WEB_ADDRESS = /^https?:\/\/[^/]/;
const ENDED = new Set(["failure", "error"]);

/** Not every host flags its production deployment to GitHub, so one named Production counts too. */
function isProduction(deployment: Deployment): boolean {
  return deployment.production || /^production$/i.test(deployment.environment);
}

/**
 * Where a deployment stands. GitHub adds an `inactive` status to an earlier deployment in the same
 * environment once a newer one succeeds; the earlier one still serves its address, so `inactive`
 * says nothing about it and is passed over.
 */
function latest(deployment: Deployment): DeploymentStatus | undefined {
  return deployment.statuses.find(status => status.state !== "inactive");
}

function describe(deployment: Deployment): string {
  const status = latest(deployment);
  if (!status) return `${deployment.environment}: no status yet`;
  return `${deployment.environment}: ${status.state}${status.description ? ` (${status.description})` : ""}`;
}

/**
 * The address the candidates serve the commit at: the first whose latest status is a success with an
 * address. Only when every one of them ended in failure or error has it failed; until then, none at
 * all or one still building is waited for.
 */
function servedBy(candidates: Deployment[], noneDetail: string): Lookup {
  for (const candidate of candidates) {
    const status = latest(candidate);
    if (status?.state === "success" && WEB_ADDRESS.test(status.url ?? "")) return { kind: "found", url: status.url! };
  }
  if (!candidates.length) return { kind: "pending", detail: noneDetail };
  const detail = candidates.map(describe).join("; ");
  return { kind: candidates.every(candidate => ENDED.has(latest(candidate)?.state ?? "")) ? "failed" : "pending", detail };
}

/**
 * A pull request head's preview. Never its production deployment: a host with no production
 * deployment yet makes its first one Production, even a pull request's, built without a preview's
 * settings. Several preview environments (an app and its Storybook) are not guessed between.
 */
export function previewOf(deployments: Deployment[]): Lookup {
  const previews = deployments.filter(deployment => !isProduction(deployment));
  if (deployments.length && !previews.length) {
    return { kind: "failed", detail: `GitHub has it deployed only to Production (${deployments.map(describe).join("; ")}), so it has no preview` };
  }
  const environments = [...new Set(previews.map(deployment => deployment.environment))];
  if (environments.length > 1) {
    return { kind: "failed", detail: `GitHub has deployments of it to several environments (${environments.join(", ")}), so the factory does not guess which is the preview` };
  }
  return servedBy(previews, "GitHub has no preview deployment of it");
}

/** A merge commit's production deployment. */
export function productionOf(deployments: Deployment[]): Lookup {
  return servedBy(deployments.filter(isProduction), "GitHub has no production deployment of it");
}

interface ListedDeployment { id: number; sha: string; environment: string; production_environment?: boolean }
interface ListedStatus { state: string; environment_url?: string; target_url?: string; description?: string | null }

/** The commit's deployments and their statuses, through gh's own sign-in; newest first, as GitHub lists them. */
export function listDeployments(repo: string, sha: string): Deployment[] {
  const listed = (ghJson(["api", `repos/${repo}/deployments?sha=${sha}&per_page=100`]) ?? []) as ListedDeployment[];
  return listed.map(({ id, environment, production_environment }) => {
    const statuses = (ghJson(["api", `repos/${repo}/deployments/${id}/statuses?per_page=100`]) ?? []) as ListedStatus[];
    return {
      id,
      sha,
      environment,
      production: production_environment === true,
      statuses: statuses.map(({ state, environment_url, target_url, description }) => {
        const url = environment_url || target_url;
        return { state, ...(url ? { url } : {}), ...(description ? { description } : {}) };
      }),
    };
  });
}

/**
 * Asks again every `pollMs` while the lookup is pending, until `timeoutMs`. A lookup that throws
 * (GitHub could not be asked) counts as pending, so one hiccup is not a failed deploy.
 */
export async function settle(look: () => Lookup, timeoutMs: number, pollMs = 15_000, sleep = (ms: number) => Bun.sleep(ms), now = () => Date.now()): Promise<Lookup | { kind: "timeout"; detail: string }> {
  const deadline = now() + timeoutMs;
  for (;;) {
    let lookup: Lookup;
    try { lookup = look(); }
    catch (error) { lookup = { kind: "pending", detail: `GitHub could not be asked: ${error instanceof Error ? error.message : String(error)}` }; }
    if (lookup.kind !== "pending") return lookup;
    const left = deadline - now();
    if (left <= 0) return { kind: "timeout", detail: lookup.detail };
    await sleep(Math.min(pollMs, left));
  }
}
