import { describe, expect, it } from 'vitest';

import { call, joinedPlayer, newTrip, ok, readDoc, refused, signUp } from './helpers';

// HTTP-level handicap rules and the Start lifecycle: players and admins edit before the start,
// only admins after, and Reopen hands control back.
describe('handicaps and Start over HTTP', { timeout: 60_000 }, () => {
  const entry = async (viewer: Parameters<typeof readDoc>[0], tid: string, uid: string) =>
    (await readDoc(viewer, `tournaments/${tid}/players/${uid}`)).data;

  it('rejects calls with no sign-in token', async () => {
    expect((await call(null, 'setMyHandicap', { tournamentId: 'T', handicap: 5 })).http).toBe(401);
    expect((await call(null, 'startTournament', { tournamentId: 'T' })).http).toBe(401);
  });

  it('lets a player set, round and clear their own handicap before the start', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const tid = trip.tournamentId;

    const set = await ok(player, 'setMyHandicap', { tournamentId: tid, handicap: 12.34 });
    expect(set).toMatchObject({ handicap: 12.3, handicapSetBy: 'player' });
    expect(await entry(player, tid, player.uid)).toMatchObject({ handicap: 12.3, handicapSetBy: 'player' });

    await ok(player, 'setMyHandicap', { tournamentId: tid, handicap: -2 });
    expect((await entry(player, tid, player.uid))?.handicap).toBe(-2);
    await ok(player, 'setMyHandicap', { tournamentId: tid, handicap: null });
    expect(await entry(player, tid, player.uid)).toMatchObject({ handicap: null, handicapSetBy: null });
  });

  it('rejects handicaps out of range or not numbers, for players and admins alike', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const tid = trip.tournamentId;

    for (const bad of [-11, 55, 'twelve', {}]) {
      await refused(player, 'setMyHandicap', { tournamentId: tid, handicap: bad }, 'INVALID_ARGUMENT');
      await refused(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid, handicap: bad }, 'INVALID_ARGUMENT');
    }
    await refused(player, 'setMyHandicap', { tournamentId: tid }, 'INVALID_ARGUMENT');
    await ok(player, 'setMyHandicap', { tournamentId: tid, handicap: 54 });
    await ok(player, 'setMyHandicap', { tournamentId: tid, handicap: -10 });
  });

  it('lets an admin set a handicap too, last write wins, and records who set it', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const tid = trip.tournamentId;

    await ok(player, 'setMyHandicap', { tournamentId: tid, handicap: 10 });
    await ok(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid, handicap: 13 });
    expect(await entry(player, tid, player.uid)).toMatchObject({ handicap: 13, handicapSetBy: 'admin' });
    await ok(player, 'setMyHandicap', { tournamentId: tid, handicap: 11 });
    expect(await entry(player, tid, player.uid)).toMatchObject({ handicap: 11, handicapSetBy: 'player' });
  });

  it('starts the tournament once; only an admin can; a repeat is harmless', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const stranger = await signUp('stranger');
    const tid = trip.tournamentId;

    await refused(player, 'startTournament', { tournamentId: tid }, 'PERMISSION_DENIED');
    await refused(stranger, 'startTournament', { tournamentId: tid }, 'PERMISSION_DENIED');
    expect((await readDoc(trip.organizer, `tournaments/${tid}`)).data?.startedAt).toBeNull();

    expect(await ok(trip.organizer, 'startTournament', { tournamentId: tid })).toEqual({ tournamentId: tid, alreadyStarted: false });
    const stamp = (await readDoc(trip.organizer, `tournaments/${tid}`)).data?.startedAt;
    expect(stamp).toBeTruthy();
    expect((await ok(trip.organizer, 'startTournament', { tournamentId: tid })).alreadyStarted).toBe(true);
    expect((await readDoc(trip.organizer, `tournaments/${tid}`)).data?.startedAt).toBe(stamp);
    await refused(trip.organizer, 'startTournament', { tournamentId: 'nope' }, 'NOT_FOUND');
    await refused(trip.organizer, 'startTournament', {}, 'INVALID_ARGUMENT');
  });

  it('locks a player\'s handicap after the start, keeps admins able to edit, and Reopen unlocks it', async () => {
    const trip = await newTrip();
    const player = await joinedPlayer(trip);
    const tid = trip.tournamentId;
    await ok(player, 'setMyHandicap', { tournamentId: tid, handicap: 12 });

    await ok(trip.organizer, 'startTournament', { tournamentId: tid });
    await refused(player, 'setMyHandicap', { tournamentId: tid, handicap: 3 }, 'PERMISSION_DENIED');
    expect((await entry(player, tid, player.uid))?.handicap).toBe(12);

    await ok(trip.organizer, 'assignTournamentPlayer', { tournamentId: tid, playerId: player.uid, handicap: 14 });
    expect((await entry(player, tid, player.uid))?.handicap).toBe(14);

    await ok(trip.organizer, 'updateTournament', { tournamentId: tid, started: false });
    await ok(player, 'setMyHandicap', { tournamentId: tid, handicap: 9 });
    expect((await entry(player, tid, player.uid))?.handicap).toBe(9);
  });

  it('refuses a stranger setting a handicap', async () => {
    const trip = await newTrip();
    const stranger = await signUp('stranger');
    await refused(stranger, 'setMyHandicap', { tournamentId: trip.tournamentId, handicap: 5 }, 'PERMISSION_DENIED');
  });
});
