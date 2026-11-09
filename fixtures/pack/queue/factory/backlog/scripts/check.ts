import { existsSync, writeFileSync } from "node:fs";
import { emit, readJsonFile } from "../../.shared/utils.ts";

const REQUIRED = ["Problem", "Why", "Why now", "Outcome", "Invariants", "Acceptance"];
const CHECKLIST_ITEM = /^\s*- \[[ xX]\]\s+(.*?)\s*$/;
const ACCEPTANCE_HEADING = /^## Acceptance[ \t\r]*$/i;

/** The body's lines and the indexes of its Acceptance section: after the heading, up to the next heading. */
function acceptanceSection(body: string): { lines: string[]; indexes: number[] } {
  const lines = body.split("\n"), heading = lines.findIndex(line => ACCEPTANCE_HEADING.test(line)), indexes: number[] = [];
  if (heading >= 0) for (let i = heading + 1; i < lines.length && !lines[i].startsWith("## "); i++) indexes.push(i);
  return { lines, indexes };
}
function acceptanceItems(body: string): string[] {
  const { lines, indexes } = acceptanceSection(body);
  return indexes.map(i => lines[i].match(CHECKLIST_ITEM)?.[1]).filter((item): item is string => item !== undefined);
}

export function validateBacklog(value: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(value)) return ["backlog.json must be an array"];
  if (value.length > 12) errors.push("backlog exceeds 12 tickets");
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    const ticket = raw as any, key = ticket?.key;
    if (typeof key !== "string" || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(key)) errors.push(`ticket ${index + 1} has an invalid key`);
    else if (seen.has(key)) errors.push(`duplicate key ${key}`);
    if (typeof ticket?.title !== "string" || !ticket.title.trim()) errors.push(`${key ?? index + 1} needs a title`);
    if (typeof ticket?.body !== "string") errors.push(`${key ?? index + 1} needs a body`);
    else {
      for (const heading of REQUIRED) if (!new RegExp(`^## ${heading}\\s*$`, "mi").test(ticket.body)) errors.push(`${key} lacks ${heading}`);
      if (!ticket.body.includes(`<!-- factory-backlog: ${key} -->`)) errors.push(`${key} lacks its dedup marker`);
      if (!acceptanceItems(ticket.body).length) errors.push(`${key} acceptance is not a checklist`);
    }
    const deps = ticket?.depends_on;
    if (!Array.isArray(deps) || deps.some((dep: unknown) => typeof dep !== "string" || !seen.has(dep))) errors.push(`${key} dependencies must name earlier tickets`);
    if (index === 0 && deps?.length) errors.push("first ticket must have no dependencies");
    if (!["s", "m", "l"].includes(ticket?.size)) errors.push(`${key} size must be s, m, or l`);
    if (typeof key === "string") seen.add(key);
  });
  return errors;
}

// Our install (AIF-153): the edge-cases node lists the behaviours the PRD implies, and this
// step merges each criterion into its ticket's Acceptance. The agent never edits backlog.json,
// so it cannot drop or reword what slice wrote.
type EdgeCase = { key: string; behaviour: string; criterion: string };

export function validateEdgeCases(tickets: any[], value: unknown): string[] {
  if (!Array.isArray(value)) return ["edge-cases.json must be an array"];
  const keys = new Set(tickets.map(ticket => ticket.key));
  return value.flatMap((raw, index) => {
    const edge = raw as any, label = `edge case ${index + 1}`;
    if (!["key", "behaviour", "criterion"].every(field => typeof edge?.[field] === "string" && edge[field].trim())) return [`${label} needs key, behaviour and criterion`];
    if (!keys.has(edge.key)) return [`${label} (${edge.behaviour}) names unknown ticket ${edge.key}`];
    if (/[\r\n]/.test(edge.criterion.trim())) return [`${label} (${edge.behaviour}) criterion must be one line`];
    return [];
  });
}

/** Adds each criterion after the last checklist item of its ticket's Acceptance, once. */
export function applyEdgeCases(tickets: any[], edgeCases: EdgeCase[]): any[] {
  return tickets.map(ticket => {
    let body: string = ticket.body;
    for (const { criterion } of edgeCases.filter(edge => edge.key === ticket.key)) {
      if (acceptanceItems(body).includes(criterion.trim())) continue;
      const { lines, indexes } = acceptanceSection(body);
      const last = indexes.findLast(i => CHECKLIST_ITEM.test(lines[i]))!;
      lines.splice(last + 1, 0, `- [ ] ${criterion.trim()}`);
      body = lines.join("\n");
    }
    return body === ticket.body ? ticket : { ...ticket, body };
  });
}

if (import.meta.main) {
  const backlogPath = `${process.env.ARTIFACTS_DIR}/backlog.json`, edgeCasesPath = `${process.env.ARTIFACTS_DIR}/edge-cases.json`;
  const tickets = readJsonFile<any[]>(backlogPath);
  if (!existsSync(edgeCasesPath)) throw new Error("edge-cases.json is missing: the edge-cases node must list the implied behaviours it found (an empty array if none)");
  const edgeCases = readJsonFile<unknown>(edgeCasesPath);
  const errors = validateBacklog(tickets);
  if (!errors.length) errors.push(...validateEdgeCases(tickets, edgeCases));
  if (errors.length) throw new Error(errors.join("\n"));
  const merged = applyEdgeCases(tickets, edgeCases as EdgeCase[]);
  writeFileSync(backlogPath, JSON.stringify(merged, null, 2));
  emit({ count: merged.length, keys: merged.map((ticket: any) => ticket.key), edge_cases: (edgeCases as unknown[]).length });
}
