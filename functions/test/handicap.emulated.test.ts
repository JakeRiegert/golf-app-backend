import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assignTournamentPlayer, chooseTeam } from '../src/assignment';
import { setMyHandicap } from '../src/handicap';
import { startTournament } from '../src/lifecycle';
import { joinTournament } from '../src/roster';
import { createTeams } from '../src/teams';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-handicap' }, 'handicap-test'));
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

// A tournament run by org1 with player p1 on the roster.
async function setup() {
  const t = await createTournament(db, 'org1', { name: 'Handicap Cup' }, new UsageTracker());
  await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, new UsageTracker());
  return t.id;
}

async function entry(tid: string, uid: string) {
  return (await db.collection('tournaments').doc(tid).collection('players').doc(uid).get()).data();
}
async function tournamentDoc(tid: string) {
  return (await db.collection('tournaments').doc(tid).get()).data();
}

const mine = (tid: string, handicap: number | null, uid = 'p1') =>
  setMyHandicap(db, uid, { tournamentId: tid, handicap }, new UsageTracker());
const admin = (tid: string, handicap: number | null, uid = 'org1') =>
  assignTournamentPlayer(db, uid, { tournamentId: tid, playerId: 'p1', handicap }, new UsageTracker());
const start = (tid: string, uid = 'org1') => startTournament(db, uid, { tournamentId: tid }, new UsageTracker());

describe('startTournament', () => {
  it('stamps startedAt and is idempotent', async () => {
    const tid = await setup();
    expect((await tournamentDoc(tid))?.startedAt).toBeNull();

    const usage = new UsageTracker();
    const first = await startTournament(db, 'org1', { tournamentId: tid }, usage);
    expect(first).toEqual({ tournamentId: tid, alreadyStarted: false });
    expect(usage.tournamentId).toBe(tid);
    expect(usage.docsWritten).toBe(2); // startedAt, plus the activity event
    const stamp = (await tournamentDoc(tid))?.startedAt;
    expect(stamp).toBeDefined();

    const second = await start(tid);
    expect(second.alreadyStarted).toBe(true);
    expect((await tournamentDoc(tid))?.startedAt.isEqual(stamp)).toBe(true);
  });

  it('lets the co-admin start it, but not a player or a stranger', async () => {
    const tid = await setup();
    await db.collection('tournaments').doc(tid).update({ coAdminId: 'co1' });
    for (const caller of ['p1', 'stranger']) {
      expect((await rejection(start(tid, caller))).code).toBe('permission-denied');
    }
    expect((await tournamentDoc(tid))?.startedAt).toBeNull();
    expect((await start(tid, 'co1')).alreadyStarted).toBe(false);
  });

  it('rejects an unknown tournament, a missing id, and a suspended tournament', async () => {
    const tid = await setup();
    expect((await rejection(start('nope'))).code).toBe('not-found');
    expect((await rejection(startTournament(db, 'org1', {}, new UsageTracker()))).code).toBe('invalid-argument');
    await db.collection('tournaments').doc(tid).update({ status: 'suspended' });
    expect((await rejection(start(tid))).code).toBe('failed-precondition');
  });
});

describe('setMyHandicap (player), before the tournament starts', () => {
  it('lets a player set and change their own handicap, rounded to one decimal', async () => {
    const tid = await setup();
    const usage = new UsageTracker();
    const result = await setMyHandicap(db, 'p1', { tournamentId: tid, handicap: 14.26 }, usage);
    expect(result).toEqual({ playerId: 'p1', handicap: 14.3, handicapSetBy: 'player' });
    expect(await entry(tid, 'p1')).toMatchObject({ handicap: 14.3, handicapSetBy: 'player' });
    expect(usage.tournamentId).toBe(tid);

    expect((await mine(tid, 9)).handicap).toBe(9);
  });

  it('can clear it with null', async () => {
    const tid = await setup();
    await mine(tid, 9);
    expect(await mine(tid, null)).toEqual({ playerId: 'p1', handicap: null, handicapSetBy: null });
  });

  it("only ever changes the caller's own entry", async () => {
    const tid = await setup();
    await mine(tid, 20);
    expect(await entry(tid, 'org1')).toMatchObject({ handicap: null });
  });

  it('is last-write-wins with an admin before the start', async () => {
    const tid = await setup();
    await admin(tid, 5);
    expect((await entry(tid, 'p1'))?.handicapSetBy).toBe('admin');
    expect((await mine(tid, 7)).handicap).toBe(7);
    expect((await entry(tid, 'p1'))?.handicapSetBy).toBe('player');
    expect((await admin(tid, 6)).handicap).toBe(6);
  });

  it('rejects someone who has not joined', async () => {
    const tid = await setup();
    expect((await rejection(mine(tid, 5, 'stranger'))).code).toBe('permission-denied');
  });

  it('rejects a suspended tournament', async () => {
    const tid = await setup();
    await db.collection('tournaments').doc(tid).update({ status: 'suspended' });
    expect((await rejection(mine(tid, 5))).code).toBe('failed-precondition');
  });

  it.each([
    ['missing', undefined],
    ['text', '5'],
    ['too high', 55],
    ['too low', -11],
    ['NaN', Number.NaN],
  ])('rejects a %s handicap', async (_label, value) => {
    const tid = await setup();
    const input = { tournamentId: tid, handicap: value as never };
    const err = await rejection(setMyHandicap(db, 'p1', input, new UsageTracker()));
    expect(err.code).toBe('invalid-argument');
  });
});

describe('after the tournament starts', () => {
  it('a player can no longer change their handicap, and nothing changes', async () => {
    const tid = await setup();
    await mine(tid, 12);
    await start(tid);
    const err = await rejection(mine(tid, 2));
    expect(err.code).toBe('permission-denied');
    expect(err.message).toContain('organizer');
    expect(await entry(tid, 'p1')).toMatchObject({ handicap: 12, handicapSetBy: 'player' });
  });

  it('admins can still change any handicap', async () => {
    const tid = await setup();
    await mine(tid, 12);
    await start(tid);
    expect(await admin(tid, 10)).toMatchObject({ handicap: 10, handicapSetBy: 'admin' });
    await db.collection('tournaments').doc(tid).update({ coAdminId: 'co1' });
    expect((await admin(tid, 9, 'co1')).handicap).toBe(9);
  });

  it('a handicap can change from day to day by the admin, with the latest value winning', async () => {
    const tid = await setup();
    await mine(tid, 15);
    await start(tid);
    await admin(tid, 13); // day 2
    await admin(tid, 14); // day 3
    expect((await entry(tid, 'p1'))?.handicap).toBe(14);
  });

  it('teams lock on start too: players cannot pick one, admins still can', async () => {
    const tid = await setup();
    const { teams } = await createTeams(db, 'org1', { tournamentId: tid, teams: [{ name: 'Red' }] }, new UsageTracker());
    await start(tid);
    const err = await rejection(chooseTeam(db, 'p1', { tournamentId: tid, teamId: teams[0].id }, new UsageTracker()));
    expect(err.code).toBe('permission-denied');
    const result = await assignTournamentPlayer(
      db,
      'org1',
      { tournamentId: tid, playerId: 'p1', teamId: teams[0].id },
      new UsageTracker(),
    );
    expect(result).toMatchObject({ teamId: teams[0].id, teamAssignedBy: 'admin' });
  });
});
