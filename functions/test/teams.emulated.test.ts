import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTeams, updateTeam } from '../src/teams';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-teams' }, 'teams-test'));
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

async function newTournament() {
  return createTournament(db, 'org1', { name: 'Team Event' }, new UsageTracker());
}

async function teamDocs(tid: string) {
  return (await db.collection('tournaments').doc(tid).collection('teams').get()).docs;
}

describe('createTeams', () => {
  it('creates several teams at once, one with a color and one without', async () => {
    const t = await newTournament();
    const usage = new UsageTracker();
    const { teams } = await createTeams(
      db,
      'org1',
      { tournamentId: t.id, teams: [{ name: ' Red ', color: '#d32f2f' }, { name: 'Blue' }] },
      usage,
    );

    expect(teams).toHaveLength(2);
    expect(teams[0]).toMatchObject({ name: 'Red', color: '#D32F2F' });
    expect(teams[1]).toMatchObject({ name: 'Blue', color: null });
    expect(teams[0].id).not.toBe(teams[1].id);

    const docs = await teamDocs(t.id);
    expect(docs.map((d) => d.data().name).sort()).toEqual(['Blue', 'Red']);
    expect(docs[0].data().createdAt).toBeDefined();
    expect(usage.tournamentId).toBe(t.id);
    expect(usage.docsWritten).toBe(2);
  });

  it('lets the co-admin create teams', async () => {
    const t = await newTournament();
    await db.collection('tournaments').doc(t.id).update({ coAdminId: 'co1' });
    const { teams } = await createTeams(db, 'co1', { tournamentId: t.id, teams: [{ name: 'Green' }] }, new UsageTracker());
    expect(teams).toHaveLength(1);
  });

  it('rejects a player who is not an admin, and writes nothing', async () => {
    const t = await newTournament();
    const err = await rejection(
      createTeams(db, 'someone', { tournamentId: t.id, teams: [{ name: 'Sneaky' }] }, new UsageTracker()),
    );
    expect(err.code).toBe('permission-denied');
    expect(await teamDocs(t.id)).toHaveLength(0);
  });

  it('rejects an unknown tournament', async () => {
    const err = await rejection(
      createTeams(db, 'org1', { tournamentId: 'nope', teams: [{ name: 'A' }] }, new UsageTracker()),
    );
    expect(err.code).toBe('not-found');
  });

  it('rejects writes to a suspended tournament', async () => {
    const t = await newTournament();
    await db.collection('tournaments').doc(t.id).update({ status: 'suspended' });
    const err = await rejection(
      createTeams(db, 'org1', { tournamentId: t.id, teams: [{ name: 'A' }] }, new UsageTracker()),
    );
    expect(err.code).toBe('failed-precondition');
    expect(await teamDocs(t.id)).toHaveLength(0);
  });

  it('rejects a duplicate name within the request, or against an existing team, ignoring case', async () => {
    const t = await newTournament();
    const twice = await rejection(
      createTeams(db, 'org1', { tournamentId: t.id, teams: [{ name: 'Red' }, { name: 'red' }] }, new UsageTracker()),
    );
    expect(twice.code).toBe('invalid-argument');

    await createTeams(db, 'org1', { tournamentId: t.id, teams: [{ name: 'Red' }] }, new UsageTracker());
    const clash = await rejection(
      createTeams(db, 'org1', { tournamentId: t.id, teams: [{ name: 'RED' }, { name: 'Gold' }] }, new UsageTracker()),
    );
    expect(clash.code).toBe('already-exists');
    expect(await teamDocs(t.id)).toHaveLength(1); // all or nothing: Gold was not created either
  });

  it('enforces the per-tournament team cap', async () => {
    const t = await newTournament();
    const names = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => ({ name: `Team ${from + i}` }));
    const first = new UsageTracker();
    await createTeams(db, 'org1', { tournamentId: t.id, teams: names(0, 100) }, first);
    expect(first.teamCount).toBe(100);
    const usage = new UsageTracker();
    const err = await rejection(
      createTeams(db, 'org1', { tournamentId: t.id, teams: [{ name: 'One too many' }] }, usage),
    );
    expect(err.code).toBe('resource-exhausted');
    expect(usage.teamCount).toBe(100); // measured even though the call was refused
    expect(await teamDocs(t.id)).toHaveLength(100);

    const tooMany = await rejection(
      createTeams(db, 'org1', { tournamentId: t.id, teams: names(200, 301) }, new UsageTracker()),
    );
    expect(tooMany.code).toBe('invalid-argument');
  });

  it('reports the tournament team count for the usage log on create and update', async () => {
    const t = await newTournament();
    const created = new UsageTracker();
    const { teams } = await createTeams(
      db,
      'org1',
      { tournamentId: t.id, teams: [{ name: 'Red' }, { name: 'Blue' }] },
      created,
    );
    expect(created.teamCount).toBe(2);

    const updated = new UsageTracker();
    await updateTeam(db, 'org1', { tournamentId: t.id, teamId: teams[0].id, name: 'Crimson' }, updated);
    expect(updated.teamCount).toBe(2);
  });

  it.each([
    ['missing tournamentId', { teams: [{ name: 'A' }] }],
    ['path-like tournamentId', { tournamentId: 'a/b', teams: [{ name: 'A' }] }],
    ['no teams', { tournamentId: 'T', teams: [] }],
    ['teams not a list', { tournamentId: 'T', teams: 'Red' }],
    ['blank name', { tournamentId: 'T', teams: [{ name: '  ' }] }],
    ['missing name', { tournamentId: 'T', teams: [{}] }],
    ['over-long name', { tournamentId: 'T', teams: [{ name: 'x'.repeat(51) }] }],
    ['bad color', { tournamentId: 'T', teams: [{ name: 'A', color: 'red' }] }],
  ])('rejects %s', async (_label, input) => {
    const err = await rejection(createTeams(db, 'org1', input as never, new UsageTracker()));
    expect(err.code).toBe('invalid-argument');
  });
});

describe('updateTeam', () => {
  async function tournamentWithTeams() {
    const t = await newTournament();
    const { teams } = await createTeams(
      db,
      'org1',
      { tournamentId: t.id, teams: [{ name: 'Red', color: '#D32F2F' }, { name: 'Blue' }] },
      new UsageTracker(),
    );
    return { t, red: teams[0], blue: teams[1] };
  }

  it('renames a team and leaves its color alone', async () => {
    const { t, red } = await tournamentWithTeams();
    const result = await updateTeam(db, 'org1', { tournamentId: t.id, teamId: red.id, name: 'Crimson' }, new UsageTracker());
    expect(result).toEqual({ id: red.id, name: 'Crimson', color: '#D32F2F' });
    const stored = (await db.collection('tournaments').doc(t.id).collection('teams').doc(red.id).get()).data();
    expect(stored).toMatchObject({ name: 'Crimson', color: '#D32F2F' });
    expect(stored?.updatedAt).toBeDefined();
  });

  it('sets a color, and clears one with null', async () => {
    const { t, red, blue } = await tournamentWithTeams();
    const set = await updateTeam(db, 'org1', { tournamentId: t.id, teamId: blue.id, color: '#1565c0' }, new UsageTracker());
    expect(set).toMatchObject({ name: 'Blue', color: '#1565C0' });
    const cleared = await updateTeam(db, 'org1', { tournamentId: t.id, teamId: red.id, color: null }, new UsageTracker());
    expect(cleared).toMatchObject({ name: 'Red', color: null });
  });

  it('allows keeping a team name unchanged but not taking another team name', async () => {
    const { t, red } = await tournamentWithTeams();
    const same = await updateTeam(db, 'org1', { tournamentId: t.id, teamId: red.id, name: 'red' }, new UsageTracker());
    expect(same.name).toBe('red');
    const clash = await rejection(
      updateTeam(db, 'org1', { tournamentId: t.id, teamId: red.id, name: 'BLUE' }, new UsageTracker()),
    );
    expect(clash.code).toBe('already-exists');
  });

  it('rejects non-admins, unknown teams, suspended tournaments and empty updates', async () => {
    const { t, red } = await tournamentWithTeams();
    const notAdmin = await rejection(
      updateTeam(db, 'someone', { tournamentId: t.id, teamId: red.id, name: 'Hax' }, new UsageTracker()),
    );
    expect(notAdmin.code).toBe('permission-denied');

    const missing = await rejection(
      updateTeam(db, 'org1', { tournamentId: t.id, teamId: 'ghost', name: 'X' }, new UsageTracker()),
    );
    expect(missing.code).toBe('not-found');

    const empty = await rejection(updateTeam(db, 'org1', { tournamentId: t.id, teamId: red.id }, new UsageTracker()));
    expect(empty.code).toBe('invalid-argument');

    await db.collection('tournaments').doc(t.id).update({ status: 'suspended' });
    const suspended = await rejection(
      updateTeam(db, 'org1', { tournamentId: t.id, teamId: red.id, name: 'Late' }, new UsageTracker()),
    );
    expect(suspended.code).toBe('failed-precondition');
  });

  it('cannot reach a team in a different tournament', async () => {
    const { red } = await tournamentWithTeams();
    const other = await newTournament();
    const err = await rejection(
      updateTeam(db, 'org1', { tournamentId: other.id, teamId: red.id, name: 'Stolen' }, new UsageTracker()),
    );
    expect(err.code).toBe('not-found');
  });
});
