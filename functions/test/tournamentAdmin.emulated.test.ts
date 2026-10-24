import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setMyHandicap } from '../src/handicap';
import { joinTournament } from '../src/roster';
import { assignCoAdmin, updateTournament } from '../src/tournamentAdmin';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-tournament-admin' }, 'tournament-admin-test'));
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection('tournaments'));
  await db.recursiveDelete(db.collection('inviteCodes'));
});

async function rejection(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (err) {
    return err as HttpsError;
  }
  throw new Error('expected the call to be rejected');
}

// A tournament run by org1 with players p1 and p2 on the roster.
async function setup() {
  const t = await createTournament(
    db,
    'org1',
    { name: 'Admin Cup', startDate: '2026-11-14', endDate: '2026-11-16' },
    new UsageTracker(),
  );
  await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, new UsageTracker());
  await joinTournament(db, 'p2', { inviteCode: t.inviteCode }, new UsageTracker());
  return t;
}

async function tournamentDoc(tid: string) {
  return (await db.collection('tournaments').doc(tid).get()).data();
}

const update = (tid: string, changes: Record<string, unknown>, uid = 'org1') =>
  updateTournament(db, uid, { tournamentId: tid, ...changes }, new UsageTracker());
const coAdmin = (tid: string, playerId: string | null, uid = 'org1') =>
  assignCoAdmin(db, uid, { tournamentId: tid, playerId }, new UsageTracker());

describe('updateTournament', () => {
  it('changes only the fields provided and returns the result', async () => {
    const t = await setup();
    const usage = new UsageTracker();
    const result = await updateTournament(
      db,
      'org1',
      { tournamentId: t.id, name: '  Renamed Cup ', wagerPotAmount: 250.456, visibility: 'public' },
      usage,
    );
    expect(result).toEqual({
      tournamentId: t.id,
      name: 'Renamed Cup',
      startDate: '2026-11-14',
      endDate: '2026-11-16',
      wagerPotAmount: 250.46,
      visibility: 'public',
      started: false,
    });
    expect(await tournamentDoc(t.id)).toMatchObject({
      name: 'Renamed Cup',
      startDate: '2026-11-14',
      wagerPotAmount: 250.46,
      visibility: 'public',
      organizerId: 'org1',
      status: 'active',
    });
    expect(usage.tournamentId).toBe(t.id);
    expect(usage.docsWritten).toBe(1);
  });

  it('changes dates, and clears one with null', async () => {
    const t = await setup();
    const moved = await update(t.id, { startDate: '2026-12-01', endDate: '2026-12-03' });
    expect(moved).toMatchObject({ startDate: '2026-12-01', endDate: '2026-12-03' });
    const cleared = await update(t.id, { endDate: null });
    expect(cleared).toMatchObject({ startDate: '2026-12-01', endDate: null });
  });

  it('validates dates together with what is already stored', async () => {
    const t = await setup(); // 2026-11-14 to 2026-11-16
    expect((await rejection(update(t.id, { endDate: '2026-11-01' }))).code).toBe('invalid-argument');
    expect((await rejection(update(t.id, { startDate: '2026-11-30' }))).code).toBe('invalid-argument');
    expect(await tournamentDoc(t.id)).toMatchObject({ startDate: '2026-11-14', endDate: '2026-11-16' });
    await update(t.id, { startDate: '2026-11-01' }); // moving the start earlier is fine
  });

  it('can clear the wager pot with null', async () => {
    const t = await setup();
    await update(t.id, { wagerPotAmount: 100 });
    expect((await update(t.id, { wagerPotAmount: null })).wagerPotAmount).toBeNull();
  });

  it('can flip visibility back to private', async () => {
    const t = await setup();
    await update(t.id, { visibility: 'public' });
    expect((await update(t.id, { visibility: 'private' })).visibility).toBe('private');
  });

  it('reopens a started tournament so players can edit their handicap again, and starts it', async () => {
    const t = await setup();
    expect((await update(t.id, { started: true })).started).toBe(true);
    expect((await tournamentDoc(t.id))?.startedAt).toBeDefined();
    const locked = await rejection(
      setMyHandicap(db, 'p1', { tournamentId: t.id, handicap: 5 }, new UsageTracker()),
    );
    expect(locked.code).toBe('permission-denied');

    expect((await update(t.id, { started: false })).started).toBe(false);
    expect((await tournamentDoc(t.id))?.startedAt).toBeNull();
    const result = await setMyHandicap(db, 'p1', { tournamentId: t.id, handicap: 5 }, new UsageTracker());
    expect(result.handicap).toBe(5);
  });

  it('is a no-op write when started already matches', async () => {
    const t = await setup();
    const usage = new UsageTracker();
    await updateTournament(db, 'org1', { tournamentId: t.id, started: false }, usage);
    expect(usage.docsWritten).toBe(0);
  });

  it('lets the co-admin update, but not a player or a stranger', async () => {
    const t = await setup();
    await coAdmin(t.id, 'p1');
    expect((await update(t.id, { name: 'By Co-admin' }, 'p1')).name).toBe('By Co-admin');
    for (const caller of ['p2', 'stranger']) {
      expect((await rejection(update(t.id, { name: 'Nope' }, caller))).code).toBe('permission-denied');
    }
    expect((await tournamentDoc(t.id))?.name).toBe('By Co-admin');
  });

  it('rejects an unknown tournament and a suspended one', async () => {
    const t = await setup();
    expect((await rejection(update('nope', { name: 'X' }))).code).toBe('not-found');
    await db.collection('tournaments').doc(t.id).update({ status: 'suspended' });
    expect((await rejection(update(t.id, { name: 'X' }))).code).toBe('failed-precondition');
  });

  it.each([
    ['nothing to change', {}],
    ['blank name', { name: '  ' }],
    ['over-long name', { name: 'x'.repeat(101) }],
    ['malformed date', { startDate: '14/11/2026' }],
    ['impossible date', { endDate: '2026-02-30' }],
    ['negative wager pot', { wagerPotAmount: -1 }],
    ['huge wager pot', { wagerPotAmount: 1_000_000 }],
    ['wager pot as text', { wagerPotAmount: '50' }],
    ['unknown visibility', { visibility: 'friends' }],
    ['started as text', { started: 'yes' }],
    ['changing the organizer', { organizerId: 'me' }],
    ['changing the status', { status: 'suspended' }],
    ['changing the co-admin here', { coAdminId: 'p1' }],
    ['a typo in a field name', { nmae: 'x' }],
  ])('rejects %s and changes nothing', async (_label, changes) => {
    const t = await setup();
    const before = await tournamentDoc(t.id);
    const err = await rejection(update(t.id, changes));
    expect(err.code).toBe('invalid-argument');
    expect(await tournamentDoc(t.id)).toEqual(before);
  });

  it('rejects a missing tournament id', async () => {
    const err = await rejection(updateTournament(db, 'org1', { name: 'X' }, new UsageTracker()));
    expect(err.code).toBe('invalid-argument');
  });
});

describe('assignCoAdmin', () => {
  it('lets the organizer name a roster member as co-admin', async () => {
    const t = await setup();
    const usage = new UsageTracker();
    const result = await assignCoAdmin(db, 'org1', { tournamentId: t.id, playerId: 'p1' }, usage);
    expect(result).toEqual({ tournamentId: t.id, coAdminId: 'p1' });
    expect((await tournamentDoc(t.id))?.coAdminId).toBe('p1');
    expect(usage.tournamentId).toBe(t.id);
  });

  it('checklist 7: a non-organizer is rejected, the organizer succeeds, and the new co-admin can then update', async () => {
    const t = await setup();
    expect((await rejection(coAdmin(t.id, 'p2', 'p1'))).code).toBe('permission-denied');
    expect((await tournamentDoc(t.id))?.coAdminId).toBeNull();

    await coAdmin(t.id, 'p1'); // organizer assigns
    expect((await update(t.id, { name: 'Co-admin was here' }, 'p1')).name).toBe('Co-admin was here');
  });

  it('lets the current co-admin hand the role to someone else, replacing themselves', async () => {
    const t = await setup();
    await coAdmin(t.id, 'p1');
    expect((await coAdmin(t.id, 'p2', 'p1')).coAdminId).toBe('p2');
    expect((await rejection(update(t.id, { name: 'Old co-admin' }, 'p1'))).code).toBe('permission-denied');
  });

  it('removes the co-admin with null', async () => {
    const t = await setup();
    await coAdmin(t.id, 'p1');
    expect((await coAdmin(t.id, null)).coAdminId).toBeNull();
    expect((await tournamentDoc(t.id))?.coAdminId).toBeNull();
  });

  it('rejects someone not on the roster, and the organizer', async () => {
    const t = await setup();
    expect((await rejection(coAdmin(t.id, 'nobody'))).code).toBe('not-found');
    expect((await rejection(coAdmin(t.id, 'org1'))).code).toBe('invalid-argument');
    expect((await tournamentDoc(t.id))?.coAdminId).toBeNull();
  });

  it('rejects strangers, players, unknown and suspended tournaments', async () => {
    const t = await setup();
    for (const caller of ['p1', 'stranger']) {
      expect((await rejection(coAdmin(t.id, 'p2', caller))).code).toBe('permission-denied');
    }
    expect((await rejection(coAdmin('nope', 'p1'))).code).toBe('not-found');
    await db.collection('tournaments').doc(t.id).update({ status: 'suspended' });
    expect((await rejection(coAdmin(t.id, 'p1'))).code).toBe('failed-precondition');
  });

  it.each([
    ['missing playerId', { tournamentId: 'T' }],
    ['path-like playerId', { tournamentId: 'T', playerId: 'a/b' }],
    ['non-string playerId', { tournamentId: 'T', playerId: 5 }],
    ['missing tournamentId', { playerId: 'p1' }],
  ])('rejects %s', async (_label, input) => {
    const err = await rejection(assignCoAdmin(db, 'org1', input as never, new UsageTracker()));
    expect(err.code).toBe('invalid-argument');
  });
});
