import { DocumentReference, FieldValue, Transaction } from 'firebase-admin/firestore';

import { UsageTracker } from './usage';

// The activity feed: one append-only document per meaningful change, written inside the same
// transaction as the change itself, so a change and its record can never disagree. It is both the
// announcement feed members see and the audit trail admins keep (blueprint requirement 39).
//
//   tournaments/{id}/activity/{eventId}
//     type              what happened (ACTIVITY_TYPES)
//     actorId           uid of whoever did it
//     targetPlayerId    uid the change is about, or null
//     category          the label members filter and colour the feed by, and the unit notification
//                       muting works on: essentials | changes | roster | scoring | moments (set from
//                       the event's type by CATEGORY_OF_TYPE, so no caller has to remember it)
//     level             who may read it: 'all' roster members, 'affected' the target plus admins,
//                       'admins' admins only (admins can always read everything)
//     changes           { field: { from, to } } for edits, else {}
//     data              small extra facts to show without another read (e.g. a team name), else {}
//     at                server timestamp
//
// Clients can only read it (security rules); there is no way to edit or delete an event. Names are
// not stored, only IDs, so a renamed player is never shown under a stale name.
export type ActivityLevel = 'all' | 'affected' | 'admins';

export const ACTIVITY_TYPES = [
  'tournament_started',
  'tournament_reopened',
  'tournament_updated',
  'teams_created',
  'team_updated',
  'team_assigned',
  'handicap_changed',
  'co_admin_changed',
  'player_joined',
  'player_removed',
  'team_deleted',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

// The few user-facing groups every event belongs to (not the event types, which are many and
// internal). essentials: round cancelled or shortened, course or tee time changed, tournament
// suspended or cancelled (none of these exist yet); changes: start and reopen, edits to dates and
// rules, team and handicap changes; roster: joins, removals, teams created, renamed or deleted,
// co-admin changes; scoring and moments arrive with Rounds and scores.
export const ACTIVITY_CATEGORIES = ['essentials', 'changes', 'roster', 'scoring', 'moments'] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const CATEGORY_OF_TYPE: Record<ActivityType, ActivityCategory> = {
  tournament_started: 'changes',
  tournament_reopened: 'changes',
  tournament_updated: 'changes',
  team_assigned: 'changes',
  handicap_changed: 'changes',
  teams_created: 'roster',
  team_updated: 'roster',
  team_deleted: 'roster',
  co_admin_changed: 'roster',
  player_joined: 'roster',
  player_removed: 'roster',
};

export interface ActivityInput {
  type: ActivityType;
  actorId: string;
  level: ActivityLevel;
  targetPlayerId?: string | null;
  changes?: Record<string, { from: unknown; to: unknown }>;
  data?: Record<string, unknown>;
}

// Firestore rejects undefined, and a missing value reads better as null in the feed.
const nullify = (value: unknown) => (value === undefined ? null : value);

// Must be called after the transaction's reads (Firestore requires reads before writes).
export function logActivity(
  tx: Transaction,
  tournamentRef: DocumentReference,
  usage: UsageTracker,
  event: ActivityInput,
): void {
  const changes = Object.fromEntries(
    Object.entries(event.changes ?? {}).map(([field, { from, to }]) => [field, { from: nullify(from), to: nullify(to) }]),
  );
  tx.create(tournamentRef.collection('activity').doc(), {
    type: event.type,
    category: CATEGORY_OF_TYPE[event.type],
    actorId: event.actorId,
    targetPlayerId: event.targetPlayerId ?? null,
    level: event.level,
    changes,
    data: event.data ?? {},
    at: FieldValue.serverTimestamp(),
  });
  usage.wrote();
}

// Once a tournament has started, every admin change is announced to everyone; before that the
// routine setup edits stay between the admins (and the player they concern, where there is one).
export function announce(started: boolean, beforeStart: ActivityLevel): ActivityLevel {
  return started ? 'all' : beforeStart;
}

// The fields of `after` that differ from `before`, as { field: { from, to } }; empty when nothing
// actually changed (so an edit that changes nothing leaves no event).
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of Object.keys(after)) {
    const from = nullify(before[field]);
    const to = nullify(after[field]);
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}
