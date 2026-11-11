import { describe, expect, test } from "bun:test";
import { type Deployment, previewOf, productionOf } from "../../.shared/deployments.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
// GitHub lists a deployment's statuses newest first.
const deployment = (environment: string, ...statuses: [string, string?][]): Deployment => ({
  id: 1,
  sha: SHA,
  environment,
  production: false,
  statuses: statuses.map(([state, url]) => (url ? { state, url } : { state })),
});

describe("a pull request's preview", () => {
  test("is the address of its preview deployment's success", () => {
    const lookup = previewOf([deployment("Preview", ["success", "https://tally-git-x.vercel.app"], ["in_progress"], ["pending"])]);
    expect(lookup).toEqual({ kind: "found", url: "https://tally-git-x.vercel.app" });
  });

  test("still serves once a newer preview made it inactive", () => {
    const lookup = previewOf([deployment("Preview", ["inactive"], ["success", "https://tally-git-x.vercel.app"])]);
    expect(lookup).toEqual({ kind: "found", url: "https://tally-git-x.vercel.app" });
  });

  test("is waited for while it builds or before GitHub has one", () => {
    expect(previewOf([deployment("Preview", ["in_progress"], ["pending"])]).kind).toBe("pending");
    expect(previewOf([])).toEqual({ kind: "pending", detail: "GitHub has no preview deployment of it" });
  });

  test("failed when every preview deployment of it ended in failure or error", () => {
    const lookup = previewOf([deployment("Preview", ["failure"]), deployment("Preview", ["error"])]);
    expect(lookup.kind).toBe("failed");
    expect(previewOf([deployment("Preview", ["failure"]), deployment("Preview", ["in_progress"])]).kind).toBe("pending");
  });

  test("is never its production deployment", () => {
    const production = { ...deployment("Production", ["success", "https://tally.example.com"]), production: true };
    const lookup = previewOf([production]);
    expect(lookup.kind).toBe("failed");
    expect(lookup.kind === "failed" && lookup.detail).toContain("only to Production");
  });

  test("is not guessed among several preview environments", () => {
    const lookup = previewOf([deployment("Preview", ["success", "https://a.vercel.app"]), deployment("Storybook", ["success", "https://b.vercel.app"])]);
    expect(lookup.kind).toBe("failed");
    expect(lookup.kind === "failed" && lookup.detail).toContain("Preview, Storybook");
  });
});

describe("a merge commit's production deployment", () => {
  test("is found by the production flag or the environment's name", () => {
    expect(productionOf([{ ...deployment("tally-prod", ["success", "https://tally-abc.vercel.app"]), production: true }]))
      .toEqual({ kind: "found", url: "https://tally-abc.vercel.app" });
    expect(productionOf([deployment("Production", ["success", "https://tally-abc.vercel.app"])]).kind).toBe("found");
  });

  test("ignores the commit's preview, and is waited for until production has one", () => {
    expect(productionOf([deployment("Preview", ["success", "https://tally-git-x.vercel.app"])])).toEqual({ kind: "pending", detail: "GitHub has no production deployment of it" });
  });

  test("failed when its production deployment failed", () => {
    const lookup = productionOf([{ ...deployment("Production", ["error"], ["in_progress"]), production: true }]);
    expect(lookup).toEqual({ kind: "failed", detail: "Production: error" });
  });
});
