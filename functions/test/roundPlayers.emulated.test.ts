import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setRoundPlayers } from '../src/roundPlayers';
import { joinTournament, removePlayer } from '../src/roster';
import { createRound, deleteRound, updateRound } from '../src/rounds';
import { startTournament } from '../src/lifecycle';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.
// Course tee sets, the round's default tee, and per-player tee picks and check-in (setRoundPlayers).

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-round-players' }, 'round-players-test'));
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection('tournaments'));
  await db.recursiveDelete(db.collection('inviteCodes'));
});

const u = () => new UsageTracker();

async function rejection(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (err) {
    return err as HttpsError;
  }
  throw new Error('expected the call to be rejected');
}

// A real-looking course: Black has only a men's rating, Blue has both, White has no ratings at all.
const course = () => ({
  name: 'Four Bridges',
  holes: Array.from({ length: 18 }, (_, i) => ({ par: 4, strokeIndex: i + 1, strokeIndexWomen: ((i * 7) % 18) + 1 })),
  tees: [
    { id: 'black', name: 'Black', yards: Array(18).fill(400), men: { rating: 73.1, slope: 135 } },
    { id: 'blue', name: 'Blue', yards: Array(18).fill(370), men: { rating: 71.2, slope: 128 }, women: { rating: 76.4, slope: 130 } },
    { id: 'white', name: 'White', yards: Array(18).fill(340) },
  ],
});

async function setup(withCourse = true) {
  const t = await createTournament(db, 'org1', { name: 'Tee Cup', startDate: '2026-11-20', endDate: '2026-11-24' }, u());
  for (const p of ['p1', 'p2', 'p3']) await joinTournament(db, p, { inviteCode: t.inviteCode }, u());
  const round = await createRound(
    db,
    'org1',
    { tournamentId: t.id, date: '2026-11-22', ...(withCourse ? { course: course() as never } : {}) },
    u(),
  );
  return { tid: t.id, rid: round.id };
}

const roundRef = (tid: string, rid: string) => db.collection('tournaments').doc(tid).collection('rounds').doc(rid);
const pickRef = (tid: string, rid: string, pid: string) => roundRef(tid, rid).collection('roundPlayers').doc(pid);
async function feedOf(tid: string, type: string) {
  const snap = await db.collection('tournaments').doc(tid).collection('activity').where('type', '==', type).get();
  return snap.docs.map((d) => d.data());
}
const call = (uid: string, tid: string, rid: string, players: unknown[]) =>
  setRoundPlayers(db, uid, { tournamentId: tid, roundId: rid, players: players as never }, u());

describe('the course and the default tee', () => {
  it('a round with tee sets defaults to the first tee; an explicit one must exist', async () => {
    const { tid, rid } = await setup();
    expect((await roundRef(tid, rid).get()).data()!.defaultTeeId).toBe('black');
    const view = await updateRound(db, 'org1', { tournamentId: tid, roundId: rid, defaultTeeId: 'blue' }, u());
    expect(view.defaultTeeId).toBe('blue');
    const err = await rejection(updateRound(db, 'org1', { tournamentId: tid, roundId: rid, defaultTeeId: 'purple' }, u()));
    expect(err.code).toBe('invalid-argument');
  });

  it('a round with no tee sets has no default, and cannot be given one', async () => {
    const { tid, rid } = await setup(false);
    expect((await roundRef(tid, rid).get()).data()!.defaultTeeId).toBeNull();
    const err = await rejection(updateRound(db, 'org1', { tournamentId: tid, roundId: rid, defaultTeeId: 'blue' }, u()));
    expect(err.message).toContain('no tee sets');
  });

  it('replacing the course clears picks of tees that no longer exist and falls back to the first tee', async () => {
    const { tid, rid } = await setup();
    await call('org1', tid, rid, [{ playerId: 'p1', teeId: 'white' }, { playerId: 'p2', teeId: 'blue' }]);
    await updateRound(db, 'org1', { tournamentId: tid, roundId: rid, defaultTeeId: 'white' }, u());
    const smaller = { ...course(), tees: [course().tees[1]] };
    const view = await updateRound(db, 'org1', { tournamentId: tid, roundId: rid, course: smaller as never }, u());
    expect(view.defaultTeeId).toBe('blue');
    expect((await pickRef(tid, rid, 'p1').get()).data()!.teeId).toBeNull();
    expect((await pickRef(tid, rid, 'p2').get()).data()!.teeId).toBe('blue');
    // Two updates happened (the default tee, then the course); the feed has no fixed order here, so find the course one.
    const events = await feedOf(tid, 'round_updated');
    expect(events.find((e) => e.data.teePicksCleared !== undefined)?.data.teePicksCleared).toBe(1);
  });
});

describe('a player choosing their own tee and checking in', () => {
  it('sets a tee and table without checking in, and leaves no feed event', async () => {
    const { tid, rid } = await setup();
    const result = await call('p1', tid, rid, [{ teeId: 'blue', table: 'women' }]);
    expect(result.players).toEqual([{ playerId: 'p1', teeId: 'blue', table: 'women', checkedIn: false }]);
    const doc = (await pickRef(tid, rid, 'p1').get()).data()!;
    expect(doc).toMatchObject({ playerId: 'p1', teeId: 'blue', table: 'women', checkedIn: false, checkedInAt: null, setBy: 'p1' });
    expect(await feedOf(tid, 'round_players_changed')).toHaveLength(0);
  });

  it('checking in needs a table, fills a missing tee from the round default, and stamps the time', async () => {
    const { tid, rid } = await setup();
    const err = await rejection(call('p1', tid, rid, [{ checkedIn: true }]));
    expect(err.code).toBe('invalid-argument');
    expect(err.message).toContain("men's or women's");

    const result = await call('p1', tid, rid, [{ checkedIn: true, table: 'men' }]);
    expect(result.players[0]).toEqual({ playerId: 'p1', teeId: 'black', table: 'men', checkedIn: true });
    const doc = (await pickRef(tid, rid, 'p1').get()).data()!;
    expect(doc.checkedInAt).not.toBeNull();
  });

  it('a pre-set tee survives checking in, and checking out clears the time but keeps the tee', async () => {
    const { tid, rid } = await setup();
    await call('p1', tid, rid, [{ teeId: 'blue', table: 'men' }]);
    await call('p1', tid, rid, [{ checkedIn: true }]);
    let doc = (await pickRef(tid, rid, 'p1').get()).data()!;
    expect(doc).toMatchObject({ teeId: 'blue', table: 'men', checkedIn: true });
    const stamped = doc.checkedInAt;
    // Changing only the tee while checked in keeps the original check-in time.
    await call('p1', tid, rid, [{ teeId: 'white' }]);
    doc = (await pickRef(tid, rid, 'p1').get()).data()!;
    expect(doc.checkedInAt.isEqual(stamped)).toBe(true);
    await call('p1', tid, rid, [{ checkedIn: false }]);
    doc = (await pickRef(tid, rid, 'p1').get()).data()!;
    expect(doc).toMatchObject({ teeId: 'white', checkedIn: false, checkedInAt: null });
  });

  it('refuses a table the tee has no rating for, an unknown tee, and a tee when the course has none', async () => {
    const { tid, rid } = await setup();
    const noWomen = await rejection(call('p1', tid, rid, [{ teeId: 'black', table: 'women' }]));
    expect(noWomen.message).toContain("Black has no women's rating");
    // A tee with no ratings at all is fine for either table.
    await call('p1', tid, rid, [{ teeId: 'white', table: 'women' }]);
    const unknown = await rejection(call('p1', tid, rid, [{ teeId: 'purple' }]));
    expect(unknown.code).toBe('invalid-argument');

    const bare = await setup(false);
    const noTees = await rejection(call('p1', bare.tid, bare.rid, [{ teeId: 'blue' }]));
    expect(noTees.message).toContain('no tee sets');
  });

  it('on a round whose course has no tees, a player can still check in', async () => {
    const { tid, rid } = await setup(false);
    const result = await call('p2', tid, rid, [{ checkedIn: true }]);
    expect(result.players[0]).toEqual({ playerId: 'p2', teeId: null, table: null, checkedIn: true });
  });

  it('a repeat that changes nothing writes nothing', async () => {
    const { tid, rid } = await setup();
    await call('p1', tid, rid, [{ teeId: 'blue', table: 'men' }]);
    const usage = u();
    await setRoundPlayers(db, 'p1', { tournamentId: tid, roundId: rid, players: [{ teeId: 'blue', table: 'men' }] }, usage);
    expect(usage.docsWritten).toBe(0);
  });

  it('refuses a person who is not on the roster or has been removed', async () => {
    const { tid, rid } = await setup();
    const stranger = await rejection(call('nobody', tid, rid, [{ teeId: 'blue' }]));
    expect(stranger.code).toBe('failed-precondition');
    await startTournament(db, 'org1', { tournamentId: tid }, u());
    await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p3' }, u());
    const removed = await rejection(call('p3', tid, rid, [{ teeId: 'blue' }]));
    expect(removed.message).toContain('removed');
  });

  it('a player cannot touch anyone else, and cannot change their tee once they have a score', async () => {
    const { tid, rid } = await setup();
    const other = await rejection(call('p1', tid, rid, [{ playerId: 'p2', teeId: 'blue' }]));
    expect(other.code).toBe('permission-denied');

    await call('p1', tid, rid, [{ teeId: 'blue', table: 'men' }]);
    await roundRef(tid, rid).collection('scores').doc('p1_1_1').set({ playerId: 'p1', hole: 1, strokes: 4 });
    const locked = await rejection(call('p1', tid, rid, [{ teeId: 'white' }]));
    expect(locked.code).toBe('failed-precondition');
    expect(locked.message).toContain('only the organizer');
    // Checking in and out is still theirs to do.
    await call('p1', tid, rid, [{ checkedIn: true }]);
  });

  it('refuses a finished round, saying that only the organizer can change it now', async () => {
    const { tid, rid } = await setup();
    await roundRef(tid, rid).update({ status: 'finalized' });
    const err = await rejection(call('p1', tid, rid, [{ teeId: 'blue' }]));
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toContain('only the organizer');
  });

  it('records themselves as the one who checked them in', async () => {
    const { tid, rid } = await setup();
    await call('p1', tid, rid, [{ checkedIn: true, table: 'men' }]);
    expect((await pickRef(tid, rid, 'p1').get()).data()).toMatchObject({ checkedIn: true, checkedInBy: 'p1' });
    await call('p1', tid, rid, [{ checkedIn: false }]);
    expect((await pickRef(tid, rid, 'p1').get()).data()).toMatchObject({ checkedIn: false, checkedInBy: null });
  });
});

describe('the organizer setting tees and check-in for others', () => {
  it('pre-sets everyone ahead of time in one call without checking anyone in, and logs one quiet event', async () => {
    const { tid, rid } = await setup();
    const result = await call('org1', tid, rid, [
      { playerId: 'p1', teeId: 'black', table: 'men' },
      { playerId: 'p2', teeId: 'blue', table: 'women' },
      { playerId: 'p3', teeId: 'white' },
    ]);
    expect(result.players.map((p) => [p.playerId, p.teeId, p.checkedIn])).toEqual([
      ['p1', 'black', false],
      ['p2', 'blue', false],
      ['p3', 'white', false],
    ]);
    const events = await feedOf(tid, 'round_players_changed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: 'admins',
      category: 'changes',
      data: { roundId: rid, players: 3, teesChanged: 3, checkInsChanged: 0 },
    });
  });

  it('can check a player in for them, and a lone target is named on the event', async () => {
    const { tid, rid } = await setup();
    await call('org1', tid, rid, [{ playerId: 'p2', checkedIn: true, teeId: 'blue', table: 'women' }]);
    expect((await pickRef(tid, rid, 'p2').get()).data()).toMatchObject({ checkedIn: true, setBy: 'org1' });
    const [event] = await feedOf(tid, 'round_players_changed');
    expect(event.targetPlayerId).toBe('p2');
    expect(event.data.checkInsChanged).toBe(1);
  });

  it('marks a check-in done for the player as the organizer\'s, and keeps that when only the tee changes later', async () => {
    const { tid, rid } = await setup();
    await call('org1', tid, rid, [{ playerId: 'p2', checkedIn: true, teeId: 'blue', table: 'women' }]);
    expect((await pickRef(tid, rid, 'p2').get()).data()).toMatchObject({ checkedIn: true, checkedInBy: 'org1' });
    await call('p2', tid, rid, [{ teeId: 'white' }]);
    expect((await pickRef(tid, rid, 'p2').get()).data()).toMatchObject({ teeId: 'white', checkedInBy: 'org1' });
    // Undoing it clears who did it; the player checking in again takes it over.
    await call('org1', tid, rid, [{ playerId: 'p2', checkedIn: false }]);
    expect((await pickRef(tid, rid, 'p2').get()).data()).toMatchObject({ checkedIn: false, checkedInBy: null });
    await call('p2', tid, rid, [{ checkedIn: true }]);
    expect((await pickRef(tid, rid, 'p2').get()).data()).toMatchObject({ checkedIn: true, checkedInBy: 'p2' });
  });

  it('can still fill in check-in after the round is finished, but not on a cancelled round', async () => {
    const { tid, rid } = await setup();
    await roundRef(tid, rid).update({ status: 'finalized', number: 1 });
    // The player handed in a card and left; the organizer completes the record afterwards.
    await call('org1', tid, rid, [{ playerId: 'p3', checkedIn: true, teeId: 'black', table: 'men' }]);
    expect((await pickRef(tid, rid, 'p3').get()).data()).toMatchObject({ checkedIn: true, checkedInBy: 'org1', teeId: 'black' });
    // A tee set or changed after play began is shown to everyone, since it changes what the scores mean.
    await call('org1', tid, rid, [{ playerId: 'p3', teeId: 'blue' }]);
    expect((await feedOf(tid, 'round_players_changed')).map((e) => e.level)).toEqual(['all', 'all']);    await roundRef(tid, rid).update({ status: 'cancelled' });
    const err = await rejection(call('org1', tid, rid, [{ playerId: 'p3', checkedIn: false }]));
    expect(err.code).toBe('failed-precondition');
  });

  it('does everything or nothing: one bad entry changes no one', async () => {
    const { tid, rid } = await setup();
    const err = await rejection(
      call('org1', tid, rid, [
        { playerId: 'p1', teeId: 'blue', table: 'men' },
        { playerId: 'p2', teeId: 'black', table: 'women' },
      ]),
    );
    expect(err.code).toBe('invalid-argument');
    expect((await pickRef(tid, rid, 'p1').get()).exists).toBe(false);
  });

  it('may change the tee of a player who already has a score, announced to everyone on a live round', async () => {
    const { tid, rid } = await setup();
    await call('org1', tid, rid, [{ playerId: 'p1', teeId: 'blue', table: 'men' }]);
    await roundRef(tid, rid).update({ status: 'live' });
    await roundRef(tid, rid).collection('scores').doc('p1_1_1').set({ playerId: 'p1', hole: 1, strokes: 4 });
    await call('org1', tid, rid, [{ playerId: 'p1', teeId: 'white' }]);
    expect((await pickRef(tid, rid, 'p1').get()).data()!.teeId).toBe('white');
    const events = await feedOf(tid, 'round_players_changed');
    expect(events.map((e) => e.level).sort()).toEqual(['admins', 'all']);
  });

  it('refuses a player who is not on the roster, repeats, empty or unknown fields, and too many at once', async () => {
    const { tid, rid } = await setup();
    expect((await rejection(call('org1', tid, rid, [{ playerId: 'ghost', teeId: 'blue' }]))).code).toBe('failed-precondition');
    expect((await rejection(call('org1', tid, rid, [{ playerId: 'p1', teeId: 'blue' }, { playerId: 'p1', teeId: 'white' }]))).code).toBe('invalid-argument');
    expect((await rejection(call('org1', tid, rid, [{ playerId: 'p1' }]))).code).toBe('invalid-argument');
    expect((await rejection(call('org1', tid, rid, [{ playerId: 'p1', teeId: 'blue', colour: 'red' }]))).code).toBe('invalid-argument');
    expect((await rejection(call('org1', tid, rid, []))).code).toBe('invalid-argument');
    const many = Array.from({ length: 101 }, (_, i) => ({ playerId: `x${i}`, teeId: 'blue' }));
    expect((await rejection(call('org1', tid, rid, many))).code).toBe('invalid-argument');
    expect((await rejection(call('org1', tid, rid, [{ playerId: 'p1', teeId: 'blue', table: 'both' }]))).code).toBe('invalid-argument');
  });
});

describe('deleting a round', () => {
  it('removes its tee picks and check-ins too', async () => {
    const { tid, rid } = await setup();
    await call('org1', tid, rid, [{ playerId: 'p1', teeId: 'blue', table: 'men' }, { playerId: 'p2', teeId: 'blue', table: 'women' }]);
    await deleteRound(db, 'org1', { tournamentId: tid, roundId: rid }, u());
    expect((await roundRef(tid, rid).collection('roundPlayers').get()).empty).toBe(true);
  });
});
