import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assignTournamentPlayer, chooseTeam } from '../src/assignment';
import { setMyHandicap } from '../src/handicap';
import { startTournament } from '../src/lifecycle';
import { joinTournament, removePlayer } from '../src/roster';
import { createTeams, deleteTeam } from '../src/teams';
import { assignCoAdmin, updateTournament } from '../src/tournamentAdmin';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.
// Removing a player and deleting a team.

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-removal' }, 'removal-test'));
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

// org1 runs the tournament; p1, p2 and p3 have joined; teams Red and Blue exist.
async function setup() {
  const t = await createTournament(db, 'org1', { name: 'Removal Cup' }, u());
  for (const p of ['p1', 'p2', 'p3']) await joinTournament(db, p, { inviteCode: t.inviteCode }, u());
  const { teams } = await createTeams(db, 'org1', { tournamentId: t.id, teams: [{ name: 'Red' }, { name: 'Blue' }] }, u());
  return { tid: t.id, code: t.inviteCode, red: teams[0].id, blue: teams[1].id };
}

const entry = async (tid: string, uid: string) =>
  (await db.collection('tournaments').doc(tid).collection('players').doc(uid).get()).data();
const tournament = async (tid: string) => (await db.collection('tournaments').doc(tid).get()).data();
const teamIds = async (tid: string) =>
  (await db.collection('tournaments').doc(tid).collection('teams').get()).docs.map((d) => d.id);

async function feed(tid: string, after = 0) {
  const snap = await db.collection('tournaments').doc(tid).collection('activity').get();
  return snap.docs
    .map((d) => d.data())
    .sort((a, b) => a.at.toMillis() - b.at.toMillis() || String(a.type).localeCompare(String(b.type)))
    .slice(after);
}

const remove = (tid: string, playerId: string, uid = 'org1', usage = u()) =>
  removePlayer(db, uid, { tournamentId: tid, playerId }, usage);

describe('removePlayer', () => {
  it('before the start deletes the roster entry, announces it to admins, and the person can rejoin', async () => {
    const { tid, code } = await setup();
    const base = (await feed(tid)).length;
    const usage = u();

    const result = await remove(tid, 'p1', 'org1', usage);
    expect(result).toEqual({ tournamentId: tid, playerId: 'p1', withdrawn: false });
    expect(await entry(tid, 'p1')).toBeUndefined();
    expect(await entry(tid, 'p2')).toBeDefined(); // nobody else is touched
    expect(usage.docsWritten).toBe(2); // the delete plus the activity event

    const events = await feed(tid, base);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'player_removed',
      actorId: 'org1',
      targetPlayerId: 'p1',
      level: 'admins',
      data: { withdrawn: false },
    });

    // The code still works, so a removed person can come back (rotating the code is a later feature).
    expect((await joinTournament(db, 'p1', { inviteCode: code }, u())).alreadyMember).toBe(false);
  });

  it('after the start keeps the record, marks the player withdrawn and announces it to everyone', async () => {
    const { tid, red } = await setup();
    await assignTournamentPlayer(db, 'org1', { tournamentId: tid, playerId: 'p1', teamId: red, handicap: 9 }, u());
    await startTournament(db, 'org1', { tournamentId: tid }, u());
    const base = (await feed(tid)).length;

    const result = await remove(tid, 'p1');
    expect(result).toEqual({ tournamentId: tid, playerId: 'p1', withdrawn: true });
    expect(await entry(tid, 'p1')).toMatchObject({ withdrawn: true, teamId: red, handicap: 9 }); // record kept
    expect((await entry(tid, 'p1'))?.withdrawnAt).toBeDefined();

    const events = await feed(tid, base);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'player_removed', level: 'all', targetPlayerId: 'p1', data: { withdrawn: true } });
  });

  it('is harmless to repeat on a withdrawn player', async () => {
    const { tid } = await setup();
    await startTournament(db, 'org1', { tournamentId: tid }, u());
    await remove(tid, 'p1');
    const base = (await feed(tid)).length;

    expect((await remove(tid, 'p1')).withdrawn).toBe(true);
    expect(await feed(tid, base)).toHaveLength(0);
  });

  it('refuses the organizer, yourself, a non-admin and a stranger, and changes nothing', async () => {
    const { tid } = await setup();
    await assignCoAdmin(db, 'org1', { tournamentId: tid, playerId: 'p1' }, u());

    expect((await rejection(remove(tid, 'org1', 'p1'))).code).toBe('invalid-argument'); // the organizer
    expect((await rejection(remove(tid, 'p1', 'p1'))).code).toBe('invalid-argument'); // yourself
    expect((await rejection(remove(tid, 'p3', 'p2'))).code).toBe('permission-denied'); // a player
    expect((await rejection(remove(tid, 'p3', 'stranger'))).code).toBe('permission-denied');
    expect(await entry(tid, 'org1')).toBeDefined();
    expect(await entry(tid, 'p3')).toBeDefined();
  });

  it('rejects an unknown player, an unknown tournament and bad ids', async () => {
    const { tid } = await setup();
    expect((await rejection(remove(tid, 'nobody'))).code).toBe('not-found');
    expect((await rejection(remove('nope', 'p1'))).code).toBe('not-found');
    expect((await rejection(removePlayer(db, 'org1', { playerId: 'p1' }, u()))).code).toBe('invalid-argument');
    expect((await rejection(removePlayer(db, 'org1', { tournamentId: tid, playerId: 'a/b' }, u()))).code).toBe('invalid-argument');
    expect((await rejection(removePlayer(db, 'org1', { tournamentId: tid }, u()))).code).toBe('invalid-argument');
  });

  it('lets the co-admin remove a player', async () => {
    const { tid } = await setup();
    await assignCoAdmin(db, 'org1', { tournamentId: tid, playerId: 'p1' }, u());
    await remove(tid, 'p2', 'p1');
    expect(await entry(tid, 'p2')).toBeUndefined();
  });

  it('clears the co-admin role when the co-admin is removed, and says so', async () => {
    const { tid } = await setup();
    await assignCoAdmin(db, 'org1', { tournamentId: tid, playerId: 'p1' }, u());
    const base = (await feed(tid)).length;

    await remove(tid, 'p1');
    expect((await tournament(tid))?.coAdminId).toBeNull();

    const events = await feed(tid, base);
    expect(events.map((e) => [e.type, e.level]).sort()).toEqual([
      ['co_admin_changed', 'all'],
      ['player_removed', 'admins'],
    ]);
    expect(events.find((e) => e.type === 'co_admin_changed')?.changes).toEqual({ coAdminId: { from: 'p1', to: null } });
  });

  it('stops a withdrawn player from changing their team or handicap', async () => {
    const { tid, red } = await setup();
    await startTournament(db, 'org1', { tournamentId: tid }, u());
    await remove(tid, 'p1');
    await updateTournament(db, 'org1', { tournamentId: tid, started: false }, u()); // even after a Reopen

    const team = await rejection(chooseTeam(db, 'p1', { tournamentId: tid, teamId: red }, u()));
    expect(team.code).toBe('permission-denied');
    expect(team.message).toMatch(/removed/);
    const handicap = await rejection(setMyHandicap(db, 'p1', { tournamentId: tid, handicap: 5 }, u()));
    expect(handicap.code).toBe('permission-denied');
    expect(handicap.message).toMatch(/removed/);
  });
});

describe('deleteTeam', () => {
  const del = (tid: string, teamId: string, uid = 'org1', usage = u()) =>
    deleteTeam(db, uid, { tournamentId: tid, teamId }, usage);

  it('before the start deletes the team and sends its players back to No team', async () => {
    const { tid, red, blue } = await setup();
    await assignTournamentPlayer(db, 'org1', { tournamentId: tid, playerId: 'p1', teamId: red }, u()); // admin-assigned
    await chooseTeam(db, 'p2', { tournamentId: tid, teamId: red }, u()); // player-chosen
    await chooseTeam(db, 'p3', { tournamentId: tid, teamId: blue }, u()); // a different team
    const base = (await feed(tid)).length;
    const usage = u();

    const result = await del(tid, red, 'org1', usage);
    expect(result).toEqual({ tournamentId: tid, teamId: red, unassigned: 2 });
    expect(await teamIds(tid)).toEqual([blue]);
    expect(await entry(tid, 'p1')).toMatchObject({ teamId: null, teamAssignedBy: null });
    expect(await entry(tid, 'p2')).toMatchObject({ teamId: null, teamAssignedBy: null });
    expect(await entry(tid, 'p3')).toMatchObject({ teamId: blue, teamAssignedBy: 'player' }); // untouched
    expect(usage.docsWritten).toBe(4); // two players, the team, the activity event
    expect(usage.teamCount).toBe(1);

    const events = await feed(tid, base);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'team_deleted', level: 'admins', data: { teamId: red, name: 'Red', unassigned: 2 } });
  });

  it('lets a player pick a fresh team afterwards, since their choice was handed back', async () => {
    const { tid, red, blue } = await setup();
    await assignTournamentPlayer(db, 'org1', { tournamentId: tid, playerId: 'p1', teamId: red }, u());
    await del(tid, red);
    expect((await chooseTeam(db, 'p1', { tournamentId: tid, teamId: blue }, u())).teamId).toBe(blue);
  });

  it('after the start refuses a team that still has players, and announces deleting an empty one', async () => {
    const { tid, red, blue } = await setup();
    await chooseTeam(db, 'p1', { tournamentId: tid, teamId: red }, u());
    await startTournament(db, 'org1', { tournamentId: tid }, u());
    const base = (await feed(tid)).length;

    const err = await rejection(del(tid, red));
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toMatch(/Move the 1 player/);
    expect(await teamIds(tid)).toContain(red);
    expect(await entry(tid, 'p1')).toMatchObject({ teamId: red });

    await del(tid, blue); // nobody is on Blue
    expect(await teamIds(tid)).toEqual([red]);
    const events = await feed(tid, base);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'team_deleted', level: 'all', data: { name: 'Blue', unassigned: 0 } });
  });

  it('lets the co-admin delete, and refuses a player and a stranger', async () => {
    const { tid, red, blue } = await setup();
    expect((await rejection(del(tid, red, 'p1'))).code).toBe('permission-denied');
    expect((await rejection(del(tid, red, 'stranger'))).code).toBe('permission-denied');
    await assignCoAdmin(db, 'org1', { tournamentId: tid, playerId: 'p1' }, u());
    await del(tid, blue, 'p1');
    expect(await teamIds(tid)).toEqual([red]);
  });

  it('rejects an unknown team, a team from another tournament, and bad ids', async () => {
    const { tid, red } = await setup();
    const other = await setup();
    expect((await rejection(del(tid, 'ghost'))).code).toBe('not-found');
    expect((await rejection(del(other.tid, red))).code).toBe('not-found'); // red belongs to the first one
    expect((await rejection(deleteTeam(db, 'org1', { teamId: red }, u()))).code).toBe('invalid-argument');
    expect((await rejection(deleteTeam(db, 'org1', { tournamentId: tid }, u()))).code).toBe('invalid-argument');
    expect((await rejection(deleteTeam(db, 'org1', { tournamentId: tid, teamId: 'a/b' }, u()))).code).toBe('invalid-argument');
    expect(await teamIds(tid)).toContain(red);
  });
});
