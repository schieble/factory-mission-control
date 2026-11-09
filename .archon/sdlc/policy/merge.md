# Merge policy

Add project-specific required checks and merge authority above this managed block.

## Approved in advance

The owner approves these cases now, so the queue merges them without asking. For these cases only, this overrides the default policy's unclear line "A persisted schema, a migration, or any stored or wire format", and the managed block below counts it as written merge policy that permits the merge. Anything else unclear in the same pull request still asks. To class a pull request against this section, read its issue first.

- **The first schema.** A pull request that creates the product's first persisted schema, with the migration or code that creates it, is clear when the default branch stores nothing yet: no table, migration or schema file, and no code that creates one. Judge that from the default branch, not from the pull request's description. The schema stores only what the pull request's issue asks for. One pull request per sweep can use this: once one first-schema pull request merges, any other that adds a schema is a later schema change.
- **Dependencies the issue names.** A new dependency the pull request's issue names is clear.

Every later schema change asks: a pull request that changes, extends or migrates a schema the default branch already has is unclear, even when its issue asks for it.

<!-- FACTORY AUTONOMY: START (managed by factory-setup) -->
Preset: standard
- Merge only when written merge policy clearly permits it and evidence is fresh for the exact head; otherwise ask.
<!-- FACTORY AUTONOMY: END -->

A red `factory/app-check` at a pull request's head is a finding about this change, even on a pull request the owner approved. Do not wait on it and do not ask: return the pull request to the build queue, with a brief that says to read the check's comment on the pull request and fix what it names. A check that did not finish says so in its status; that one waits for the next check, it is not a finding.
