import { describe, expect, it } from 'vitest';

import { joinedPlayer, listDocs, myRosterEntries, newTrip, ok, readDoc, refused, signUp } from './helpers';

// Tee sets on a round's course, and per-player tee picks and check-in, over HTTP with real sign-in tokens.

const course = () => ({
  name: 'Four Bridges',
  holes: Array.from({ length: 18 }, (_, i) => ({ par: 4, strokeIndex: i + 1, strokeIndexWomen: ((i * 7) % 18) + 1 })),
  tees: [
    { id: 'black', name: 'Black', yards: Array(18).fill(400), men: { rating: 73.1, slope: 135 } },
    { id: 'blue', name: 'Blue', yards: Array(18).fill(370), men: { rating: 71.2, slope: 128 }, women: { rating: 76.4, slope: 130 } },
  ],
});

async function tripWithRound(visibility?: string) {
  const trip = await newTrip(visibility ? { visibility } : {});
  const ann = await joinedPlayer(trip, 'ann');
  const bob = await joinedPlayer(trip, 'bob');
  const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14', course: course() });
  return { trip, ann, bob, round, base: { tournamentId: trip.tournamentId, roundId: round.id } };
}

describe('setRoundPlayers', { timeout: 60_000 }, () => {
  it('a round created with tee sets reports its default tee, and members read the course tees', async () => {
    const { trip, ann, round } = await tripWithRound();
    expect(round.defaultTeeId).toBe('black');
    const doc = await readDoc(ann, `tournaments/${trip.tournamentId}/rounds/${round.id}`);
    expect(doc.http).toBe(200);
    expect(doc.data!.course.tees.map((t: any) => t.name)).toEqual(['Black', 'Blue']);
  });

  it('a player picks a tee and checks in; members read everyone, a stranger and a spectator do not', async () => {
    const { trip, ann, bob, base } = await tripWithRound('public');
    const stranger = await signUp('stranger');
    await ok(ann, 'setRoundPlayers', { ...base, players: [{ teeId: 'blue', table: 'women' }] });
    const result = await ok(ann, 'setRoundPlayers', { ...base, players: [{ checkedIn: true }] });
    expect(result.players).toEqual([{ playerId: ann.uid, teeId: 'blue', table: 'women', checkedIn: true }]);

    const path = `tournaments/${trip.tournamentId}/rounds/${base.roundId}/roundPlayers`;
    const asBob = await listDocs(bob, path);
    expect(asBob.http).toBe(200);
    expect(asBob.docs.map((d) => [d.id, d.data.teeId, d.data.checkedIn])).toEqual([[ann.uid, 'blue', true]]);
    expect((await listDocs(trip.organizer, path)).docs).toHaveLength(1);
    // The tournament is public, so a stranger can see the round and its course but not who is checked in.
    expect((await readDoc(stranger, `tournaments/${trip.tournamentId}/rounds/${base.roundId}`)).http).toBe(200);
    expect((await listDocs(stranger, path)).http).toBe(403);
    expect((await listDocs(null, path)).http).toBe(403);
  });

  it('the "my tournaments" roster query is not polluted by round tee picks', async () => {
    const { trip, ann, base } = await tripWithRound();
    await ok(ann, 'setRoundPlayers', { ...base, players: [{ teeId: 'blue', table: 'men' }] });
    const mine = await myRosterEntries(ann, ann.uid);
    expect(mine.http).toBe(200);
    expect(mine.paths).toHaveLength(1);
    expect(mine.paths[0]).toContain(`tournaments/${trip.tournamentId}/players/`);
  });

  it('an organizer pre-sets everyone without checking anyone in; a player cannot set someone else', async () => {
    const { trip, ann, bob, base } = await tripWithRound();
    await refused(ann, 'setRoundPlayers', { ...base, players: [{ playerId: bob.uid, teeId: 'blue' }] }, 'PERMISSION_DENIED');
    const result = await ok(trip.organizer, 'setRoundPlayers', {
      ...base,
      players: [
        { playerId: ann.uid, teeId: 'black', table: 'men' },
        { playerId: bob.uid, teeId: 'blue', table: 'women' },
      ],
    });
    expect(result.players.map((p: any) => p.checkedIn)).toEqual([false, false]);
    const listed = await listDocs(ann, `tournaments/${trip.tournamentId}/rounds/${base.roundId}/roundPlayers`);
    expect(listed.docs.map((d) => [d.data.teeId, d.data.checkedIn]).sort()).toEqual([
      ['black', false],
      ['blue', false],
    ]);
  });

  it('refuses bad input: unknown tee, a table the tee has no rating for, missing table at check-in', async () => {
    const { ann, base } = await tripWithRound();
    await refused(ann, 'setRoundPlayers', { ...base, players: [{ teeId: 'purple' }] }, 'INVALID_ARGUMENT');
    await refused(ann, 'setRoundPlayers', { ...base, players: [{ teeId: 'black', table: 'women' }] }, 'INVALID_ARGUMENT');
    await refused(ann, 'setRoundPlayers', { ...base, players: [{ checkedIn: true }] }, 'INVALID_ARGUMENT');
    await refused(ann, 'setRoundPlayers', { ...base, players: [] }, 'INVALID_ARGUMENT');
  });
});
