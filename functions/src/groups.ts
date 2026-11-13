import { DocumentData, DocumentReference, FieldValue, Firestore, Timestamp, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { announce, logActivity } from './activity';
import { assertAdmin, requireId, requireTournamentId } from './authz';
import { getDb } from './firestore';
import { MAX_GROUPS_PER_ROUND } from './limits';
import { cleanGroups, GroupInput, playRange, sameValue, Side } from './roundRules';
import { ROUND_STATUS } from './rounds';
import { callable, UsageTracker } from './usage';

// Groups: who plays together, and when (docs/rounds-data-model.md, section 2.2).
//   tournaments/{id}/rounds/{roundId}/groups/{groupId}
//     order, playerIds, teeTime (UTC instant or null), teeHole, sides (two { playerIds } objects, or null)
// Written only here (clients read them, security rules). The groups of a round are always replaced as a
// whole, in one transaction, so the list is never half changed.

export interface SetGroupsInput {
  tournamentId?: string;
  roundId?: string;
  groups?: GroupInput[];
}

export interface GroupView {
  id: string;
  order: number;
  playerIds: string[];
  teeTime: string | null;
  teeHole: number;
  sides: Side[] | null;
}

// Admin: set the round's groups. The list replaces what is there: a group given with its existing id keeps
// that id (and any history), a group without an id is new, and a group left out is removed. Players must be
// on the roster, not withdrawn, and in at most one group; groups hold up to the round's maxGroupSize, may
// differ in size, and may start on any hole in play (a shotgun start). Tee times are optional exact
// instants. Only real changes leave feed events: groups_changed, and tee_time_changed (shown to everyone)
// when a tee time that was already set moves.
export async function setGroups(
  db: Firestore,
  uid: string,
  input: SetGroupsInput,
  usage: UsageTracker,
): Promise<{ groups: GroupView[] }> {
  const tournamentId = requireTournamentId(input.tournamentId);
  const roundId = requireId('roundId', input.roundId);
  if (!Array.isArray(input.groups)) {
    throw new HttpsError('invalid-argument', 'groups must be a list (an empty list removes every group)');
  }

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const roundRef = tournamentRef.collection('rounds').doc(roundId);
  const groupsRef = roundRef.collection('groups');

  return db.runTransaction(async (tx) => {
    const tournament = await assertAdmin(tx, tournamentRef, uid, usage);
    const roundSnap = await tx.get(roundRef);
    usage.read();
    const round = roundSnap.data();
    if (!round) throw new HttpsError('not-found', 'Round not found in this tournament');
    if (round.status !== ROUND_STATUS.SCHEDULED && round.status !== ROUND_STATUS.LIVE) {
      throw new HttpsError('failed-precondition', `This round is ${round.status}; its groups can no longer be changed`);
    }

    const wanted = cleanGroups(input.groups, {
      maxGroupSize: round.maxGroupSize,
      firstHole: round.firstHole,
      range: playRange(round.firstHole, round.holesPlanned),
      skippedHoles: round.skippedHoles ?? [],
      maxGroups: MAX_GROUPS_PER_ROUND,
    });

    const existing = await tx.get(groupsRef);
    usage.read(existing.size);
    const existingById = new Map(existing.docs.map((doc) => [doc.id, doc.data()]));
    for (const group of wanted) {
      if (group.id !== null && !existingById.has(group.id)) {
        throw new HttpsError('invalid-argument', 'A group id does not belong to this round (leave id out for a new group)');
      }
    }

    // Every player must be on the roster and still playing. A player withdrawn after being grouped stays in
    // the groups of a round that is under way (it is the record of who played), so a group that already has
    // them can still be saved; they cannot be added to a group.
    const alreadyGrouped = new Set(existing.docs.flatMap((doc) => doc.data().playerIds as string[]));
    const playerIds = wanted.flatMap((group) => group.playerIds);
    if (playerIds.length > 0) {
      const refs = playerIds.map((id) => tournamentRef.collection('players').doc(id));
      const entries = await tx.getAll(...refs);
      usage.read(entries.length);
      for (const entry of entries) {
        if (!entry.exists) {
          throw new HttpsError('failed-precondition', "A player in the groups is not on this tournament's roster");
        }
        if (entry.data()?.withdrawn === true && !alreadyGrouped.has(entry.id)) {
          throw new HttpsError('failed-precondition', 'A player in the groups has been removed from the tournament');
        }
      }
    }

    // Build the new set, and note what actually changed.
    const kept = new Set<string>();
    const writes: { ref: DocumentReference; data: Record<string, unknown>; isNew: boolean }[] = [];
    const views: GroupView[] = [];
    const movedTimes: { groupId: string; from: string | null; to: string | null; playerIds: string[] }[] = [];
    let added = 0;
    let changedCount = 0;

    wanted.forEach((group, index) => {
      const order = index + 1;
      const ref = group.id ? groupsRef.doc(group.id) : groupsRef.doc();
      const previous = group.id ? existingById.get(group.id) : undefined;
      if (group.id) kept.add(group.id);
      const teeTimeMs = group.teeTime ? group.teeTime.getTime() : null;
      const now = {
        order,
        playerIds: group.playerIds,
        teeTimeMs,
        teeHole: group.teeHole,
        sides: group.sides,
      };
      const before = previous
        ? {
            order: previous.order as number,
            playerIds: previous.playerIds as string[],
            teeTimeMs: previous.teeTime ? (previous.teeTime as Timestamp).toMillis() : null,
            teeHole: previous.teeHole as number,
            sides: (previous.sides as Side[] | null) ?? null,
          }
        : null;

      if (!before) added += 1;
      else if (!sameValue(before, now)) changedCount += 1;
      if (before && before.teeTimeMs !== null && before.teeTimeMs !== teeTimeMs) {
        movedTimes.push({
          groupId: ref.id,
          from: new Date(before.teeTimeMs).toISOString(),
          to: teeTimeMs === null ? null : new Date(teeTimeMs).toISOString(),
          playerIds: group.playerIds,
        });
      }
      if (!before || !sameValue(before, now)) {
        writes.push({
          ref,
          isNew: !before,
          data: {
            order,
            playerIds: group.playerIds,
            teeTime: group.teeTime ? Timestamp.fromDate(group.teeTime) : null,
            teeHole: group.teeHole,
            sides: group.sides,
            ...(before ? {} : { createdAt: FieldValue.serverTimestamp() }),
            updatedAt: FieldValue.serverTimestamp(),
          },
        });
      }
      views.push({
        id: ref.id,
        order,
        playerIds: group.playerIds,
        teeTime: group.teeTime ? group.teeTime.toISOString() : null,
        teeHole: group.teeHole,
        sides: group.sides,
      });
    });
    const removed = existing.docs.filter((doc) => !kept.has(doc.id));

    if (writes.length === 0 && removed.length === 0) return { groups: views };

    for (const write of writes) {
      if (write.isNew) tx.create(write.ref, write.data);
      else tx.update(write.ref, write.data);
    }
    for (const doc of removed) tx.delete(doc.ref);
    usage.wrote(writes.length + removed.length);

    const started = Boolean(tournament.startedAt);
    logActivity(tx, tournamentRef, usage, {
      type: 'groups_changed',
      actorId: uid,
      level: announce(started, 'admins'),
      data: {
        roundId,
        number: round.number,
        groups: wanted.length,
        added,
        changed: changedCount,
        removed: removed.length,
      },
    });
    if (movedTimes.length > 0) {
      logActivity(tx, tournamentRef, usage, {
        type: 'tee_time_changed',
        actorId: uid,
        level: 'all',
        data: { roundId, number: round.number, count: movedTimes.length, groups: movedTimes.slice(0, 20) },
      });
    }
    return { groups: views };
  });
}

// When a player is removed from the roster, take them out of the groups of every round that has not started,
// so a ghost never holds a seat and a later edit of that round's groups is not refused over them. A group
// left with nobody is deleted and the rest are renumbered. Rounds that are live or finished are left as they
// are: they are the record of who played. Reads happen here, in the caller's transaction and before any of its
// writes; the returned apply() does the writes and leaves one groups_changed event per round it touched.
export async function planGroupRemoval(
  tx: Transaction,
  tournamentRef: DocumentReference,
  tournament: DocumentData,
  playerId: string,
  usage: UsageTracker,
): Promise<{ apply: (uid: string) => void }> {
  const rounds = await tx.get(tournamentRef.collection('rounds'));
  usage.read(rounds.size);
  const plans: { number: unknown; roundId: string; groups: FirebaseFirestore.QueryDocumentSnapshot[] }[] = [];
  for (const round of rounds.docs) {
    if (round.data().status !== ROUND_STATUS.SCHEDULED) continue;
    const snap = await tx.get(round.ref.collection('groups'));
    usage.read(snap.size);
    if (!snap.docs.some((doc) => (doc.data().playerIds as string[]).includes(playerId))) continue;
    plans.push({
      number: round.data().number,
      roundId: round.id,
      groups: [...snap.docs].sort((a, b) => (a.data().order as number) - (b.data().order as number)),
    });
  }

  return {
    apply(uid: string) {
      for (const plan of plans) {
        let order = 0;
        let changed = 0;
        let deleted = 0;
        for (const doc of plan.groups) {
          const data = doc.data();
          const before = data.playerIds as string[];
          const after = before.filter((id) => id !== playerId);
          if (after.length === 0) {
            tx.delete(doc.ref);
            deleted += 1;
            continue;
          }
          order += 1;
          const update: Record<string, unknown> = {};
          if (after.length !== before.length) {
            update.playerIds = after;
            // Match-play sides name players too; a side left empty makes the pairing meaningless, so it is cleared.
            const sides = (data.sides as Side[] | null) ?? null;
            const trimmed = sides ? sides.map((side) => ({ playerIds: side.playerIds.filter((id) => id !== playerId) })) : null;
            update.sides = trimmed && trimmed.every((side) => side.playerIds.length > 0) ? trimmed : null;
          }
          if (data.order !== order) update.order = order;
          if (Object.keys(update).length > 0) {
            update.updatedAt = FieldValue.serverTimestamp();
            tx.update(doc.ref, update);
            changed += 1;
          }
        }
        usage.wrote(changed + deleted);
        logActivity(tx, tournamentRef, usage, {
          type: 'groups_changed',
          actorId: uid,
          targetPlayerId: playerId,
          level: announce(Boolean(tournament.startedAt), 'admins'),
          data: { roundId: plan.roundId, number: plan.number, groups: order, added: 0, changed, removed: deleted, reason: 'player_removed' },
        });
      }
    },
  };
}

export const setGroupsCallable = callable<SetGroupsInput, { groups: GroupView[] }>(
  'setGroups',
  async (request, usage, uid) => setGroups(getDb(), uid, request.data ?? {}, usage),
);
