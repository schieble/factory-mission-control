import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeCommand, isolatedCommandEnv } from "../../.shared/test-command.ts";
import { applyEdgeCases, validateBacklog, validateEdgeCases } from "../scripts/check.ts";

const body = (key: string) => `## Problem\nA real problem.\n## Why\nUser value.\n## Why now\nNeeded now.\n## Outcome\nA running outcome.\n## Invariants\n- Keep data.\n## Acceptance\n- [ ] Observable result\n\n<!-- factory-backlog: ${key} -->`;
const slash = "GET /abc123/ resolves exactly like GET /abc123";

// Our install (AIF-153): the edge-cases node lists implied behaviours; check merges them into Acceptance.
describe("edge-case merge", () => {
  const tickets = [
    { key: "first-run", title: "Run the core path", body: body("first-run"), depends_on: [], size: "s" },
    { key: "next-step", title: "Add the next step", body: body("next-step"), depends_on: ["first-run"], size: "m" },
  ];
  const trailingSlash = { key: "first-run", behaviour: "Trailing slash on a short link", criterion: slash };
  test("adds each criterion as the last checklist item of its ticket's Acceptance and changes nothing else", () => {
    const merged = applyEdgeCases(tickets, [trailingSlash]);
    expect(merged[0]).toEqual({ ...tickets[0], body: `## Problem\nA real problem.\n## Why\nUser value.\n## Why now\nNeeded now.\n## Outcome\nA running outcome.\n## Invariants\n- Keep data.\n## Acceptance\n- [ ] Observable result\n- [ ] ${slash}\n\n<!-- factory-backlog: first-run -->` });
    expect(merged[1]).toEqual(tickets[1]);
    expect(validateBacklog(merged)).toEqual([]);
  });
  test("inserts before a section that follows Acceptance", () => {
    const later = [{ ...tickets[0], body: "## Acceptance\n- [ ] One\n\n## Notes\nText." }];
    expect(applyEdgeCases(later, [trailingSlash])[0].body).toBe(`## Acceptance\n- [ ] One\n- [ ] ${slash}\n\n## Notes\nText.`);
  });
  test("inserts after the last item when a blank line follows the Acceptance heading", () => {
    const spaced = [{ ...tickets[0], body: "## Acceptance\n\n- [ ] One\n- [ ] Two\n\n<!-- factory-backlog: first-run -->" }];
    expect(applyEdgeCases(spaced, [trailingSlash])[0].body).toBe(`## Acceptance\n\n- [ ] One\n- [ ] Two\n- [ ] ${slash}\n\n<!-- factory-backlog: first-run -->`);
  });
  test("does not add a criterion the ticket's Acceptance already has", () => {
    const once = applyEdgeCases(tickets, [trailingSlash]);
    expect(applyEdgeCases(once, [trailingSlash])).toEqual(once);
  });
  test("accepts an empty list, and rejects unknown tickets and malformed entries", () => {
    expect(validateEdgeCases(tickets, [])).toEqual([]);
    expect(validateEdgeCases(tickets, [trailingSlash])).toEqual([]);
    expect(validateEdgeCases(tickets, [{ key: "nope", behaviour: "B", criterion: "C" }, { key: "first-run" }, "x", { ...trailingSlash, criterion: "two\nlines" }])).toEqual([
      "edge case 1 (B) names unknown ticket nope",
      "edge case 2 needs key, behaviour and criterion",
      "edge case 3 needs key, behaviour and criterion",
      "edge case 4 (Trailing slash on a short link) criterion must be one line",
    ]);
    expect(validateEdgeCases(tickets, {})).toEqual(["edge-cases.json must be an array"]);
  });
});

describe("backlog check", () => {
  test("accepts a clean ordered slice", () => {
    expect(validateBacklog([
      { key: "first-run", title: "Run the core path", body: body("first-run"), depends_on: [], size: "s" },
      { key: "next-step", title: "Add the next step", body: body("next-step"), depends_on: ["first-run"], size: "m" },
    ])).toEqual([]);
  });
  test("rejects missing contract elements and forward dependencies", () => {
    const errors = validateBacklog([{ key: "bad", title: "Bad", body: "<!-- factory-backlog: bad -->", depends_on: ["later"], size: "xl" }]);
    expect(errors.some(error => error.includes("lacks Problem"))).toBe(true);
    expect(errors.some(error => error.includes("earlier tickets"))).toBe(true);
  });
  test("check and publish entrypoints accept a BOM backlog while malformed JSON still fails", () => {
    const artifacts = mkdtempSync(join(tmpdir(), "factory-backlog-entrypoint-test-"));
    const backlogPath = join(artifacts, "backlog.json");
    const tickets = [{ key: "first-run", title: "Run the core path", body: body("first-run"), depends_on: [], size: "s" }];
    writeFileSync(backlogPath, `\uFEFF${JSON.stringify(tickets)}`);
    writeFileSync(join(artifacts, "edge-cases.json"), "\uFEFF[]");
    const env = { ...process.env, ARTIFACTS_DIR: artifacts };
    const checked = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "scripts", "check.ts")], { env, stdout: "pipe", stderr: "pipe" });
    expect(checked.exitCode, checked.stderr.toString()).toBe(0);
    expect(JSON.parse(checked.stdout.toString())).toEqual({ count: 1, keys: ["first-run"], edge_cases: 0 });

    const log = join(artifacts, "gh.log");
    installFakeCommand(artifacts, "gh", `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.GH_LOG!, JSON.stringify(args) + "\\n");
if (args[0] === "issue" && args[1] === "list") console.log("[]");
else throw new Error("unexpected gh arguments: " + JSON.stringify(args));
`);
    writeFileSync(backlogPath, "\uFEFF[]");
    const published = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "scripts", "publish.ts")], {
      env: isolatedCommandEnv(artifacts, { ARTIFACTS_DIR: artifacts, GH_LOG: log, INPUTS_REPO_PATH: "example/widgets" }),
      stdout: "pipe", stderr: "pipe",
    });
    expect(published.exitCode, published.stderr.toString()).toBe(0);
    expect(JSON.parse(published.stdout.toString())).toEqual({ published: true, created: [], existing: [] });
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["issue", "list"]);

    writeFileSync(backlogPath, '\uFEFF[{"key":');
    const malformed = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "scripts", "check.ts")], { env, stdout: "pipe", stderr: "pipe" });
    expect(malformed.exitCode).not.toBe(0);
  });
  test("check fails when the edge-cases node left no list, and merges the cases it did list into backlog.json", () => {
    const artifacts = mkdtempSync(join(tmpdir(), "factory-backlog-edge-cases-test-"));
    const backlog = join(artifacts, "backlog.json");
    writeFileSync(backlog, JSON.stringify([{ key: "first-run", title: "Run", body: body("first-run"), depends_on: [], size: "s" }]));
    const check = () => Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "scripts", "check.ts")], { env: { ...process.env, ARTIFACTS_DIR: artifacts }, stdout: "pipe", stderr: "pipe" });
    const missing = check();
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain("edge-cases.json");
    writeFileSync(join(artifacts, "edge-cases.json"), JSON.stringify([{ key: "first-run", behaviour: "Trailing slash", criterion: slash }]));
    const checked = check();
    expect(checked.exitCode, checked.stderr.toString()).toBe(0);
    expect(JSON.parse(checked.stdout.toString())).toEqual({ count: 1, keys: ["first-run"], edge_cases: 1 });
    expect(JSON.parse(readFileSync(backlog, "utf8"))[0].body).toContain(`- [ ] Observable result\n- [ ] ${slash}\n`);
  });
});
