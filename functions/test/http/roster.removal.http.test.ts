import { describe, expect, it } from 'vitest';

import { call, joinedPlayer, listDocs, myRosterEntries, newTrip, ok, queryCollection, readDoc, refused, signUp } from './helpers';

// HTTP-level removePlayer: what a removed or withdrawn person can and cannot do afterwards.
describe('removePlayer over HTTP', { timeout: 60_000 }, () => {
  it('rejects a call with no sign-in token', async () => {
    const res = await call(null, 'removePlayer', { tournamentId: 'T', playerId: 'p' });
    expect(res.http).toBe(401);
    expect(res.error?.status).toBe('UNAUTHENTICATED');
  });

  it('before the start takes the person off the roster, they lose access, and they can rejoin with the code', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const player = await joinedPlayer(trip);
    const base = `tournaments/${tid}`;
    expect((await readDoc(player, base)).http).toBe(200);

    expect(await ok(trip.organizer, 'removePlayer', { tournamentId: tid, playerId: player.uid })).toEqual({
      tournamentId: tid,
      playerId: player.uid,
      withdrawn: false,
    });
    expect((await readDoc(player, base)).http).toBe(403);
    expect((await readDoc(player, `${base}/private/settings`)).http).toBe(403);
    expect((await myRosterEntries(player, player.uid)).paths).toEqual([]);
    expect((await listDocs(trip.organizer, `${base}/players`)).docs.map((d) => d.id)).toEqual([trip.organizer.uid]);

    const feed = await queryCollection(trip.organizer, base, 'activity', [], 'at');
    expect(feed.docs.map((d) => d.data.type)).toContain('player_removed');

    expect((await ok(player, 'joinTournament', { inviteCode: trip.inviteCode })).alreadyMember).toBe(false);
    expect((await readDoc(player, base)).http).toBe(200);
  });

  it('after the start keeps the record, withdraws the player, and tells every member', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const player = await joinedPlayer(trip, 'leaver');
    const other = await joinedPlayer(trip, 'other');
    await ok(trip.organizer, 'startTournament', { tournamentId: tid });

    expect((await ok(trip.organizer, 'removePlayer', { tournamentId: tid, playerId: player.uid })).withdrawn).toBe(true);
    const entry = (await readDoc(other, `tournaments/${tid}/players/${player.uid}`)).data;
    expect(entry).toMatchObject({ withdrawn: true });

    await refused(player, 'chooseTeam', { tournamentId: tid, teamId: null }, 'PERMISSION_DENIED');
    await refused(player, 'setMyHandicap', { tournamentId: tid, handicap: 5 }, 'PERMISSION_DENIED');

    const announced = await queryCollection(other, `tournaments/${tid}`, 'activity', [['level', 'all']], 'at');
    expect(announced.docs.some((d) => d.data.type === 'player_removed' && d.data.targetPlayerId === player.uid)).toBe(true);
  });

  it('refuses a player, a stranger, removing the organizer and removing yourself', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const a = await joinedPlayer(trip, 'a');
    const b = await joinedPlayer(trip, 'b');
    const stranger = await signUp('stranger');

    await refused(a, 'removePlayer', { tournamentId: tid, playerId: b.uid }, 'PERMISSION_DENIED');
    await refused(stranger, 'removePlayer', { tournamentId: tid, playerId: b.uid }, 'PERMISSION_DENIED');
    await refused(trip.organizer, 'removePlayer', { tournamentId: tid, playerId: trip.organizer.uid }, 'INVALID_ARGUMENT');
    await ok(trip.organizer, 'assignCoAdmin', { tournamentId: tid, playerId: a.uid });
    await refused(a, 'removePlayer', { tournamentId: tid, playerId: a.uid }, 'INVALID_ARGUMENT');
    await refused(a, 'removePlayer', { tournamentId: tid, playerId: trip.organizer.uid }, 'INVALID_ARGUMENT');
    await refused(trip.organizer, 'removePlayer', { tournamentId: tid, playerId: 'nobody' }, 'NOT_FOUND');
    expect((await listDocs(trip.organizer, `tournaments/${tid}/players`)).docs).toHaveLength(3);
  });

  it('clears the co-admin role when the co-admin is removed', async () => {
    const trip = await newTrip();
    const tid = trip.tournamentId;
    const co = await joinedPlayer(trip, 'co');
    await ok(trip.organizer, 'assignCoAdmin', { tournamentId: tid, playerId: co.uid });
    await ok(trip.organizer, 'removePlayer', { tournamentId: tid, playerId: co.uid });

    expect((await readDoc(trip.organizer, `tournaments/${tid}`)).data?.coAdminId).toBeNull();
    await refused(co, 'updateTournament', { tournamentId: tid, name: 'Still an admin' }, 'PERMISSION_DENIED');
  });
});
