import { describe, expect, it } from 'vitest';

import { call, createTeams, joinedPlayer, listDocs, newTrip, ok, readDoc, refused, signUp } from './helpers';

// HTTP-level deleteTeam.
describe('deleteTeam over HTTP', { timeout: 60_000 }, () => {
  it('rejects a call with no sign-in token', async () => {
    const res = await call(null, 'deleteTeam', { tournamentId: 'T', teamId: 'x' });
    expect(res.http).toBe(401);
    expect(res.error?.status).toBe('UNAUTHENTICATED');
  });

  it('before the start deletes the team and sends its players back to No team', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const player = await joinedPlayer(trip);
    const teams = await createTeams(trip, ['Red', 'Blue']);
    await ok(player, 'chooseTeam', { tournamentId: tid, teamId: teams.Red });

    expect(await ok(trip.organizer, 'deleteTeam', { tournamentId: tid, teamId: teams.Red })).toEqual({
      tournamentId: tid,
      teamId: teams.Red,
      unassigned: 1,
    });
    expect((await listDocs(player, `tournaments/${tid}/teams`)).docs.map((t) => t.data.name)).toEqual(['Blue']);
    expect((await readDoc(player, `tournaments/${tid}/players/${player.uid}`)).data).toMatchObject({
      teamId: null,
      teamAssignedBy: null,
    });
    expect((await ok(player, 'chooseTeam', { tournamentId: tid, teamId: teams.Blue })).teamId).toBe(teams.Blue);
  });

  it('after the start refuses a team with players, and allows an empty one', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const player = await joinedPlayer(trip);
    const teams = await createTeams(trip, ['Red', 'Blue']);
    await ok(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid, teamId: teams.Red });
    await ok(trip.organizer, 'startTournament', { tournamentId: tid });

    await refused(trip.organizer, 'deleteTeam', { tournamentId: tid, teamId: teams.Red }, 'FAILED_PRECONDITION');
    await ok(trip.organizer, 'deleteTeam', { tournamentId: tid, teamId: teams.Blue });
    expect((await listDocs(trip.organizer, `tournaments/${tid}/teams`)).docs.map((t) => t.data.name)).toEqual(['Red']);
  });

  it('refuses a player, a stranger and an unknown team', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const player = await joinedPlayer(trip);
    const stranger = await signUp('stranger');
    const teams = await createTeams(trip, ['Red']);

    await refused(player, 'deleteTeam', { tournamentId: tid, teamId: teams.Red }, 'PERMISSION_DENIED');
    await refused(stranger, 'deleteTeam', { tournamentId: tid, teamId: teams.Red }, 'PERMISSION_DENIED');
    await refused(trip.organizer, 'deleteTeam', { tournamentId: tid, teamId: 'ghost' }, 'NOT_FOUND');
    expect((await listDocs(trip.organizer, `tournaments/${tid}/teams`)).docs).toHaveLength(1);
  });
});
