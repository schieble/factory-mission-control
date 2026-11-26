import { emit, env, ghJson, readJsonFile, run } from "../../.shared/utils.ts";
import { createLinearIssue, ensureLinearLabel, intakeLabel, isLinear, itemKey, labelLinearIssue, workItems } from "../../.shared/work-items.ts";

const repo = env("repo_path"), tickets = readJsonFile<any[]>(`${process.env.ARTIFACTS_DIR}/backlog.json`);
// Our install (AIF-150): a project whose work items are in Linear gets Linear issues, never GitHub ones.
const items = workItems();
// Our install (AIF-188): a Linear product that opts tickets in by label gets it on every ticket
// published here, so intake takes the PRD's tickets. Tickets already published are labeled too, in
// case an earlier run stopped between filing and labeling. (factory-config.ts allows the label
// only with Linear work items.)
const label = intakeLabel();
const created: string[] = [], existing: string[] = [], numbers = new Map<string, number>();
const dependencies = (ticket: any) => ticket.depends_on.map((key: string) => `Depends on: ${itemKey(items, numbers.get(key)!)}`).join("\n");
if (isLinear(items)) {
  if (label) ensureLinearLabel(items, label, "The factory takes this ticket (intake label)");
  for (const ticket of tickets) {
    // The plugin finds an issue again by its description's first line, so the marker leads.
    const marker = `<!-- factory-backlog: ${ticket.key} -->`, deps = dependencies(ticket);
    const body = `${marker}\n${ticket.body.replace(marker, "").trim()}${deps ? `\n\n${deps}` : ""}\n`;
    const issue = createLinearIssue(items, ticket.title, body, marker);
    (issue.created ? created : existing).push(issue.url); numbers.set(ticket.key, issue.number);
    if (label) labelLinearIssue(items, issue.number, label);
  }
  emit({ published: true, created, existing });
} else {
  const listed = ghJson(["issue", "list", "--repo", repo, "--state", "all", "--limit", "1000", "--json", "number,url,body"]) as any[];
  for (const ticket of tickets) {
    const marker = `<!-- factory-backlog: ${ticket.key} -->`;
    const prior = listed.find(issue => issue.body?.includes(marker));
    if (prior) { existing.push(prior.url); numbers.set(ticket.key, prior.number); continue; }
    const deps = dependencies(ticket);
    const body = ticket.body.replace(marker, "").trim() + (deps ? `\n\n${deps}` : "") + `\n\n${marker}\n`;
    const file = `${process.env.ARTIFACTS_DIR}/issue-${ticket.key}.md`; await Bun.write(file, body);
    const url = run(["gh", "issue", "create", "--repo", repo, "--title", ticket.title, "--body-file", file]);
    const number = Number(url.match(/\/(\d+)$/)?.[1]);
    if (!number) throw new Error(`could not read created issue URL: ${url}`);
    created.push(url); numbers.set(ticket.key, number); listed.push({ url, number, body });
  }
  emit({ published: true, created, existing });
}
