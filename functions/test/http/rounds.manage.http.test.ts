import { describe, expect, it } from 'vitest';

import { joinedPlayer, listDocs, newTrip, ok, readDoc, refused } from './helpers';

// Round names, deleteRound and the date rule over HTTP with real sign-in tokens.

describe('round names, deleteRound and tournament dates', { timeout: 60_000 }, () => {
  it('an organizer names a round and members read the name', async () => {
    const trip = await newTrip({ startDate: '2026-11-13', endDate: '2026-11-15' });
    const member = await joinedPlayer(trip, 'member');
    const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14', name: 'Friday AM' });
    expect(round.name).toBe('Friday AM');
    const read = await readDoc(member, `tournaments/${trip.tournamentId}/rounds/${round.id}`);
    expect(read.data).toMatchObject({ name: 'Friday AM', number: 1 });
    await refused(trip.organizer, 'updateRound', { tournamentId: trip.tournamentId, roundId: round.id, name: 'x'.repeat(41) }, 'INVALID_ARGUMENT');
  });

  it('deleteRound: an organizer removes a round, a player and an anonymous caller cannot', async () => {
    const trip = await newTrip({ startDate: '2026-11-13', endDate: '2026-11-15' });
    const member = await joinedPlayer(trip, 'member');
    const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14' });
    const args = { tournamentId: trip.tournamentId, roundId: round.id };

    await refused(member, 'deleteRound', args, 'PERMISSION_DENIED');
    await refused(null, 'deleteRound', args, 'UNAUTHENTICATED');
    expect((await listDocs(member, `tournaments/${trip.tournamentId}/rounds`)).docs).toHaveLength(1);

    expect(await ok(trip.organizer, 'deleteRound', args)).toEqual({ roundId: round.id, deleted: true });
    expect((await listDocs(member, `tournaments/${trip.tournamentId}/rounds`)).docs).toHaveLength(0);
    await refused(trip.organizer, 'deleteRound', args, 'NOT_FOUND');
  });

  it('tournament dates cannot be narrowed past a round until that round is deleted', async () => {
    const trip = await newTrip({ startDate: '2026-11-13', endDate: '2026-11-15' });
    const round = await ok(trip.organizer, 'createRound', {
      tournamentId: trip.tournamentId,
      date: '2026-11-25',
      extendTournamentDates: true,
    });
    const message = await refused(
      trip.organizer,
      'updateTournament',
      { tournamentId: trip.tournamentId, endDate: '2026-11-15' },
      'FAILED_PRECONDITION',
    );
    expect(message).toContain('Round 1');
    await ok(trip.organizer, 'deleteRound', { tournamentId: trip.tournamentId, roundId: round.id });
    const updated = await ok(trip.organizer, 'updateTournament', { tournamentId: trip.tournamentId, endDate: '2026-11-15' });
    expect(updated.endDate).toBe('2026-11-15');
  });
});
