import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setGroups } from '../src/groups';
import { startTournament } from '../src/lifecycle';
import { joinTournament, removePlayer } from '../src/roster';
import { createRound } from '../src/rounds';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.
// Removing a player takes them out of the groups of rounds that have not started.

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-roster-groups' }, 'roster-groups-test'));
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection('tournaments'));
  await db.recursiveDelete(db.collection('inviteCodes'));
});

const u = () => new UsageTracker();

async function rejection(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (err) {
    return err as HttpsError;
  }
  throw new Error('expected the call to be rejected');
}

async function setup() {
  const t = await createTournament(db, 'org1', { name: 'Removal Cup', startDate: '2026-11-13', endDate: '2026-11-15' }, u());
  for (const p of ['p1', 'p2', 'p3', 'p4']) await joinTournament(db, p, { inviteCode: t.inviteCode }, u());
  const round = await createRound(db, 'org1', { tournamentId: t.id, date: '2026-11-14' }, u());
  return { tid: t.id, rid: round.id };
}

const groupsOf = async (tid: string, rid: string) =>
  (await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).collection('groups').get()).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a: any, b: any) => a.order - b.order) as any[];
async function feedOf(tid: string, type: string) {
  const snap = await db.collection('tournaments').doc(tid).collection('activity').where('type', '==', type).get();
  return snap.docs.map((d) => d.data());
}
const asInput = (groups: any[]) => groups.map((g) => ({ id: g.id, playerIds: g.playerIds, teeHole: g.teeHole, teeTime: g.teeTime?.toDate().toISOString() ?? null }));

describe('removePlayer and groups', () => {
  it('before Start: the player leaves their group, the rest stay, and a tee-time edit still works', async () => {
    const { tid, rid } = await setup();
    await setGroups(
      db,
      'org1',
      {
        tournamentId: tid,
        roundId: rid,
        groups: [{ playerIds: ['p1', 'p2'], teeTime: '2026-11-14T13:00:00Z' }, { playerIds: ['p3', 'p4'], teeTime: '2026-11-14T13:10:00Z' }] as never,
      },
      u(),
    );
    await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p2' }, u());

    const groups = await groupsOf(tid, rid);
    expect(groups.map((g) => [g.order, g.playerIds])).toEqual([[1, ['p1']], [2, ['p3', 'p4']]]);
    expect(groups[0].teeTime.toDate().toISOString()).toBe('2026-11-14T13:00:00.000Z'); // tee times untouched

    // The app resends every group when one tee time changes; that no longer trips over the removed player.
    const edited = asInput(groups);
    edited[1].teeTime = '2026-11-14T14:00:00Z';
    await setGroups(db, 'org1', { tournamentId: tid, roundId: rid, groups: edited as never }, u());
    expect((await groupsOf(tid, rid))[1].teeTime.toDate().toISOString()).toBe('2026-11-14T14:00:00.000Z');

    const events = (await feedOf(tid, 'groups_changed')).filter((e) => e.data.reason === 'player_removed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ targetPlayerId: 'p2', level: 'admins', data: { roundId: rid, changed: 1, removed: 0, groups: 2 } });
  });

  it('a group left with nobody is deleted and the rest are renumbered', async () => {
    const { tid, rid } = await setup();
    await setGroups(
      db,
      'org1',
      { tournamentId: tid, roundId: rid, groups: [{ playerIds: ['p1'] }, { playerIds: ['p2'], teeTime: '2026-11-14T13:00:00Z', teeHole: 1 }, { playerIds: ['p3'] }] as never },
      u(),
    );
    const before = await groupsOf(tid, rid);
    await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p2' }, u());
    const after = await groupsOf(tid, rid);
    expect(after.map((g) => [g.order, g.playerIds])).toEqual([[1, ['p1']], [2, ['p3']]]);
    expect(after[1].id).toBe(before[2].id); // the third group keeps its identity and moves up
    const [event] = (await feedOf(tid, 'groups_changed')).filter((e) => e.data.reason === 'player_removed');
    expect(event.data).toMatchObject({ removed: 1, changed: 1, groups: 2 });
  });

  it('match-play sides are trimmed, and cleared when a side would be empty', async () => {
    const { tid, rid } = await setup();
    await setGroups(
      db,
      'org1',
      { tournamentId: tid, roundId: rid, groups: [{ playerIds: ['p1', 'p2', 'p3', 'p4'], sides: [{ playerIds: ['p1', 'p2'] }, { playerIds: ['p3', 'p4'] }] }] as never },
      u(),
    );
    await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p2' }, u());
    expect((await groupsOf(tid, rid))[0].sides).toEqual([{ playerIds: ['p1'] }, { playerIds: ['p3', 'p4'] }]);
    await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p1' }, u());
    expect((await groupsOf(tid, rid))[0].sides).toBeNull();
  });

  it('only touches rounds that hold the player, and leaves a round with no groups alone', async () => {
    const { tid, rid } = await setup();
    const other = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-15' }, u());
    await setGroups(db, 'org1', { tournamentId: tid, roundId: rid, groups: [{ playerIds: ['p1', 'p2'] }] as never }, u());
    await setGroups(db, 'org1', { tournamentId: tid, roundId: other.id, groups: [{ playerIds: ['p3', 'p4'] }] as never }, u());
    const untouched = (await groupsOf(tid, other.id))[0];
    await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p2' }, u());
    expect((await groupsOf(tid, other.id))[0].updatedAt.isEqual(untouched.updatedAt)).toBe(true);
    expect((await feedOf(tid, 'groups_changed')).filter((e) => e.data.reason === 'player_removed')).toHaveLength(1);
  });

  it('after Start: a scheduled round is cleaned; a live round keeps the withdrawn player and its groups stay editable', async () => {
    const { tid, rid } = await setup();
    const live = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-15' }, u());
    await setGroups(db, 'org1', { tournamentId: tid, roundId: rid, groups: [{ playerIds: ['p1', 'p2'] }] as never }, u());
    await setGroups(db, 'org1', { tournamentId: tid, roundId: live.id, groups: [{ playerIds: ['p2', 'p3'] }, { playerIds: ['p4'] }] as never }, u());
    await db.collection('tournaments').doc(tid).collection('rounds').doc(live.id).update({ status: 'live' });
    await startTournament(db, 'org1', { tournamentId: tid }, u());

    await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p2' }, u());
    expect((await groupsOf(tid, rid))[0].playerIds).toEqual(['p1']);
    const liveGroups = await groupsOf(tid, live.id);
    expect(liveGroups[0].playerIds).toEqual(['p2', 'p3']); // the record of who played is kept

    // A tee-time edit on the live round is allowed even though a withdrawn player is in it...
    const edited = asInput(liveGroups);
    edited[1].teeTime = '2026-11-15T15:00:00Z';
    await setGroups(db, 'org1', { tournamentId: tid, roundId: live.id, groups: edited as never }, u());
    // ...and moving them between groups of that round is still fine (they are already in the round)...
    const shuffled = asInput(await groupsOf(tid, live.id));
    shuffled[1].playerIds = ['p4', 'p2'];
    shuffled[0].playerIds = ['p3'];
    await setGroups(db, 'org1', { tournamentId: tid, roundId: live.id, groups: shuffled as never }, u());
    // ...but a withdrawn player who was NOT in the round cannot be newly added to it.
    await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p1' }, u());
    const added = asInput(await groupsOf(tid, live.id));
    added[0].playerIds = ['p3', 'p1'];
    const err = await rejection(setGroups(db, 'org1', { tournamentId: tid, roundId: live.id, groups: added as never }, u()));
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toContain('removed');
    // After Start the announcement goes to everyone.
    const [event] = (await feedOf(tid, 'groups_changed')).filter((e) => e.data.reason === 'player_removed');
    expect(event.level).toBe('all');
  });

  it('removing a player who is in no group changes nothing else, and a repeat is a no-op that tidies a stale group', async () => {
    const { tid, rid } = await setup();
    await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p4' }, u());
    expect(await feedOf(tid, 'groups_changed')).toHaveLength(0);

    // A group that still holds a player who was withdrawn before this cleanup existed is tidied by a repeat call.
    await startTournament(db, 'org1', { tournamentId: tid }, u());
    await setGroups(db, 'org1', { tournamentId: tid, roundId: rid, groups: [{ playerIds: ['p1', 'p2'] }] as never }, u());
    await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p2' }, u());
    const group = (await groupsOf(tid, rid))[0];
    await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).collection('groups').doc(group.id).update({ playerIds: ['p1', 'p2'] });
    const result = await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p2' }, u());
    expect(result).toEqual({ tournamentId: tid, playerId: 'p2', withdrawn: true });
    expect((await groupsOf(tid, rid))[0].playerIds).toEqual(['p1']);
    expect(await feedOf(tid, 'player_removed')).toHaveLength(2); // p4 and p2, not three
  });
});
