// Our install (AIF-164): what the app check tests. For a product Vercel deploys (factory.yaml
// `deploy.host: vercel`) that is the pull request head's Vercel preview, found from GitHub's
// deployment statuses, with its own Neon branch for a database (ADR-0013 in the ai Factory). The
// container never starts such an app: it would need a Postgres the container does not have. Any
// other product's app is started in the container by the checker, as before.
//
// A preview that failed or never came up is the check's one line, INCOMPLETE with the reason,
// written here, so no checker runs; the evidence node seals it and publish reports it as a failed
// check, as a local start failure is.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig } from "../../../../scripts/factory-config.ts";
import { listDeployments, previewOf, settle } from "../../.shared/deployments.ts";
import { emit, env, jsonEnv } from "../../.shared/utils.ts";

/** Writes the check's result for a preview that is not available, with what GitHub said as evidence. */
export function writeUnavailable(root: string, head: string, reason: string, deployments: unknown): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "preview.json"), `${JSON.stringify({ head, available: false, reason, deployments }, null, 2)}\n`);
  // A check line's parts are separated by two spaces, so the reason is kept to single spaces.
  const said = reason.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const line = `C1  INCOMPLETE  The Vercel preview of ${head.slice(0, 7)} is not available: ${said}.  evidence: preview.json`;
  const summary = `The pull request's preview is not available, so nothing was tested: ${said}.`;
  writeFileSync(join(root, "report.md"), `# Factory app check\n\n${summary}\n\n${line}\n`);
  writeFileSync(join(root, "result.json"), JSON.stringify({ overall: "FAIL", lines: [line], summary }));
}

if (import.meta.main) {
  const config = jsonEnv<FactoryConfig>("config", {} as FactoryConfig);
  if (config.deploy?.host !== "vercel") {
    emit({ mode: "local", ready: true, url: "", reason: "" });
  } else {
    const repo = env("repo_path"), head = env("head");
    const root = join(process.env.ARTIFACTS_DIR!, "app-check");
    let deployments: unknown = [];
    const lookup = await settle(() => {
      const listed = listDeployments(repo, head);
      deployments = listed;
      return previewOf(listed);
    }, config.deploy.timeout_minutes * 60_000);
    if (lookup.kind === "found") {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "preview.json"), `${JSON.stringify({ head, available: true, url: lookup.url, deployments }, null, 2)}\n`);
      emit({ mode: "preview", ready: true, url: lookup.url, reason: "" });
    } else {
      const reason = lookup.kind === "timeout"
        ? `no preview deployment of ${head.slice(0, 7)} succeeded within ${config.deploy.timeout_minutes} minutes (${lookup.detail})`
        : `its preview deployment failed (${lookup.detail})`;
      writeUnavailable(root, head, reason, deployments);
      emit({ mode: "preview", ready: false, url: "", reason });
    }
  }
}
