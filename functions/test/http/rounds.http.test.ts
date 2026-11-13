import { describe, expect, it } from 'vitest';

import { joinedPlayer, listDocs, newTrip, ok, queryCollection, readDoc, refused, signUp, writeDoc } from './helpers';

// Rounds over HTTP with real sign-in tokens: what the app does, read back through the security rules.

const holes = Array.from({ length: 18 }, (_, i) => ({ par: i % 5 === 0 ? 5 : 4, strokeIndex: i + 1, yards: 300 + i * 10 }));
const course = { name: 'Spyglass Hill', tees: 'White', rating: 72.1, slope: 133, holes };

describe('createRound and updateRound', { timeout: 60_000 }, () => {
  it('an organizer creates a round that members can read, with the course stored', async () => {
    const trip = await newTrip({ startDate: '2026-11-13', endDate: '2026-11-15' });
    const member = await joinedPlayer(trip, 'member');
    const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14', course });

    expect(round).toMatchObject({ number: 1, status: 'scheduled', holesPlanned: 18, courseSource: 'manual' });
    const path = `tournaments/${trip.tournamentId}/rounds/${round.id}`;
    const read = await readDoc(member, path);
    expect(read.http).toBe(200);
    expect(read.data).toMatchObject({ number: 1, date: '2026-11-14', maxGroupSize: 4 });
    expect(read.data?.course.name).toBe('Spyglass Hill');
    expect(read.data?.course.holes).toHaveLength(18);
    expect((await listDocs(member, `tournaments/${trip.tournamentId}/rounds`)).docs).toHaveLength(1);
  });

  it('a player cannot create or change a round, and a stranger cannot even read one', async () => {
    const trip = await newTrip();
    const member = await joinedPlayer(trip, 'member');
    const stranger = await signUp('stranger');
    const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14' });

    await refused(member, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14' }, 'PERMISSION_DENIED');
    await refused(member, 'updateRound', { tournamentId: trip.tournamentId, roundId: round.id, maxGroupSize: 2 }, 'PERMISSION_DENIED');
    const path = `tournaments/${trip.tournamentId}/rounds/${round.id}`;
    expect((await readDoc(stranger, path)).http).toBe(403);
    expect((await readDoc(null, path)).http).toBe(403);
  });

  it('spectators of a public tournament can read a round', async () => {
    const trip = await newTrip({ visibility: 'public' });
    const stranger = await signUp('spectator');
    const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14' });
    expect((await readDoc(stranger, `tournaments/${trip.tournamentId}/rounds/${round.id}`)).http).toBe(200);
  });

  it('refuses a direct client write to a round, even by the organizer', async () => {
    const trip = await newTrip();
    const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14' });
    expect(await writeDoc(trip.organizer, `tournaments/${trip.tournamentId}/rounds/${round.id}`)).toBe(403);
  });

  it('updates settings, and refuses bad input with a clear status', async () => {
    const trip = await newTrip();
    const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14' });
    const updated = await ok(trip.organizer, 'updateRound', {
      tournamentId: trip.tournamentId,
      roundId: round.id,
      scoring: { handicapMode: 'gross', maxScore: { mode: 'fixed', value: 8 } },
      skins: { enabled: true, mode: 'potSplit', value: 20 },
    });
    expect(updated.scoring).toMatchObject({ handicapMode: 'gross', maxScore: { mode: 'fixed', value: 8 } });
    expect(updated.skins).toMatchObject({ enabled: true, mode: 'potSplit', value: 20 });

    const base = { tournamentId: trip.tournamentId, roundId: round.id };
    await refused(trip.organizer, 'updateRound', { ...base, holesPlanned: 12 }, 'INVALID_ARGUMENT');
    await refused(trip.organizer, 'updateRound', { ...base, status: 'finalized' }, 'INVALID_ARGUMENT');
    await refused(trip.organizer, 'updateRound', { ...base }, 'INVALID_ARGUMENT');
    await refused(trip.organizer, 'updateRound', { ...base, roundId: 'nope', maxGroupSize: 2 }, 'NOT_FOUND');
    await refused(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: 'tomorrow' }, 'INVALID_ARGUMENT');
  });

  it('asks before widening the tournament dates, and the feed shows the round to members after Start', async () => {
    const trip = await newTrip({ startDate: '2026-11-13', endDate: '2026-11-15' });
    const member = await joinedPlayer(trip, 'member');
    const input = { tournamentId: trip.tournamentId, date: '2026-11-18' };
    await refused(trip.organizer, 'createRound', input, 'FAILED_PRECONDITION');
    await ok(trip.organizer, 'createRound', { ...input, extendTournamentDates: true });
    expect((await readDoc(member, `tournaments/${trip.tournamentId}`)).data?.endDate).toBe('2026-11-18');

    await ok(trip.organizer, 'startTournament', { tournamentId: trip.tournamentId });
    await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14' });
    const feed = await queryCollection(member, `tournaments/${trip.tournamentId}`, 'activity', [['level', 'all']]);
    const created = feed.docs.filter((d) => d.data.type === 'round_created');
    expect(created).toHaveLength(1); // only the one added after Start is shown to members
    expect(created[0].data).toMatchObject({ category: 'changes', level: 'all' });
  });

  it('sets tournament defaults that new rounds inherit', async () => {
    const trip = await newTrip();
    await ok(trip.organizer, 'updateTournament', { tournamentId: trip.tournamentId, defaultHolesPlanned: 9, defaultMaxGroupSize: 3 });
    const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14' });
    expect(round).toMatchObject({ holesPlanned: 9, maxGroupSize: 3 });
    await refused(trip.organizer, 'updateTournament', { tournamentId: trip.tournamentId, defaultHolesPlanned: 12 }, 'INVALID_ARGUMENT');
    await refused(trip.organizer, 'updateTournament', { tournamentId: trip.tournamentId, defaultMaxGroupSize: 20 }, 'INVALID_ARGUMENT');
  });

  it('keeps unopened round data closed, and opens scores and submissions only to the right people', async () => {
    const trip = await newTrip({ visibility: 'public' });
    const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14' });
    const base = `tournaments/${trip.tournamentId}/rounds/${round.id}`;
    for (const sub of ['disputes', 'cards']) {
      expect((await listDocs(trip.organizer, `${base}/${sub}`)).http, sub).toBe(403);
    }
    // Scores and the submission inbox are open now, to the people who should see them (see submissions.http.test.ts).
    expect((await listDocs(trip.organizer, `${base}/scores`)).http).toBe(200);
    expect((await listDocs(trip.organizer, `${base}/submissions`)).http).toBe(200);
    // A spectator of this public tournament sees neither the raw scores nor anyone's submissions.
    const spectator = await signUp('spectator');
    expect((await listDocs(spectator, `${base}/scores`)).http).toBe(403);
    expect((await listDocs(spectator, `${base}/submissions`)).http).toBe(403);
  });
});
