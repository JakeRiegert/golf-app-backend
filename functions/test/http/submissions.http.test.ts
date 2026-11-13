import { describe, expect, it } from 'vitest';

import { createDoc, joinedPlayer, newTrip, ok, queryCollection, readDoc, refused, signUp, waitForDoc } from './helpers';

// The score inbox end to end: a signed-in player writes a submission straight to Firestore under the real
// security rules (what the phone does), the trigger function checks it, and the official score appears.

const holes = Array.from({ length: 18 }, (_, i) => ({ par: 4, strokeIndex: i + 1 }));

async function setupRound() {
  const trip = await newTrip({ startDate: '2026-11-13', endDate: '2026-11-15' });
  const a = await joinedPlayer(trip, 'a');
  const b = await joinedPlayer(trip, 'b');
  const c = await joinedPlayer(trip, 'c');
  const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14', course: { name: 'C', holes } });
  const set = await ok(trip.organizer, 'setGroups', {
    tournamentId: trip.tournamentId,
    roundId: round.id,
    groups: [{ playerIds: [a.uid, b.uid] }, { playerIds: [c.uid] }],
  });
  const base = `tournaments/${trip.tournamentId}/rounds/${round.id}`;
  return { trip, a, b, c, round, g1: set.groups[0].id as string, g2: set.groups[1].id as string, base };
}

const TIME = Date.now() - 30_000;
const sub = (playerId: string, hole: number, strokes: number, groupId: string, enteredBy: string, clientTime = TIME) => ({
  id: `${playerId}_${hole}_${clientTime}`,
  data: { playerId, hole, strokes, kind: 'played', groupId, enteredBy, clientTime },
});

describe('score submissions', { timeout: 90_000 }, () => {
  it('a player enters a score for a groupmate: it is checked, recorded, the round starts, and everyone can see it', async () => {
    const { trip, a, b, round, g1, base } = await setupRound();
    const s = sub(b.uid, 1, 5, g1, a.uid);
    expect(await createDoc(a, base, 'submissions', s.id, s.data)).toBe(200);

    // The trigger turns it into an official score.
    const score = await waitForDoc(b, `${base}/scores/${s.id}`);
    expect(score.http).toBe(200);
    expect(score.data).toMatchObject({ playerId: b.uid, hole: 1, strokes: 5, enteredBy: a.uid, status: 'accepted', groupId: g1 });

    // The author sees the outcome on their own submission.
    const mine = await waitForDoc(a, `${base}/submissions/${s.id}`, (d) => Boolean(d.outcome));
    expect(mine.data?.outcome).toBe('accepted');
    // The player the score is about is not the author, so cannot read it as a submission; they read the score.
    expect((await readDoc(b, `${base}/submissions/${s.id}`)).http).toBe(403);

    // The first score started the round and the tournament, and said so in the feed.
    const roundDoc = await readDoc(a, base);
    expect(roundDoc.data?.status).toBe('live');
    const feed = await queryCollection(a, `tournaments/${trip.tournamentId}`, 'activity', [['level', 'all']]);
    expect(feed.docs.map((d) => d.data.type)).toEqual(expect.arrayContaining(['round_started', 'tournament_started']));
    expect(round.id).toBeDefined();
  });

  it('a score for someone outside the writer\'s group is turned away with a reason the writer can read', async () => {
    const { a, c, g2, base } = await setupRound();
    const s = sub(c.uid, 1, 4, g2, a.uid); // a is not in c's group
    expect(await createDoc(a, base, 'submissions', s.id, s.data)).toBe(200);
    const mine = await waitForDoc(a, `${base}/submissions/${s.id}`, (d) => Boolean(d.outcome));
    expect(mine.data).toMatchObject({ outcome: 'rejected', reasonCode: 'notInGroup' });
    expect(typeof mine.data?.reason).toBe('string');
    expect((await readDoc(a, `${base}/scores/${s.id}`)).http).toBe(404); // no official score was written
  });

  it('more than the round allows on a hole is turned away', async () => {
    const { a, g1, base } = await setupRound();
    const s = sub(a.uid, 1, 9, g1, a.uid); // par 4: double par is 8
    expect(await createDoc(a, base, 'submissions', s.id, s.data)).toBe(200);
    const mine = await waitForDoc(a, `${base}/submissions/${s.id}`, (d) => Boolean(d.outcome));
    expect(mine.data).toMatchObject({ outcome: 'rejected', reasonCode: 'overMax' });
  });

  it('the security rules refuse a stranger, a forged author, outcome fields, and a spoofed id', async () => {
    const { trip, a, g1, base } = await setupRound();
    const stranger = await signUp('outsider'); // signed in, never joined
    const s = sub(a.uid, 1, 4, g1, a.uid);
    expect(await createDoc(stranger, base, 'submissions', s.id, s.data)).toBe(403);
    expect(await createDoc(null, base, 'submissions', s.id, s.data)).toBe(403);
    // Claiming to be someone else
    const forged = sub(a.uid, 2, 4, g1, trip.organizer.uid);
    expect(await createDoc(a, base, 'submissions', forged.id, forged.data)).toBe(403);
    // Setting a field only the function may write
    const withOutcome = sub(a.uid, 3, 4, g1, a.uid);
    expect(await createDoc(a, base, 'submissions', withOutcome.id, { ...withOutcome.data, outcome: 'accepted' })).toBe(403);
    // An id that does not match the content
    expect(await createDoc(a, base, 'submissions', 'whatever', s.data)).toBe(403);
    // Writing an official score directly
    expect(await createDoc(a, base, 'scores', 'mine', { playerId: a.uid, hole: 1, strokes: 1 })).toBe(403);
    // Nothing of that got through
    expect((await readDoc(a, `${base}/scores/${s.id}`)).http).toBe(404);
  });

  it('startRound: only an admin; a player is refused', async () => {
    const { trip, a, round } = await setupRound();
    await refused(a, 'startRound', { tournamentId: trip.tournamentId, roundId: round.id }, 'PERMISSION_DENIED');
    const started = await ok(trip.organizer, 'startRound', { tournamentId: trip.tournamentId, roundId: round.id });
    expect(started).toEqual({ roundId: round.id, alreadyLive: false });
  });

  it('the round cannot be deleted once a score has been submitted', async () => {
    const { trip, a, g1, round, base } = await setupRound();
    const s = sub(a.uid, 1, 4, g1, a.uid);
    await createDoc(a, base, 'submissions', s.id, s.data);
    await waitForDoc(a, `${base}/submissions/${s.id}`, (d) => Boolean(d.outcome));
    await refused(trip.organizer, 'deleteRound', { tournamentId: trip.tournamentId, roundId: round.id }, 'FAILED_PRECONDITION');
  });
});
