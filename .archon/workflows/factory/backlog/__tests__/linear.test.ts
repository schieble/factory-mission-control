// Our install (AIF-150): a project whose work items are in Linear gets its backlog as Linear
// issues, through `archon forge`, and never a GitHub issue.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPTS = resolve(import.meta.dir, "../scripts");

/** A product checkout in Linear, a fake archon whose plugin numbers new issues from 20, and a gh that must not run. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "factory-backlog-linear-"));
  mkdirSync(join(root, ".archon"), { recursive: true });
  writeFileSync(join(root, ".archon", "factory.yaml"), "project: { repo_host: github.com, repo_path: schieble/snip }\nwork_items: { host: linear.app, path: wrkr/SNIP }\n");
  const artifacts = join(root, "artifacts"), log = join(root, "forge.log"), store = join(root, "issues.json"), bin = join(root, "bin");
  mkdirSync(artifacts); mkdirSync(bin);
  writeFileSync(store, "[]");
  const archon = join(root, "archon.ts");
  writeFileSync(archon, `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2), op = argv[1];
const request = JSON.parse(readFileSync(argv[argv.indexOf("--data-file") + 1], "utf8"));
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ op, request }) + "\\n");
const issues = JSON.parse(readFileSync(${JSON.stringify(store)}, "utf8"));
const url = (n) => "https://linear.app/wrkr/issue/SNIP-" + n;
let value;
if (op === "workitem.create") {
  const prior = issues.find(issue => issue.body.split("\\n")[0] === request.marker);
  const issue = prior ?? { number: 20 + issues.length, body: request.body };
  if (!prior) { issues.push(issue); writeFileSync(${JSON.stringify(store)}, JSON.stringify(issues)); }
  value = { changed: !prior, workitem: { ref: { repo: request.repo, number: issue.number }, url: url(issue.number) } };
} else if (op === "workitem.view") {
  value = { kind: "issue", ref: request.ref, body: "PRD ".repeat(60), url: url(request.ref.number) };
}
process.stdout.write(JSON.stringify({ operationId: "op", ok: true, result: { op, value } }));
`);
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'gh must not run for a Linear project' >&2\nexit 1\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARTIFACTS_DIR: artifacts, ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, archon]), INPUTS_REPO_PATH: "schieble/snip" };
  const run = (script: string, inputs: Record<string, string> = {}) => {
    const result = Bun.spawnSync([process.execPath, join(SCRIPTS, `${script}.ts`)], { cwd: root, env: { ...env, ...inputs }, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return JSON.parse(result.stdout.toString());
  };
  const requests = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { artifacts, run, requests };
}

describe("factory-backlog in a Linear project", () => {
  test("publishes each ticket once as a Linear issue, its marker first, its dependencies by key", () => {
    const { artifacts, run, requests } = project();
    writeFileSync(join(artifacts, "backlog.json"), JSON.stringify([
      { key: "store", title: "Store links", body: "Keep links.", depends_on: [] },
      { key: "serve", title: "Serve links", body: "Redirect.\n<!-- factory-backlog: serve -->", depends_on: ["store"] },
    ]));
    expect(run("publish")).toEqual({ published: true, created: ["https://linear.app/wrkr/issue/SNIP-20", "https://linear.app/wrkr/issue/SNIP-21"], existing: [] });
    const [store, serve] = requests().map(entry => entry.request);
    expect(store).toMatchObject({ repo: { host: "linear.app", path: "wrkr/SNIP" }, title: "Store links", marker: "<!-- factory-backlog: store -->" });
    expect(store.body).toBe("<!-- factory-backlog: store -->\nKeep links.\n");
    expect(serve.body).toBe("<!-- factory-backlog: serve -->\nRedirect.\n\nDepends on: SNIP-20\n");

    expect(run("publish")).toEqual({ published: true, created: [], existing: ["https://linear.app/wrkr/issue/SNIP-20", "https://linear.app/wrkr/issue/SNIP-21"] });
  });

  test("reads a PRD issue from Linear", () => {
    const { run, requests } = project();
    expect(run("read", { INPUTS_NUMBER: "5" })).toMatchObject({ source: "https://linear.app/wrkr/issue/SNIP-5", characters: 240 });
    expect(requests()).toEqual([{ op: "workitem.view", request: { ref: { repo: { host: "linear.app", path: "wrkr/SNIP" }, number: 5 } } }]);
  });
});

describe("the Linear issue a pull request links", () => {
  test("is found by a closing or referencing keyword before the team's key, and only that team's", async () => {
    const { linkedLinearIssue } = await import("../../.shared/work-items.ts");
    const items = { host: "linear.app", path: "wrkr/SNIP" };
    expect(linkedLinearIssue(items, "Shortens links.\n\nCloses SNIP-12")).toBe(12);
    expect(linkedLinearIssue(items, "Refs snip-3")).toBe(3);
    expect(linkedLinearIssue(items, "Closes AIF-12")).toBeNull();
    expect(linkedLinearIssue(items, "Closes #12")).toBeNull();
  });
});
