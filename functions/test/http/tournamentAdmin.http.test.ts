import { describe, expect, it } from 'vitest';

import { call, createTeams, joinedPlayer, newTrip, ok, readDoc, refused, signUp } from './helpers';

// HTTP-level tournament editing and the co-admin role.
describe('tournament admin over HTTP', { timeout: 60_000 }, () => {
  it('rejects calls with no sign-in token', async () => {
    expect((await call(null, 'updateTournament', { tournamentId: 'T', name: 'x' })).http).toBe(401);
    expect((await call(null, 'assignCoAdmin', { tournamentId: 'T', playerId: null })).http).toBe(401);
  });

  it('lets the organizer edit the details, and members see the change', async () => {
    const trip = await newTrip();
    const member = await joinedPlayer(trip);
    const tid = trip.tournamentId;

    const updated = await ok(trip.organizer, 'updateTournament', {
      tournamentId: tid,
      name: 'Renamed Cup',
      startDate: '2026-12-01',
      endDate: '2026-12-03',
      wagerPotAmount: 250.456,
    });
    expect(updated).toMatchObject({ name: 'Renamed Cup', wagerPotAmount: 250.46, started: false });
    expect((await readDoc(member, `tournaments/${tid}`)).data).toMatchObject({
      name: 'Renamed Cup',
      startDate: '2026-12-01',
      endDate: '2026-12-03',
      wagerPotAmount: 250.46,
    });
    await ok(trip.organizer, 'updateTournament', { tournamentId: tid, startDate: null, endDate: null });
    expect((await readDoc(member, `tournaments/${tid}`)).data).toMatchObject({ startDate: null, endDate: null });
  });

  it('refuses edits from a player, a stranger and anonymous, and changes nothing', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const stranger = await signUp('stranger');
    const body = { tournamentId: trip.tournamentId, name: 'Hijacked' };

    await refused(player, 'updateTournament', body, 'PERMISSION_DENIED');
    await refused(stranger, 'updateTournament', body, 'PERMISSION_DENIED');
    expect((await call(null, 'updateTournament', body)).http).toBe(401);
    expect((await readDoc(trip.organizer, `tournaments/${trip.tournamentId}`)).data?.name).toBe('HTTP Cup');
  });

  it('rejects bad input: unknown fields, nothing to change, bad dates, bad pot, bad name', async () => {
    const trip = await newTrip();
    const org = trip.organizer;
    const tid = trip.tournamentId;

    await refused(org, 'updateTournament', { tournamentId: tid, organizerId: org.uid }, 'INVALID_ARGUMENT');
    await refused(org, 'updateTournament', { tournamentId: tid, status: 'suspended' }, 'INVALID_ARGUMENT');
    await refused(org, 'updateTournament', { tournamentId: tid }, 'INVALID_ARGUMENT');
    await refused(org, 'updateTournament', { tournamentId: tid, startDate: '2026-02-30' }, 'INVALID_ARGUMENT');
    await refused(org, 'updateTournament', { tournamentId: tid, startDate: '2026-12-05', endDate: '2026-12-01' }, 'INVALID_ARGUMENT');
    await refused(org, 'updateTournament', { tournamentId: tid, wagerPotAmount: -1 }, 'INVALID_ARGUMENT');
    await refused(org, 'updateTournament', { tournamentId: tid, wagerPotAmount: 100001 }, 'INVALID_ARGUMENT');
    await refused(org, 'updateTournament', { tournamentId: tid, name: '' }, 'INVALID_ARGUMENT');
    await refused(org, 'updateTournament', { tournamentId: tid, started: 'yes' }, 'INVALID_ARGUMENT');
    await refused(org, 'updateTournament', { tournamentId: 'nope', name: 'x' }, 'NOT_FOUND');
    expect((await readDoc(org, `tournaments/${tid}`)).data?.name).toBe('HTTP Cup');
  });

  it('applies a date change against the stored other date', async () => {
    const trip = await newTrip({ startDate: '2026-12-01', endDate: '2026-12-03' });
    await refused(trip.organizer, 'updateTournament', { tournamentId: trip.tournamentId, startDate: '2026-12-09' }, 'INVALID_ARGUMENT');
    await ok(trip.organizer, 'updateTournament', { tournamentId: trip.tournamentId, startDate: '2026-12-02' });
  });

  it('flips visibility, and a stranger\'s view follows, never reaching the invite code', async () => {
    const trip = await newTrip();
    const stranger = await signUp('viewer');
    const base = `tournaments/${trip.tournamentId}`;
    expect((await readDoc(stranger, base)).http).toBe(403);

    await ok(trip.organizer, 'updateTournament', { tournamentId: trip.tournamentId, visibility: 'public' });
    expect((await readDoc(stranger, base)).http).toBe(200);
    expect((await readDoc(stranger, `${base}/private/settings`)).http).toBe(403);

    await ok(trip.organizer, 'updateTournament', { tournamentId: trip.tournamentId, visibility: 'private' });
    expect((await readDoc(stranger, base)).http).toBe(403);
    await refused(trip.organizer, 'updateTournament', { tournamentId: trip.tournamentId, visibility: 'friends' }, 'INVALID_ARGUMENT');
  });

  it('starts and reopens through updateTournament', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    expect((await ok(trip.organizer, 'updateTournament', { tournamentId: tid, started: true })).started).toBe(true);
    expect((await readDoc(trip.organizer, `tournaments/${tid}`)).data?.startedAt).toBeTruthy();
    expect((await ok(trip.organizer, 'updateTournament', { tournamentId: tid, started: false })).started).toBe(false);
    expect((await readDoc(trip.organizer, `tournaments/${tid}`)).data?.startedAt).toBeNull();
  });
});

describe('co-admin over HTTP', { timeout: 60_000 }, () => {
  it('gives the co-admin the organizer\'s powers, and taking it away removes them', async () => {
    const trip = await newTrip();
    const co = await joinedPlayer(trip, 'coadmin');
    const tid = trip.tournamentId;

    await refused(co, 'updateTournament', { tournamentId: tid, name: 'Before' }, 'PERMISSION_DENIED');
    expect(await ok(trip.organizer, 'assignCoAdmin', { tournamentId: tid, playerId: co.uid })).toEqual({
      tournamentId: tid,
      coAdminId: co.uid,
    });

    await ok(co, 'updateTournament', { tournamentId: tid, name: 'By Co-Admin' });
    await createTeams({ ...trip, organizer: co }, ['Co Team']);
    await ok(co, 'startTournament', { tournamentId: tid });
    expect((await readDoc(co, `tournaments/${tid}/private/settings`)).http).toBe(200);
    expect((await readDoc(co, `tournaments/${tid}`)).data?.coAdminId).toBe(co.uid);

    expect(await ok(trip.organizer, 'assignCoAdmin', { tournamentId: tid, playerId: null })).toEqual({ tournamentId: tid, coAdminId: null });
    await refused(co, 'updateTournament', { tournamentId: tid, name: 'After' }, 'PERMISSION_DENIED');
    await refused(co, 'startTournament', { tournamentId: tid }, 'PERMISSION_DENIED');
    expect((await readDoc(trip.organizer, `tournaments/${tid}`)).data?.name).toBe('By Co-Admin');
  });

  it('lets the co-admin assign a successor, but not a player or stranger assign anyone', async () => {
    const trip = await newTrip();
    const co = await joinedPlayer(trip, 'co');
    const other = await joinedPlayer(trip, 'other');
    const stranger = await signUp('stranger');
    const tid = trip.tournamentId;
    await ok(trip.organizer, 'assignCoAdmin', { tournamentId: tid, playerId: co.uid });

    await refused(other, 'assignCoAdmin', { tournamentId: tid, playerId: other.uid }, 'PERMISSION_DENIED');
    await refused(stranger, 'assignCoAdmin', { tournamentId: tid, playerId: stranger.uid }, 'PERMISSION_DENIED');
    expect((await ok(co, 'assignCoAdmin', { tournamentId: tid, playerId: other.uid })).coAdminId).toBe(other.uid);
    await refused(co, 'updateTournament', { tournamentId: tid, name: 'Demoted' }, 'PERMISSION_DENIED'); // replaced
    await ok(other, 'updateTournament', { tournamentId: tid, name: 'New Co-Admin' });
  });

  it('requires the co-admin to be on the roster and not be the organizer', async () => {
    const trip = await newTrip();
    const stranger = await signUp('not-joined');
    const tid = trip.tournamentId;

    await refused(trip.organizer, 'assignCoAdmin', { tournamentId: tid, playerId: stranger.uid }, 'NOT_FOUND');
    await refused(trip.organizer, 'assignCoAdmin', { tournamentId: tid, playerId: trip.organizer.uid }, 'INVALID_ARGUMENT');
    await refused(trip.organizer, 'assignCoAdmin', { tournamentId: tid }, 'INVALID_ARGUMENT');
    await refused(trip.organizer, 'assignCoAdmin', { tournamentId: 'nope', playerId: null }, 'NOT_FOUND');
    expect((await readDoc(trip.organizer, `tournaments/${tid}`)).data?.coAdminId).toBeNull();
  });
});
