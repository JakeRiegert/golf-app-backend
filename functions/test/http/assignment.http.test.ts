import { describe, expect, it } from 'vitest';

import { call, createTeams, joinedPlayer, newTrip, ok, readDoc, refused, signUp } from './helpers';

// HTTP-level team assignment: a player picks their own team, an admin overrides, and Start locks
// the player's choice. (Handicap rules are in handicap.http.test.ts.)
describe('team assignment over HTTP', { timeout: 60_000 }, () => {
  const entry = async (viewer: Parameters<typeof readDoc>[0], tid: string, uid: string) =>
    (await readDoc(viewer, `tournaments/${tid}/players/${uid}`)).data;

  it('rejects calls with no sign-in token', async () => {
    expect((await call(null, 'chooseTeam', { tournamentId: 'T', teamId: null })).http).toBe(401);
    expect((await call(null, 'assignTournamentPlayer', { tournamentId: 'T', playerId: 'p', teamId: null })).http).toBe(401);
  });

  it('lets a player pick, change and leave their own team, recorded as player-chosen', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const teams = await createTeams(trip, ['Red', 'Blue']);
    const tid = trip.tournamentId;

    const picked = await ok(player, 'chooseTeam', { tournamentId: tid, teamId: teams.Red });
    expect(picked).toMatchObject({ teamId: teams.Red, teamAssignedBy: 'player' });
    await ok(player, 'chooseTeam', { tournamentId: tid, teamId: teams.Blue });
    expect((await entry(player, tid, player.uid))?.teamId).toBe(teams.Blue);
    await ok(player, 'chooseTeam', { tournamentId: tid, teamId: null });
    expect(await entry(player, tid, player.uid)).toMatchObject({ teamId: null, teamAssignedBy: null });
  });

  it('lets the organizer override, which locks the player until the organizer clears it', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const teams = await createTeams(trip, ['Red', 'Blue']);
    const tid = trip.tournamentId;
    await ok(player, 'chooseTeam', { tournamentId: tid, teamId: teams.Red });

    const assigned = await ok(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid, teamId: teams.Blue });
    expect(assigned).toMatchObject({ teamId: teams.Blue, teamAssignedBy: 'admin' });
    await refused(player, 'chooseTeam', { tournamentId: tid, teamId: teams.Red }, 'PERMISSION_DENIED');
    expect((await entry(player, tid, player.uid))?.teamId).toBe(teams.Blue);

    await ok(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid, teamId: null });
    expect((await ok(player, 'chooseTeam', { tournamentId: tid, teamId: teams.Red })).teamId).toBe(teams.Red);
  });

  it('locks a player\'s own team choice when the tournament starts; admins can still assign; Reopen unlocks', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const teams = await createTeams(trip, ['Red', 'Blue']);
    const tid = trip.tournamentId;
    await ok(player, 'chooseTeam', { tournamentId: tid, teamId: teams.Red });

    await ok(trip.organizer, 'startTournament', { tournamentId: tid });
    await refused(player, 'chooseTeam', { tournamentId: tid, teamId: teams.Blue }, 'PERMISSION_DENIED');
    await refused(player, 'chooseTeam', { tournamentId: tid, teamId: null }, 'PERMISSION_DENIED');
    expect((await entry(player, tid, player.uid))?.teamId).toBe(teams.Red);

    await ok(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid, teamId: teams.Blue });
    expect((await entry(player, tid, player.uid))?.teamId).toBe(teams.Blue);

    await ok(trip.organizer, 'updateTournament', { tournamentId: tid, started: false });
    await ok(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid, teamId: null });
    expect((await ok(player, 'chooseTeam', { tournamentId: tid, teamId: teams.Red })).teamId).toBe(teams.Red);
  });

  it('only ever changes the caller\'s own entry when choosing a team', async () => {
    const trip = await newTrip();
    const a = await joinedPlayer(trip, 'a');
    const b = await joinedPlayer(trip, 'b');
    const teams = await createTeams(trip, ['Red']);

    await ok(a, 'chooseTeam', { tournamentId: trip.tournamentId, teamId: teams.Red });
    expect((await entry(b, trip.tournamentId, b.uid))?.teamId).toBeNull();
    expect((await entry(a, trip.tournamentId, a.uid))?.teamId).toBe(teams.Red);
  });

  it('refuses a player, or a stranger, assigning anyone, themselves included', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const stranger = await signUp('stranger');
    const teams = await createTeams(trip, ['Red']);
    const tid = trip.tournamentId;

    await refused(player, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid, teamId: teams.Red }, 'PERMISSION_DENIED');
    await refused(stranger, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid, teamId: teams.Red }, 'PERMISSION_DENIED');
    expect((await entry(player, tid, player.uid))?.teamId).toBeNull();
  });

  it('rejects an unknown team, an unknown player, a stranger choosing, and an empty change', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const stranger = await signUp('stranger');
    const teams = await createTeams(trip, ['Red']);
    const tid = trip.tournamentId;

    await refused(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid, teamId: 'ghost' }, 'NOT_FOUND');
    await refused(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: 'nobody', teamId: teams.Red }, 'NOT_FOUND');
    await refused(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid }, 'INVALID_ARGUMENT');
    await refused(player, 'chooseTeam', { tournamentId: tid, teamId: 'ghost' }, 'NOT_FOUND');
    await refused(player, 'chooseTeam', { tournamentId: tid }, 'INVALID_ARGUMENT');
    await refused(stranger, 'chooseTeam', { tournamentId: tid, teamId: teams.Red }, 'PERMISSION_DENIED');
  });
});
