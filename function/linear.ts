// Our install (AIF-150): Linear's webhook deliveries, for a factory whose work items are in a
// Linear team (factories.json `work_items: "linear.app/<workspace>/<TEAM>"`). An issue's create,
// update and remove land in the same mirror rows a GitHub issue does (mc.issues, its labels, its
// `Depends on:` edges), keyed by the Linear issue number, so the console and the event watcher
// read a Linear factory the way they read a GitHub one. Pull requests stay GitHub's.
//
// Linear signs each delivery's raw body with HMAC-SHA256 under the webhook's signing secret and
// sends the hex digest in `Linear-Signature`; the body carries `webhookTimestamp` (ms), and a
// delivery older than a minute is refused, as Linear advises, so a captured one cannot be
// replayed. Comments are not mirrored: mc.comments keys GitHub's numeric comment ids.

import type { Factory, Issue, Write } from './ingest';
import { removeIssue, writeIssue, writeLabeledAt } from './ingest';

const encoder = new TextEncoder();
export const LINEAR_MAX_AGE_MS = 60_000;

/** True only for a 64-hex `Linear-Signature` that matches the body; compared in constant time. */
export async function verifyLinear(
  secret: string,
  body: Uint8Array<ArrayBuffer>,
  header: string | undefined,
): Promise<boolean> {
  const hex = /^([0-9a-f]{64})$/.exec(header ?? '')?.[1];
  if (!hex) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, Buffer.from(hex, 'hex'), body);
}

export async function signLinear(secret: string, body: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return Buffer.from(await crypto.subtle.sign('HMAC', key, body)).toString('hex');
}

/** The fields of a Linear Issue webhook's `data` this module reads. */
export interface LinearIssueData {
  id: string;
  number: number;
  title: string;
  description?: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  state: { type: string; name: string };
  labels?: { id: string; name: string }[];
  labelIds?: string[];
  team?: { key: string };
}

export interface LinearDelivery {
  action: 'create' | 'update' | 'remove' | string;
  type: string;
  data: LinearIssueData;
  url?: string;
  updatedFrom?: { labelIds?: string[] } & Record<string, unknown>;
  webhookTimestamp?: number;
}

/** `<workspace>/<TEAM>` from an issue URL `https://linear.app/<workspace>/issue/<TEAM>-<n>/...`. */
export function teamOf(url: string): string | null {
  const match = /^https:\/\/linear\.app\/([^/]+)\/issue\/([A-Za-z0-9]+)-\d+(?:\/|$)/.exec(url);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** The factory following the team the issue is in. */
export function linearFactory(factories: Factory[], data: LinearIssueData): string | null {
  const team = teamOf(data.url);
  if (!team) return null;
  return factories.find((f) => f.work_items?.toLowerCase() === `linear.app/${team}`)?.name ?? null;
}

/**
 * The issue in the shape the mirror writes. Its body is read only for the phase and the
 * dependency edges, so `Depends on: SNIP-3` is given as `Depends on: #3`, the edge to issue 3 of
 * the same team.
 */
export function mirroredIssue(data: LinearIssueData): Issue {
  const team = teamOf(data.url)?.split('/')[1] ?? '';
  const closed = data.state.type === 'completed' || data.state.type === 'canceled';
  const reason =
    data.state.type === 'completed'
      ? 'completed'
      : /duplicate/i.test(data.state.name)
        ? 'duplicate'
        : 'not_planned';
  const body = (data.description ?? '').replace(new RegExp(`\\b${team}-(\\d+)\\b`, 'gi'), '#$1');
  return {
    number: data.number,
    title: data.title,
    state: closed ? 'closed' : 'open',
    body,
    html_url: data.url,
    created_at: data.createdAt,
    updated_at: data.updatedAt,
    closed_at: closed ? (data.completedAt ?? data.canceledAt ?? data.updatedAt) : null,
    state_reason: closed ? reason : null,
    labels: (data.labels ?? []).map((label) => ({ name: label.name })),
  };
}

/** The write one Linear delivery makes, or null when it is not about a followed team's issue. */
export function linearWrite(delivery: LinearDelivery, factories: Factory[]): Write | null {
  if (delivery.type !== 'Issue' || !delivery.data) return null;
  const { data } = delivery;
  const factory = linearFactory(factories, data);
  if (!factory) return null;
  if (delivery.action === 'remove') {
    return (tx) => removeIssue(tx, factory, data.number, data.updatedAt);
  }
  const issue = mirroredIssue(data);
  // Labels the delivery added: all of a new issue's, or those absent from `updatedFrom`.
  const before = delivery.action === 'create' ? [] : delivery.updatedFrom?.labelIds;
  const added =
    before === undefined
      ? []
      : (data.labels ?? []).filter((label) => !before.includes(label.id)).map((l) => l.name);
  return async (tx) => {
    await writeIssue(tx, factory, issue);
    for (const label of added)
      await writeLabeledAt(tx, factory, data.number, label, data.updatedAt);
  };
}

/** Whether a delivery's timestamp is within the allowed age of `now`. */
export function fresh(delivery: LinearDelivery, now = Date.now()): boolean {
  const at = delivery.webhookTimestamp;
  return typeof at === 'number' && Math.abs(now - at) <= LINEAR_MAX_AGE_MS;
}
