# Slice the PRD into an SDLC-ready backlog

Read `$INPUTS.prd`, MISSION.md, repository guidance, and enough existing code/issues in `$INPUTS.repo_path` to avoid duplicate work. Our install (AIF-150): when `.archon/factory.yaml` sets `work_items` to a Linear team (`host: linear.app`, `path: <workspace>/<TEAM>`), the issues are that team's, not GitHub's: search them with `linear-search <workspace>/<TEAM> <terms>`. Write `$ARTIFACTS_DIR/backlog.json`, an ordered JSON array with at most 12 objects:

`{ "key": "stable-slug", "title": "imperative outcome", "body": "...", "depends_on": [earlier keys], "size": "s|m|l" }`

Every body must contain these exact Markdown headings and substantive content: `## Problem`, `## Why`, `## Why now`, `## Outcome`, `## Invariants`, `## Acceptance`. Acceptance is a checklist of observable exact outcomes. Append `<!-- factory-backlog: <key> -->` as the final line. The first ticket has no dependencies and makes the product runnable end to end. Later tickets are one reviewable change, depend only on earlier tickets they genuinely require, preserve MISSION.md, and maximize independent work. An empty list is valid if everything is already covered. Do not create issues here. Return count and a concise ordering summary.
