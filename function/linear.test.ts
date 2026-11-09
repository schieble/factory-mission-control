// Our install (AIF-150): Linear's webhook deliveries mirror a Linear factory's issues.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { archonDb } from '../db/test-db';
import type { Db } from '../scripts/lib/db';
import { migrationsDir, readMigrationFiles, runMigrations } from '../scripts/migrate';
import { createWebhookApp } from './app';
import { createGitHub } from './github';
import { type LinearDelivery, type LinearIssueData, signLinear } from './linear';
import { sign } from './signature';

const repoRoot = resolve(import.meta.dir, '..');
const LINEAR_SECRET = 'lin-secret';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const FACTORIES = [
  { name: 'snip', repository: 'schieble/snip', work_items: 'linear.app/wrkr/SNIP' },
  { name: 'other', repository: 'schieble/other' },
];

let db: Db;
let app: ReturnType<typeof createWebhookApp>;
beforeEach(async () => {
  db = await archonDb();
  await runMigrations({ files: readMigrationFiles(migrationsDir(repoRoot)), db });
  app = createWebhookApp({
    secret: 'gh-secret',
    linearSecret: LINEAR_SECRET,
    now: () => NOW,
    db,
    factories: FACTORIES,
    github: createGitHub(async () => new Response('{}')),
  });
});
afterEach(() => db.close());

const issue = (overrides: Partial<LinearIssueData> = {}): LinearIssueData => ({
  id: 'issue-7',
  number: 7,
  title: 'Shorten links',
  description: 'Make links short.\n\nDepends on: SNIP-3',
  url: 'https://linear.app/wrkr/issue/SNIP-7/shorten-links',
  createdAt: '2026-11-08T11:00:00Z',
  updatedAt: '2026-11-08T11:59:00Z',
  state: { type: 'unstarted', name: 'Todo' },
  labels: [{ id: 'l-ready', name: 'archon-ready' }],
  labelIds: ['l-ready'],
  team: { key: 'SNIP' },
  ...overrides,
});

const delivery = (overrides: Partial<LinearDelivery> = {}): LinearDelivery => ({
  action: 'create',
  type: 'Issue',
  data: issue(),
  webhookTimestamp: NOW - 1_000,
  ...overrides,
});

async function post(body: unknown, signature?: string): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify(body)) as Uint8Array<ArrayBuffer>;
  const headers = {
    'content-type': 'application/json',
    'linear-signature': signature ?? (await signLinear(LINEAR_SECRET, bytes)),
  };
  return app.request('/linear', { method: 'POST', headers, body: bytes });
}

const rows = async () => ({
  issues: await db.query(
    'SELECT factory, number, title, state, url, close_reason FROM mc.issues ORDER BY number',
  ),
  labels: await db.query(
    'SELECT issue_number, label, labeled_at IS NOT NULL AS timed FROM mc.issue_labels ORDER BY label',
  ),
  deps: await db.query('SELECT issue_number, depends_on FROM mc.issue_dependencies'),
});

test('a new issue in a followed team is mirrored under its factory, with its labels and dependencies', async () => {
  const response = await post(delivery());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ event: 'linear Issue', written: true });
  const { issues, labels, deps } = await rows();
  expect(issues).toEqual([
    {
      factory: 'snip',
      number: 7,
      title: 'Shorten links',
      state: 'open',
      url: issue().url,
      close_reason: null,
    },
  ]);
  expect(labels).toEqual([{ issue_number: 7, label: 'archon-ready', timed: true }]);
  expect(deps).toEqual([{ issue_number: 7, depends_on: 3 }]);
});

test('an update closes it, and a remove deletes it', async () => {
  await post(delivery());
  await post(
    delivery({
      action: 'update',
      data: issue({
        state: { type: 'completed', name: 'Done' },
        completedAt: '2026-11-08T11:59:30Z',
        updatedAt: '2026-11-08T11:59:30Z',
      }),
      updatedFrom: { labelIds: ['l-ready'] },
    }),
  );
  expect((await rows()).issues).toMatchObject([
    { number: 7, state: 'closed', close_reason: 'completed' },
  ]);
  await post(delivery({ action: 'remove', data: issue({ updatedAt: '2026-11-08T11:59:40Z' }) }));
  expect((await rows()).issues).toEqual([]);
});

test('a label an update adds is timed; one it already had keeps its time', async () => {
  await post(delivery({ data: issue({ labels: [], labelIds: [] }) }));
  await post(
    delivery({
      action: 'update',
      data: issue({ updatedAt: '2026-11-08T11:59:50Z' }),
      updatedFrom: { labelIds: [] },
    }),
  );
  expect((await rows()).labels).toEqual([{ issue_number: 7, label: 'archon-ready', timed: true }]);
});

test('a bad signature, an old delivery, or an unfollowed team writes nothing', async () => {
  expect((await post(delivery(), '0'.repeat(64))).status).toBe(401);
  expect((await post(delivery({ webhookTimestamp: NOW - 120_000 }))).status).toBe(401);
  const other = await post(
    delivery({ data: issue({ url: 'https://linear.app/wrkr/issue/AIF-7/x' }) }),
  );
  expect(await other.json()).toEqual({ event: 'linear Issue', written: false });
  const comment = await post({ ...delivery(), type: 'Comment' });
  expect(await comment.json()).toEqual({ event: 'linear Comment', written: false });
  expect((await rows()).issues).toEqual([]);
});

test("a Linear factory's GitHub issue deliveries are ignored; another factory's still land", async () => {
  const github = async (repository: string) => {
    const payload = {
      action: 'opened',
      repository: { full_name: repository, default_branch: 'main' },
      issue: {
        number: 7,
        title: 'A GitHub issue',
        state: 'open',
        body: '',
        html_url: `https://github.com/${repository}/issues/7`,
        created_at: '2026-11-08T11:00:00Z',
        updated_at: '2026-11-08T11:00:00Z',
        closed_at: null,
        labels: [],
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload)) as Uint8Array<ArrayBuffer>;
    const headers = {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': await sign('gh-secret', bytes),
    };
    return (await app.request('/', { method: 'POST', headers, body: bytes })).json();
  };
  expect(await github('schieble/snip')).toEqual({ event: 'issues', written: false });
  expect(await github('schieble/other')).toEqual({ event: 'issues', written: true });
  expect((await rows()).issues).toMatchObject([{ factory: 'other', number: 7 }]);
});

test('with no Linear secret configured, /linear is not served', async () => {
  const bare = createWebhookApp({
    secret: 'gh-secret',
    db,
    factories: FACTORIES,
    github: createGitHub(async () => new Response('{}')),
  });
  expect((await bare.request('/linear', { method: 'POST', body: '{}' })).status).toBe(404);
});
