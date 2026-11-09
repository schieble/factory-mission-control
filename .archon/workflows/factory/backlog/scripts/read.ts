import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { emit, env, ghJson } from "../../.shared/utils.ts";
import { isLinear, viewLinearIssue, workItems } from "../../.shared/work-items.ts";

const repo = env("repo_path"), number = env("number"), named = env("prd_path");
if (Boolean(number) === Boolean(named)) throw new Error("provide exactly one of number or prd_path");
let source: string, text: string;
const items = workItems();
// Our install (AIF-150): in a Linear project the PRD issue is a Linear issue.
if (number && isLinear(items)) { const issue = viewLinearIssue(items, Number(number)); source = issue.url; text = issue.body; }
else if (number) { const issue = ghJson(["issue", "view", number, "--repo", repo, "--json", "body,url"]); source = issue.url; text = issue.body; }
else {
  const root = resolve("."), path = resolve(named);
  if (isAbsolute(named) && !path.startsWith(root) || relative(root, path).startsWith("..") || !existsSync(path)) throw new Error("prd_path must be a file inside the checkout");
  source = relative(root, path); text = readFileSync(path, "utf8");
}
if (text.trim().length < 200) throw new Error("PRD is too short (minimum 200 characters)");
const path = `${process.env.ARTIFACTS_DIR}/backlog-prd.md`;
await Bun.write(path, text);
emit({ source, path, characters: text.length });
