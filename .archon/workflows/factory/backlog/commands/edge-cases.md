# List the edge cases the PRD implies

Our install (AIF-153). Read `$INPUTS.prd`, MISSION.md, and `$ARTIFACTS_DIR/backlog.json`, which the slice step wrote. A PRD names the main paths and leaves out behaviours any user would assume. Builders miss them, and a test written from the ticket never covers them: for example a short link opened with a trailing slash (`/<id>/`) that returns 404 instead of the link.

List the behaviours this PRD implies but does not state. Work through each surface the backlog creates (every route, command, form, input, stored value and time rule) and ask:

- **Addressing:** trailing slash, letter case, repeated or missing separators, query strings and fragments on the same path, HEAD next to GET.
- **Input:** empty, whitespace-only, too long, unicode and percent-encoded text, unexpected types, duplicates, the same input submitted twice.
- **Limits and time:** exactly at a limit and one past it, expiry at the instant it happens, clock and timezone edges, ordering of things created in the same second.
- **Absence and failure:** unknown or malformed ids, deleted or expired items, dependencies down, restart with existing data.

Keep a behaviour only when a user of this product would notice it and the PRD settles, or clearly implies, what should happen. Pick the conventional answer that fits the PRD and MISSION.md. Never add a feature, endpoint or setting. When the PRD leaves the answer genuinely open, leave it out instead of guessing. Never list a criterion that contradicts what a ticket already says in its Outcome, Invariants or Acceptance: the builder can't satisfy both, so leave that behaviour out and name it in your summary. Skip a behaviour a ticket's Acceptance already covers. Cover the product's main surfaces, but keep the list short enough to build: at most 6 per ticket.

For each behaviour you keep, choose the ticket that builds the surface it concerns, and write one criterion: one line, one observable exact outcome, written like that ticket's Acceptance items (for example `GET /abc123/ redirects to the same target as GET /abc123`).

Do not edit backlog.json. Write `$ARTIFACTS_DIR/edge-cases.json`, a JSON array with one object per behaviour:

`{ "key": "<ticket key>", "behaviour": "short name of the implied behaviour", "criterion": "<the one-line criterion>" }`

The next step adds each criterion to the end of its ticket's `## Acceptance` checklist. Write `[]` if the PRD implies nothing beyond what the tickets already state. Return the count and a one-line summary of what you listed and what you left out.
