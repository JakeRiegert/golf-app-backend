import { describe, expect, it } from 'vitest';

import { createTeams, joinedPlayer, newTrip, ok, queryCollection, signUp } from './helpers';

// HTTP-level activity feed: real changes made through the functions show up for exactly the people
// they should, read the way a client reads them (filtered queries under the real security rules).
describe('activity feed over HTTP', { timeout: 60_000 }, () => {
  const everyone = (user: Parameters<typeof queryCollection>[0], tid: string) =>
    queryCollection(user, `tournaments/${tid}`, 'activity', [['level', 'all']], 'at');
  const aboutMe = (user: Parameters<typeof queryCollection>[0], tid: string, uid: string) =>
    queryCollection(user, `tournaments/${tid}`, 'activity', [['level', 'affected'], ['targetPlayerId', uid]], 'at');
  const all = (user: Parameters<typeof queryCollection>[0], tid: string) =>
    queryCollection(user, `tournaments/${tid}`, 'activity', [], 'at');
  const types = (docs: { data: Record<string, any> }[]) => docs.map((d) => d.data.type);

  it('shows admins everything, including joins and early setup edits', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const player = await joinedPlayer(trip);
    await createTeams(trip, ['Red']);
    await ok(trip.organizer, 'updateTournament', { tournamentId: tid, name: 'Renamed' });

    const feed = await all(trip.organizer, tid);
    expect(feed.http).toBe(200);
    expect(types(feed.docs).sort()).toEqual(['player_joined', 'teams_created', 'tournament_updated']);
    const joined = feed.docs.find((d) => d.data.type === 'player_joined')!;
    expect(joined.data).toMatchObject({ actorId: player.uid, targetPlayerId: player.uid, level: 'admins' });
  });

  it('announces Start, Reopen and co-admin changes to every member, and not the quiet setup noise', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const a = await joinedPlayer(trip, 'a');
    const b = await joinedPlayer(trip, 'b');
    await createTeams(trip, ['Red']); // admins only before the start
    await ok(trip.organizer, 'assignCoAdmin', { tournamentId: tid, playerId: b.uid });
    await ok(trip.organizer, 'startTournament', { tournamentId: tid });
    await ok(trip.organizer, 'updateTournament', { tournamentId: tid, started: false });

    for (const member of [a, b]) {
      const feed = await everyone(member, tid);
      expect(feed.http).toBe(200);
      expect(types(feed.docs).sort()).toEqual(['co_admin_changed', 'tournament_reopened', 'tournament_started']);
      expect(JSON.stringify(feed.docs)).not.toContain('@'); // IDs only, never an email
    }
  });

  it('tells a player about changes to them before the start, and tells nobody else', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const a = await joinedPlayer(trip, 'a');
    const b = await joinedPlayer(trip, 'b');
    const teams = await createTeams(trip, ['Red']);
    await ok(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: a.uid, teamId: teams.Red, handicap: 12 });

    const mine = await aboutMe(a, tid, a.uid);
    expect(mine.http).toBe(200);
    expect(types(mine.docs).sort()).toEqual(['handicap_changed', 'team_assigned']);
    expect(mine.docs.find((d) => d.data.type === 'team_assigned')?.data.data).toMatchObject({ teamName: 'Red' });

    expect((await aboutMe(b, tid, b.uid)).docs).toHaveLength(0);
    expect((await aboutMe(b, tid, a.uid)).http).toBe(403); // cannot ask about someone else
    expect((await everyone(b, tid)).docs).toHaveLength(0); // not announced before the start
  });

  it('announces admin changes to everyone once the tournament has started', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const a = await joinedPlayer(trip, 'a');
    const b = await joinedPlayer(trip, 'b');
    const teams = await createTeams(trip, ['Red', 'Blue']);
    await ok(trip.organizer, 'startTournament', { tournamentId: tid });
    await ok(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: a.uid, teamId: teams.Blue, handicap: 14 });
    await ok(trip.organizer, 'updateTournament', { tournamentId: tid, wagerPotAmount: 100 });

    const feed = await everyone(b, tid); // a different player sees it all
    expect(feed.http).toBe(200);
    expect(types(feed.docs).sort()).toEqual(
      ['handicap_changed', 'team_assigned', 'tournament_started', 'tournament_updated'].sort(),
    );
    const newest = feed.docs[0].data; // newest first
    expect(['tournament_updated', 'team_assigned', 'handicap_changed']).toContain(newest.type);
    expect(feed.docs.find((d) => d.data.type === 'handicap_changed')?.data.changes).toEqual({
      handicap: { from: null, to: 14 },
    });
  });

  it('never lets a member list the whole feed, or ask for admins-only events', async () => {
    const trip = await newTrip();
    const member = await joinedPlayer(trip);
    const tid = trip.tournamentId;

    expect((await all(member, tid)).http).toBe(403);
    expect((await queryCollection(member, `tournaments/${tid}`, 'activity', [['level', 'admins']])).http).toBe(403);
    expect((await queryCollection(member, `tournaments/${tid}`, 'activity', [['level', 'affected']])).http).toBe(403);
    expect((await queryCollection(member, `tournaments/${tid}`, 'activity', [['targetPlayerId', member.uid]])).http).toBe(403);
  });

  it('gives a stranger, a spectator of a public tournament, and anonymous nothing', async () => {
    const trip = await newTrip({ visibility: 'public' });
    const tid = trip.tournamentId;
    const stranger = await signUp('spectator');
    await ok(trip.organizer, 'startTournament', { tournamentId: tid });

    expect((await everyone(stranger, tid)).http).toBe(403);
    expect((await everyone(null, tid)).http).toBe(403);
    expect((await all(stranger, tid)).http).toBe(403);
  });

  it('lets the co-admin read the whole feed, and stops when the role is taken away', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const co = await joinedPlayer(trip, 'co');
    await ok(trip.organizer, 'assignCoAdmin', { tournamentId: tid, playerId: co.uid });
    expect((await all(co, tid)).http).toBe(200);
    expect(types((await all(co, tid)).docs)).toContain('player_joined');

    await ok(trip.organizer, 'assignCoAdmin', { tournamentId: tid, playerId: null });
    expect((await all(co, tid)).http).toBe(403);
  });
});
