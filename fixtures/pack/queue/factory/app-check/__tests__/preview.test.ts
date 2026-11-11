import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceProblems } from "../scripts/evidence.ts";
import { writeUnavailable } from "../scripts/preview.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

describe("an app check on a pull request's preview", () => {
  test("a preview that failed or never came up is one INCOMPLETE line with its reason, and the evidence check accepts it", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-preview-test-"));
    const preparedAt = Date.now() - 1000;
    writeUnavailable(root, HEAD, "no preview deployment of 0123456 succeeded within 15 minutes (Preview: in_progress)", [{ environment: "Preview", statuses: [] }]);
    const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    expect(result.overall).toBe("FAIL");
    expect(result.lines).toEqual(["C1  INCOMPLETE  The Vercel preview of 0123456 is not available: no preview deployment of 0123456 succeeded within 15 minutes (Preview: in_progress).  evidence: preview.json"]);
    expect(JSON.parse(readFileSync(join(root, "preview.json"), "utf8")).head).toBe(HEAD);
    expect(evidenceProblems(result, readFileSync(join(root, "report.md"), "utf8"), root, preparedAt)).toEqual([]);
  });

  test("a reason with runs of spaces still makes a well-formed line", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-preview-test-"));
    writeUnavailable(root, HEAD, "Preview: failure  (build   exited 1)\nsee log", []);
    for (const file of ["result.json", "report.md", "preview.json"]) utimesSync(join(root, file), new Date(), new Date());
    const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    expect(evidenceProblems(result, readFileSync(join(root, "report.md"), "utf8"), root, Date.now() - 5000)).toEqual([]);
  });
});
