import { describe, expect, test } from "bun:test";
import { judgeProduction, needsCheck } from "../scripts/deploy-check.ts";

const MERGE = "0123456789abcdef0123456789abcdef01234567";
const NEWER = "fedcba9876543210fedcba9876543210fedcba98";
const found = { kind: "found" as const, url: "https://tally-abc.vercel.app" };
const healthy = { status: 200, body: JSON.stringify({ ok: true, commit: MERGE }) };

describe("a merge commit's production deploy", () => {
  test("passes when production is deployed, healthy and reports exactly that commit", () => {
    expect(judgeProduction({ merge: MERGE, tip: MERGE, lookup: found, health: healthy })).toEqual({ state: "success", reason: `production serves ${MERGE.slice(0, 7)} and is healthy` });
  });

  test("fails when Vercel's production deploy failed, or none succeeded in time", () => {
    const failed = judgeProduction({ merge: MERGE, tip: MERGE, lookup: { kind: "failed", detail: "Production: error" }, health: null });
    expect(failed.state).toBe("failure");
    expect(failed.reason).toContain("Production: error");
    const late = judgeProduction({ merge: MERGE, tip: MERGE, lookup: { kind: "timeout", detail: "Production: in_progress" }, health: null, timeoutMinutes: 15 });
    expect(late).toEqual({ state: "failure", reason: `no production deploy of ${MERGE.slice(0, 7)} succeeded within 15 minutes (Production: in_progress)` });
  });

  test("fails when the health route does not answer 2xx, or cannot be reached", () => {
    expect(judgeProduction({ merge: MERGE, tip: MERGE, lookup: found, health: { status: 500, body: "boom" } }).reason).toContain("answered HTTP 500");
    expect(judgeProduction({ merge: MERGE, tip: MERGE, lookup: found, health: { status: 0, body: "", error: "connection refused" } }).reason).toContain("connection refused");
  });

  test("fails when production does not say which commit it serves", () => {
    const silent = judgeProduction({ merge: MERGE, tip: MERGE, lookup: found, health: { status: 200, body: "ok" } });
    expect(silent.state).toBe("failure");
    expect(silent.reason).toContain("reports no commit");
  });

  test("fails when production serves another commit, unless a newer merge replaced it", () => {
    const stale = { status: 200, body: JSON.stringify({ commit: NEWER }) };
    expect(judgeProduction({ merge: MERGE, tip: MERGE, lookup: found, health: stale }).state).toBe("failure");
    expect(judgeProduction({ merge: MERGE, tip: NEWER, lookup: found, health: stale })).toEqual({ state: "superseded", reason: `superseded: ${NEWER.slice(0, 7)} was merged after it` });
  });
});

describe("which default-branch tip still needs its deploy checked", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  test("one with no factory/deploy result", () => {
    expect(needsCheck([{ context: "factory/app-check", state: "success" }], now)).toBe(true);
  });
  test("not one already judged, superseded or being checked", () => {
    for (const state of ["success", "failure", "error"]) expect(needsCheck([{ context: "factory/deploy", state }], now)).toBe(false);
    expect(needsCheck([{ context: "factory/deploy", state: "pending", created_at: "2026-11-11T11:50:00Z" }], now)).toBe(false);
  });
  test("one whose check died: pending for over an hour", () => {
    expect(needsCheck([{ context: "factory/deploy", state: "pending", created_at: "2026-11-11T10:30:00Z" }], now)).toBe(true);
  });
});
