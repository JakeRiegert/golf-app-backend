import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assignTournamentPlayer, chooseTeam } from '../src/assignment';
import { startTournament } from '../src/lifecycle';
import { joinTournament } from '../src/roster';
import { createTeams, updateTeam } from '../src/teams';
import { assignCoAdmin, updateTournament } from '../src/tournamentAdmin';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.
// What gets written to the activity feed, at which level, and that nothing is written when nothing
// really changed. (Who can READ the feed is in rules.emulated.test.ts and activity.http.test.ts.)

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-activity' }, 'activity-test'));
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection('tournaments'));
  await db.recursiveDelete(db.collection('inviteCodes'));
});

const u = () => new UsageTracker();

// org1 organizes a tournament; p1 and p2 have joined; teams Red and Blue exist.
async function setup() {
  const t = await createTournament(db, 'org1', { name: 'Feed Cup' }, u());
  await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, u());
  await joinTournament(db, 'p2', { inviteCode: t.inviteCode }, u());
  const { teams } = await createTeams(db, 'org1', { tournamentId: t.id, teams: [{ name: 'Red' }, { name: 'Blue' }] }, u());
  return { tid: t.id, code: t.inviteCode, red: teams[0].id, blue: teams[1].id };
}

// Every event so far, oldest first. Events written by one call share a server timestamp (one
// transaction), so their relative order is not defined; ties are broken by type to keep this stable.
async function feed(tid: string, after = 0) {
  const snap = await db.collection('tournaments').doc(tid).collection('activity').get();
  return snap.docs
    .map((d) => d.data())
    .sort((a, b) => a.at.toMillis() - b.at.toMillis() || String(a.type).localeCompare(String(b.type)))
    .slice(after);
}
const count = async (tid: string) => (await feed(tid)).length;

describe('activity feed events', () => {
  it('records joins for the admins only, and nothing for a repeat join', async () => {
    const t = await createTournament(db, 'org1', { name: 'Join Cup' }, u());
    await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, u());
    await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, u());

    const events = await feed(t.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'player_joined', actorId: 'p1', targetPlayerId: 'p1', level: 'admins' });
    expect(events[0].at).toBeDefined();
  });

  it('records Start and Reopen for everyone, once each, and nothing for a repeat', async () => {
    const { tid } = await setup();
    const base = await count(tid);

    await startTournament(db, 'org1', { tournamentId: tid }, u());
    await startTournament(db, 'org1', { tournamentId: tid }, u());
    await updateTournament(db, 'org1', { tournamentId: tid, started: false }, u());
    await updateTournament(db, 'org1', { tournamentId: tid, started: false }, u());
    await updateTournament(db, 'org1', { tournamentId: tid, started: true }, u());

    const events = await feed(tid, base);
    expect(events.map((e) => [e.type, e.level, e.actorId])).toEqual([
      ['tournament_started', 'all', 'org1'],
      ['tournament_reopened', 'all', 'org1'],
      ['tournament_started', 'all', 'org1'],
    ]);
  });

  it('keeps early setup edits between admins, announces visibility changes, and records only real changes', async () => {
    const { tid } = await setup();
    const base = await count(tid);

    await updateTournament(db, 'org1', { tournamentId: tid, name: 'Renamed Cup', startDate: '2026-12-01' }, u());
    await updateTournament(db, 'org1', { tournamentId: tid, name: 'Renamed Cup' }, u()); // nothing changed
    await updateTournament(db, 'org1', { tournamentId: tid, visibility: 'public' }, u());

    const events = await feed(tid, base);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'tournament_updated',
      level: 'admins',
      changes: { name: { from: 'Feed Cup', to: 'Renamed Cup' }, startDate: { from: null, to: '2026-12-01' } },
    });
    expect(events[1]).toMatchObject({
      type: 'tournament_updated',
      level: 'all',
      changes: { visibility: { from: 'private', to: 'public' } },
    });
  });

  it('announces every edit to everyone once the tournament has started', async () => {
    const { tid } = await setup();
    await startTournament(db, 'org1', { tournamentId: tid }, u());
    const base = await count(tid);

    await updateTournament(db, 'org1', { tournamentId: tid, wagerPotAmount: 250 }, u());
    const events = await feed(tid, base);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tournament_updated', level: 'all', changes: { wagerPotAmount: { from: null, to: 250 } } });
  });

  it('records team creation and renames, admins only before the start and everyone after', async () => {
    const { tid, red } = await setup();
    const base = await count(tid);

    await createTeams(db, 'org1', { tournamentId: tid, teams: [{ name: 'Green' }] }, u());
    await updateTeam(db, 'org1', { tournamentId: tid, teamId: red, name: 'Crimson' }, u());
    await updateTeam(db, 'org1', { tournamentId: tid, teamId: red, name: 'Crimson' }, u()); // unchanged
    await startTournament(db, 'org1', { tournamentId: tid }, u());
    await updateTeam(db, 'org1', { tournamentId: tid, teamId: red, color: '#cc0000' }, u());

    const events = await feed(tid, base);
    expect(events.map((e) => [e.type, e.level])).toEqual([
      ['teams_created', 'admins'],
      ['team_updated', 'admins'],
      ['tournament_started', 'all'],
      ['team_updated', 'all'],
    ]);
    expect(events[0].data).toEqual({ count: 1, names: ['Green'] });
    expect(events[1]).toMatchObject({ changes: { name: { from: 'Red', to: 'Crimson' } }, data: { teamId: red } });
    expect(events[3].changes).toEqual({ color: { from: null, to: '#CC0000' } });
  });

  it('records admin team and handicap assignments about the player, announced to all after the start', async () => {
    const { tid, red, blue } = await setup();
    const base = await count(tid);

    await assignTournamentPlayer(db, 'org1', { tournamentId: tid, playerId: 'p1', teamId: red, handicap: 12 }, u());
    await assignTournamentPlayer(db, 'org1', { tournamentId: tid, playerId: 'p1', teamId: red, handicap: 12 }, u()); // same
    await startTournament(db, 'org1', { tournamentId: tid }, u());
    await assignTournamentPlayer(db, 'org1', { tournamentId: tid, playerId: 'p1', teamId: blue, handicap: 14 }, u());

    // Within one call the two events tie on time, so they come back handicap first, then team.
    const events = await feed(tid, base);
    expect(events.map((e) => [e.type, e.level, e.targetPlayerId])).toEqual([
      ['handicap_changed', 'affected', 'p1'],
      ['team_assigned', 'affected', 'p1'],
      ['tournament_started', 'all', null],
      ['handicap_changed', 'all', 'p1'],
      ['team_assigned', 'all', 'p1'],
    ]);
    expect(events[0].changes).toEqual({ handicap: { from: null, to: 12 } });
    expect(events[1]).toMatchObject({ changes: { teamId: { from: null, to: red } }, data: { teamName: 'Red' } });
    expect(events[3].changes).toEqual({ handicap: { from: 12, to: 14 } });
    expect(events[4]).toMatchObject({ changes: { teamId: { from: red, to: blue } }, data: { teamName: 'Blue' } });
  });

  it('does not record a player choosing their own team before the start', async () => {
    const { tid, red } = await setup();
    const base = await count(tid);
    await chooseTeam(db, 'p1', { tournamentId: tid, teamId: red }, u());
    expect(await feed(tid, base)).toHaveLength(0);
  });

  it('records co-admin changes for everyone, and nothing when nothing changed', async () => {
    const { tid } = await setup();
    const base = await count(tid);

    await assignCoAdmin(db, 'org1', { tournamentId: tid, playerId: 'p1' }, u());
    await assignCoAdmin(db, 'org1', { tournamentId: tid, playerId: 'p1' }, u()); // same
    await assignCoAdmin(db, 'org1', { tournamentId: tid, playerId: null }, u());

    const events = await feed(tid, base);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'co_admin_changed', level: 'all', targetPlayerId: 'p1', changes: { coAdminId: { from: null, to: 'p1' } } });
    expect(events[1]).toMatchObject({ type: 'co_admin_changed', level: 'all', targetPlayerId: 'p1', changes: { coAdminId: { from: 'p1', to: null } } });
  });

  it('leaves no record when a call is refused', async () => {
    const { tid } = await setup();
    const base = await count(tid);

    await expect(updateTournament(db, 'p1', { tournamentId: tid, name: 'Hijack' }, u())).rejects.toThrow();
    await expect(startTournament(db, 'p1', { tournamentId: tid }, u())).rejects.toThrow();
    await expect(assignCoAdmin(db, 'p1', { tournamentId: tid, playerId: 'p1' }, u())).rejects.toThrow();
    await expect(createTeams(db, 'p1', { tournamentId: tid, teams: [{ name: 'Sneaky' }] }, u())).rejects.toThrow();
    expect(await feed(tid, base)).toHaveLength(0);
  });

  it('counts the event as a document written, so its cost shows in the usage log', async () => {
    const { tid } = await setup();
    const usage = u();
    await startTournament(db, 'org1', { tournamentId: tid }, usage);
    expect(usage.docsWritten).toBe(2); // startedAt plus the event
  });
});
