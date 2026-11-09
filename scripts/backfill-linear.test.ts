// Our install (AIF-150): reconcile leaves a Linear factory's issues to the Linear webhook.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { archonDb } from '../db/test-db';
import type { GitHub } from '../function/github';
import { readHistory, storeHistory } from './backfill';
import type { Db } from './lib/db';
import { migrationsDir, readMigrationFiles, runMigrations } from './migrate';

let db: Db;
beforeEach(async () => {
  db = await archonDb();
  await runMigrations({
    files: readMigrationFiles(migrationsDir(resolve(import.meta.dir, '..'))),
    db,
  });
});
afterEach(() => db.close());

const AT = '2026-11-01T00:00:00Z';
const listed = (number: number, pull: boolean) => ({
  number,
  title: pull ? `PR ${number}` : `GitHub issue ${number}`,
  state: 'open',
  body: '',
  html_url: `https://github.com/schieble/snip/${pull ? 'pull' : 'issues'}/${number}`,
  created_at: AT,
  updated_at: AT,
  closed_at: null,
  labels: [],
  ...(pull ? { pull_request: {} } : {}),
});
// The fake answers the versions repository's reads with nothing to pin and an empty decisions file.
const github = {
  list: async (path: string) =>
    path.includes('/issues?') ? [listed(3, false), listed(4, true)] : [],
  get: async () => ({ default_branch: 'main' }),
  fileAt: async () => '# Decisions\n',
} as unknown as GitHub;

test("a Linear factory's GitHub issues are not written, its Linear issues stay, and its old GitHub rows go", async () => {
  await db.query(
    `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
      VALUES ('snip', 7, 'From Linear', 'open', 'https://linear.app/wrkr/issue/SNIP-7', $1, $1),
             ('snip', 2, 'From GitHub, before the move', 'open', 'https://github.com/schieble/snip/issues/2', $1, $1)`,
    [AT],
  );
  const history = await readHistory(github, [
    { name: 'snip', repository: 'schieble/snip', work_items: 'linear.app/wrkr/SNIP' },
  ]);
  expect(history.factories[0]).toMatchObject({ issues: [], linearIssues: true });
  await storeHistory(db, history, '2026-11-08T00:00:00Z');
  expect(await db.query('SELECT number, title FROM mc.issues ORDER BY number')).toEqual([
    { number: 7, title: 'From Linear' },
  ]);
});

test('a GitHub factory is still written and pruned from GitHub', async () => {
  await db.query(
    `INSERT INTO mc.issues (factory, number, title, state, url, created_at, updated_at)
      VALUES ('other', 9, 'gone', 'open', 'u', $1, $1)`,
    [AT],
  );
  const history = await readHistory(github, [{ name: 'other', repository: 'schieble/other' }]);
  await storeHistory(db, history, '2026-11-08T00:00:00Z');
  expect(await db.query('SELECT number FROM mc.issues ORDER BY number')).toEqual([{ number: 3 }]);
});
