import { describe, expect, it } from 'vitest';

import { joinedPlayer, newTrip, ok, readDoc } from './helpers';

// Removing a player takes them out of the groups, over HTTP with real tokens, read back through the rules.

describe('removePlayer and groups', { timeout: 60_000 }, () => {
  it('a removed player leaves the group, and the organizer can still edit a tee time afterwards', async () => {
    const trip = await newTrip({ startDate: '2026-11-13', endDate: '2026-11-15' });
    const a = await joinedPlayer(trip, 'a');
    const b = await joinedPlayer(trip, 'b');
    const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14' });
    const set = await ok(trip.organizer, 'setGroups', {
      tournamentId: trip.tournamentId,
      roundId: round.id,
      groups: [{ playerIds: [a.uid, b.uid] }],
    });
    const groupPath = `tournaments/${trip.tournamentId}/rounds/${round.id}/groups/${set.groups[0].id}`;

    await ok(trip.organizer, 'removePlayer', { tournamentId: trip.tournamentId, playerId: b.uid });
    const read = await readDoc(a, groupPath);
    expect(read.http).toBe(200);
    expect(read.data?.playerIds).toEqual([a.uid]);

    const edited = await ok(trip.organizer, 'setGroups', {
      tournamentId: trip.tournamentId,
      roundId: round.id,
      groups: [{ id: set.groups[0].id, playerIds: [a.uid], teeTime: '2026-11-14T13:00:00Z' }],
    });
    expect(edited.groups[0].teeTime).toBe('2026-11-14T13:00:00.000Z');
  });
});
