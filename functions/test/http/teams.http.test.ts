import { describe, expect, it } from 'vitest';

import { call, createTeams, joinedPlayer, listDocs, newTrip, ok, readDoc, refused, signUp } from './helpers';

// HTTP-level createTeams and updateTeam.
describe('teams over HTTP', { timeout: 120_000 }, () => {
  it('rejects calls with no sign-in token', async () => {
    expect((await call(null, 'createTeams', { tournamentId: 'T', teams: [{ name: 'A' }] })).http).toBe(401);
    expect((await call(null, 'updateTeam', { tournamentId: 'T', teamId: 'x', name: 'B' })).http).toBe(401);
  });

  it('lets the organizer create teams (one with a color) that members can read', async () => {
    const trip = await newTrip();
    const member = await joinedPlayer(trip);
    const ids = await createTeams(trip, ['Red', 'Blue']);
    await ok(trip.organizer, 'updateTeam', { tournamentId: trip.tournamentId, teamId: ids.Red, color: '#cc0000' });

    const teams = await listDocs(member, `tournaments/${trip.tournamentId}/teams`);
    expect(teams.docs.map((t) => t.data.name).sort()).toEqual(['Blue', 'Red']);
    expect(teams.docs.find((t) => t.data.name === 'Red')?.data.color).toBe('#CC0000');
    expect(teams.docs.find((t) => t.data.name === 'Blue')?.data.color).toBeNull();
  });

  it('refuses team changes from a player, a stranger and anonymous, and creates nothing', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const stranger = await signUp('stranger');
    const body = { tournamentId: trip.tournamentId, teams: [{ name: 'Sneaky' }] };

    await refused(player, 'createTeams', body, 'PERMISSION_DENIED');
    await refused(stranger, 'createTeams', body, 'PERMISSION_DENIED');
    expect((await call(null, 'createTeams', body)).http).toBe(401);

    const ids = await createTeams(trip, ['Real']);
    await refused(player, 'updateTeam', { tournamentId: trip.tournamentId, teamId: ids.Real, name: 'Hacked' }, 'PERMISSION_DENIED');
    const teams = await listDocs(trip.organizer, `tournaments/${trip.tournamentId}/teams`);
    expect(teams.docs.map((t) => t.data.name)).toEqual(['Real']);
  });

  it('rejects duplicate names (any case), all or nothing, and bad input', async () => {
    const trip = await newTrip();
    const org = trip.organizer;
    const tid = trip.tournamentId;
    await createTeams(trip, ['Red']);

    await refused(org, 'createTeams', { tournamentId: tid, teams: [{ name: 'RED' }, { name: 'Gold' }] }, 'ALREADY_EXISTS');
    expect((await listDocs(org, `tournaments/${tid}/teams`)).docs).toHaveLength(1); // Gold was not created either
    await refused(org, 'createTeams', { tournamentId: tid, teams: [{ name: 'Same' }, { name: 'same' }] }, 'INVALID_ARGUMENT');
    await refused(org, 'createTeams', { tournamentId: tid, teams: [] }, 'INVALID_ARGUMENT');
    await refused(org, 'createTeams', { tournamentId: tid, teams: [{ name: '  ' }] }, 'INVALID_ARGUMENT');
    await refused(org, 'createTeams', { tournamentId: tid, teams: [{ name: 'Teal', color: 'teal' }] }, 'INVALID_ARGUMENT');
    await refused(org, 'createTeams', { tournamentId: 'nope', teams: [{ name: 'A' }] }, 'NOT_FOUND');
  });

  it('renames a team, refusing a clash or an unknown team', async () => {
    const trip = await newTrip();
    const org = trip.organizer;
    const tid = trip.tournamentId;
    const ids = await createTeams(trip, ['Red', 'Blue']);

    const renamed = await ok(org, 'updateTeam', { tournamentId: tid, teamId: ids.Red, name: 'Crimson' });
    expect(renamed.name).toBe('Crimson');
    expect((await readDoc(org, `tournaments/${tid}/teams/${ids.Red}`)).data?.name).toBe('Crimson');

    await refused(org, 'updateTeam', { tournamentId: tid, teamId: ids.Red, name: 'blue' }, 'ALREADY_EXISTS');
    await refused(org, 'updateTeam', { tournamentId: tid, teamId: 'missing', name: 'X' }, 'NOT_FOUND');
    await refused(org, 'updateTeam', { tournamentId: tid, teamId: ids.Red }, 'INVALID_ARGUMENT');
  });

  it('allows 100 teams and refuses the 101st', async () => {
    const trip = await newTrip();
    const names = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ name: `Team ${from + i}` }));

    await ok(trip.organizer, 'createTeams', { tournamentId: trip.tournamentId, teams: names(0, 100) });
    await refused(trip.organizer, 'createTeams', { tournamentId: trip.tournamentId, teams: [{ name: 'One too many' }] }, 'RESOURCE_EXHAUSTED');
    await refused(trip.organizer, 'createTeams', { tournamentId: trip.tournamentId, teams: names(200, 301) }, 'INVALID_ARGUMENT');
    expect((await listDocs(trip.organizer, `tournaments/${trip.tournamentId}/teams?pageSize=300`)).docs).toHaveLength(100);
  });
});
