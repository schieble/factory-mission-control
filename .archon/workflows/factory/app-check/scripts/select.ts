import { emit, env, ghJson, linkedIssue } from "../../.shared/utils.ts";
import { isLinear, linkedLinearIssue, viewLinearIssue, workItems } from "../../.shared/work-items.ts";
import { currentBranchOid } from "./base.ts";
import { statusJudgesHead, type CommitStatus } from "./binding.ts";

export interface Candidate { number: number; isDraft: boolean; createdAt: string; headRefOid: string; baseRefName: string; baseRefOid: string; files: { path: string }[]; body: string; state?: string; mergeable?: string }
type PullCandidate = Omit<Candidate, "baseRefOid"> & { baseRefOid?: string };
export function oldestUnchecked(rows: Candidate[], judgedHeads: Set<string>): Candidate | null {
  // A conflicting pull request cannot be merged with its base for testing; checking it first would starve every newer one.
  return rows.filter(row => (!row.state || row.state === "OPEN") && row.mergeable !== "CONFLICTING" && !judgedHeads.has(row.headRefOid)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

function hasResult(repo: string, row: Candidate): boolean {
  const statuses = ghJson(["api", `repos/${repo}/commits/${row.headRefOid}/statuses`]) as CommitStatus[];
  return statusJudgesHead(statuses);
}

if (import.meta.main) {
  const repo = env("repo_path"), requested = env("pr");
  const fields = "number,isDraft,createdAt,headRefOid,baseRefName,baseRefOid,files,body,state,mergeable";
  const pullRows = requested
    ? [ghJson(["pr", "view", requested, "--repo", repo, "--json", fields]) as PullCandidate]
    : ghJson(["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", fields]) as PullCandidate[];
  const baseTips = new Map<string, string>();
  const rows = pullRows.map(row => {
    const baseRefOid = baseTips.get(row.baseRefName) ?? currentBranchOid(repo, row.baseRefName);
    baseTips.set(row.baseRefName, baseRefOid);
    return { ...row, baseRefOid } as Candidate;
  });
  const judged = new Set(requested ? [] : rows.filter(row => hasResult(repo, row)).map(row => row.headRefOid));
  const picked = requested ? (rows[0]?.state === "OPEN" ? rows[0] : null) : oldestUnchecked(rows, judged);
  if (!picked) emit({ found: false, pr: null, head: "", files: [], base: "", base_oid: "", issue: null, issue_body: "", issue_labels: [] });
  else {
    // Our install (AIF-150): in a Linear project the linked issue is a Linear issue.
    const items = workItems();
    const linear = isLinear(items);
    const issue = linear ? linkedLinearIssue(items, picked.body) : linkedIssue(picked.body);
    const detail = !issue ? null
      : linear ? (({ body, labels }) => ({ body, labels: labels.map(name => ({ name })) }))(viewLinearIssue(items, issue))
      : ghJson(["issue", "view", String(issue), "--repo", repo, "--json", "body,labels"]);
    emit({ found: true, pr: picked.number, head: picked.headRefOid, files: picked.files.map(file => file.path), base: picked.baseRefName, base_oid: picked.baseRefOid, issue,
      issue_body: detail?.body ?? "", issue_labels: (detail?.labels ?? []).map((label: { name: string }) => label.name) });
  }
}
