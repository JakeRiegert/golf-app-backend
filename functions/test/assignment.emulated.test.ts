import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assignTournamentPlayer, chooseTeam } from '../src/assignment';
import { joinTournament } from '../src/roster';
import { createTeams } from '../src/teams';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-assignment' }, 'assignment-test'));
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

// A tournament run by org1 with players p1 and p2 on the roster and teams Red and Blue.
async function setup() {
  const t = await createTournament(db, 'org1', { name: 'Assign Cup' }, new UsageTracker());
  await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, new UsageTracker());
  await joinTournament(db, 'p2', { inviteCode: t.inviteCode }, new UsageTracker());
  const { teams } = await createTeams(
    db,
    'org1',
    { tournamentId: t.id, teams: [{ name: 'Red' }, { name: 'Blue' }] },
    new UsageTracker(),
  );
  return { tid: t.id, red: teams[0].id, blue: teams[1].id };
}

async function entry(tid: string, uid: string) {
  return (await db.collection('tournaments').doc(tid).collection('players').doc(uid).get()).data();
}

const admin = (tid: string, playerId: string, extra: Record<string, unknown>, uid = 'org1') =>
  assignTournamentPlayer(db, uid, { tournamentId: tid, playerId, ...extra }, new UsageTracker());
const choose = (tid: string, uid: string, teamId: string | null) =>
  chooseTeam(db, uid, { tournamentId: tid, teamId }, new UsageTracker());

describe('assignTournamentPlayer (admin)', () => {
  it('sets a team and handicap and marks the team as admin-assigned', async () => {
    const { tid, red } = await setup();
    const usage = new UsageTracker();
    const result = await assignTournamentPlayer(
      db,
      'org1',
      { tournamentId: tid, playerId: 'p1', teamId: red, handicap: 12.46 },
      usage,
    );
    expect(result).toEqual({ playerId: 'p1', teamId: red, handicap: 12.5, teamAssignedBy: 'admin' });
    expect(await entry(tid, 'p1')).toMatchObject({ teamId: red, handicap: 12.5, teamAssignedBy: 'admin' });
    expect((await entry(tid, 'p1'))?.updatedAt).toBeDefined();
    expect(usage.tournamentId).toBe(tid);
    expect(usage.docsWritten).toBe(1);
  });

  it('lets the co-admin assign too', async () => {
    const { tid, red } = await setup();
    await db.collection('tournaments').doc(tid).update({ coAdminId: 'co1' });
    const result = await admin(tid, 'p1', { teamId: red }, 'co1');
    expect(result.teamAssignedBy).toBe('admin');
  });

  it('changing only the handicap leaves the team and who set it alone', async () => {
    const { tid, blue } = await setup();
    await choose(tid, 'p1', blue);
    const result = await admin(tid, 'p1', { handicap: 8 });
    expect(result).toEqual({ playerId: 'p1', teamId: blue, handicap: 8, teamAssignedBy: 'player' });
  });

  it('clearing the team with null hands control back to the player', async () => {
    const { tid, red, blue } = await setup();
    await admin(tid, 'p1', { teamId: red });
    expect((await admin(tid, 'p1', { teamId: null })).teamAssignedBy).toBeNull();
    expect(await entry(tid, 'p1')).toMatchObject({ teamId: null, teamAssignedBy: null });
    expect((await choose(tid, 'p1', blue)).teamId).toBe(blue);
  });

  it('can clear a handicap with null', async () => {
    const { tid } = await setup();
    await admin(tid, 'p1', { handicap: 20 });
    expect((await admin(tid, 'p1', { handicap: null })).handicap).toBeNull();
  });

  it('overrides a team the player picked', async () => {
    const { tid, red, blue } = await setup();
    await choose(tid, 'p1', red);
    const result = await admin(tid, 'p1', { teamId: blue });
    expect(result).toMatchObject({ teamId: blue, teamAssignedBy: 'admin' });
  });

  it('rejects a non-admin, including a player assigning themselves, and changes nothing', async () => {
    const { tid, red } = await setup();
    for (const caller of ['p1', 'stranger']) {
      const err = await rejection(admin(tid, 'p1', { teamId: red, handicap: 0 }, caller));
      expect(err.code).toBe('permission-denied');
    }
    expect(await entry(tid, 'p1')).toMatchObject({ teamId: null, handicap: null, teamAssignedBy: null });
  });

  it('rejects a team that does not exist, or that belongs to another tournament, changing nothing', async () => {
    const { tid } = await setup();
    const other = await setup();
    for (const teamId of ['ghost', other.red]) {
      const err = await rejection(admin(tid, 'p1', { teamId, handicap: 5 }));
      expect(err.code).toBe('not-found');
    }
    expect(await entry(tid, 'p1')).toMatchObject({ teamId: null, handicap: null });
  });

  it('rejects a player who is not on the roster, and an unknown tournament', async () => {
    const { tid, red } = await setup();
    expect((await rejection(admin(tid, 'nobody', { teamId: red }))).code).toBe('not-found');
    expect((await rejection(admin('nope', 'p1', { teamId: red }))).code).toBe('not-found');
  });

  it('rejects writes to a suspended tournament', async () => {
    const { tid, red } = await setup();
    await db.collection('tournaments').doc(tid).update({ status: 'suspended' });
    expect((await rejection(admin(tid, 'p1', { teamId: red }))).code).toBe('failed-precondition');
  });

  it.each([
    ['missing playerId', { tournamentId: 'T' }],
    ['path-like playerId', { tournamentId: 'T', playerId: 'a/b', handicap: 1 }],
    ['nothing to change', { tournamentId: 'T', playerId: 'p1' }],
    ['handicap as text', { tournamentId: 'T', playerId: 'p1', handicap: '5' }],
    ['handicap too high', { tournamentId: 'T', playerId: 'p1', handicap: 55 }],
    ['handicap too low', { tournamentId: 'T', playerId: 'p1', handicap: -11 }],
    ['handicap NaN', { tournamentId: 'T', playerId: 'p1', handicap: Number.NaN }],
    ['path-like teamId', { tournamentId: 'T', playerId: 'p1', teamId: 'a/b' }],
  ])('rejects %s', async (_label, input) => {
    const err = await rejection(assignTournamentPlayer(db, 'org1', input as never, new UsageTracker()));
    expect(err.code).toBe('invalid-argument');
  });
});

describe('chooseTeam (player)', () => {
  it('lets a player pick a team, marked as player-chosen, without touching their handicap', async () => {
    const { tid, red } = await setup();
    await admin(tid, 'p1', { handicap: 15 });
    const usage = new UsageTracker();
    const result = await chooseTeam(db, 'p1', { tournamentId: tid, teamId: red }, usage);
    expect(result).toEqual({ playerId: 'p1', teamId: red, handicap: 15, teamAssignedBy: 'player' });
    expect(await entry(tid, 'p1')).toMatchObject({ teamId: red, handicap: 15, teamAssignedBy: 'player' });
    expect(usage.tournamentId).toBe(tid);
  });

  it('lets a player change their mind, and leave their team', async () => {
    const { tid, red, blue } = await setup();
    await choose(tid, 'p1', red);
    expect((await choose(tid, 'p1', blue)).teamId).toBe(blue);
    expect(await choose(tid, 'p1', null)).toMatchObject({ teamId: null, teamAssignedBy: null });
  });

  it('only ever changes the caller\'s own entry', async () => {
    const { tid, red } = await setup();
    await choose(tid, 'p1', red);
    expect(await entry(tid, 'p2')).toMatchObject({ teamId: null, teamAssignedBy: null });
  });

  it('is locked once an admin has assigned the player, until the admin clears it', async () => {
    const { tid, red, blue } = await setup();
    await admin(tid, 'p1', { teamId: red });
    const err = await rejection(choose(tid, 'p1', blue));
    expect(err.code).toBe('permission-denied');
    expect(await entry(tid, 'p1')).toMatchObject({ teamId: red, teamAssignedBy: 'admin' });

    await admin(tid, 'p1', { teamId: null });
    expect((await choose(tid, 'p1', blue)).teamId).toBe(blue);
  });

  it('rejects someone who has not joined', async () => {
    const { tid, red } = await setup();
    expect((await rejection(choose(tid, 'stranger', red))).code).toBe('permission-denied');
  });

  it('rejects an unknown team, or one from another tournament', async () => {
    const { tid } = await setup();
    const other = await setup();
    for (const teamId of ['ghost', other.red]) {
      expect((await rejection(choose(tid, 'p1', teamId))).code).toBe('not-found');
    }
    expect(await entry(tid, 'p1')).toMatchObject({ teamId: null });
  });

  it('rejects a suspended tournament and an unknown tournament', async () => {
    const { tid, red } = await setup();
    await db.collection('tournaments').doc(tid).update({ status: 'suspended' });
    expect((await rejection(choose(tid, 'p1', red))).code).toBe('failed-precondition');
    expect((await rejection(choose('nope', 'p1', red))).code).toBe('not-found');
  });

  it.each([
    ['missing teamId', { tournamentId: 'T' }],
    ['non-string teamId', { tournamentId: 'T', teamId: 5 }],
    ['path-like teamId', { tournamentId: 'T', teamId: 'a/b' }],
    ['missing tournamentId', { teamId: 'x' }],
  ])('rejects %s', async (_label, input) => {
    const err = await rejection(chooseTeam(db, 'p1', input as never, new UsageTracker()));
    expect(err.code).toBe('invalid-argument');
  });
});
