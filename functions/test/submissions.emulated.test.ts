import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setGroups } from '../src/groups';
import { setMyHandicap } from '../src/handicap';
import { joinTournament, removePlayer } from '../src/roster';
import { createRound, deleteRound, updateRound } from '../src/rounds';
import { startRound } from '../src/roundStart';
import { processSubmission } from '../src/submissions';
import { updateTournament } from '../src/tournamentAdmin';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.
// The score inbox: a submission is checked and becomes an official score, or is rejected with a reason.

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-submissions' }, 'submissions-test'));
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection('tournaments'));
  await db.recursiveDelete(db.collection('inviteCodes'));
});

const u = () => new UsageTracker();
const holes = Array.from({ length: 18 }, (_, i) => ({ par: 4, strokeIndex: i + 1 }));
const T0 = Date.now() - 60_000; // a minute ago: a believable phone clock

async function rejection(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (err) {
    return err as HttpsError;
  }
  throw new Error('expected the call to be rejected');
}

// org (organizer), p1..p4 on the roster; one round on the 14th with a course, one group of p1 + p2 and one of p3 + p4.
async function setup() {
  const t = await createTournament(db, 'org', { name: 'Score Cup', startDate: '2026-11-13', endDate: '2026-11-15' }, u());
  for (const p of ['p1', 'p2', 'p3', 'p4']) await joinTournament(db, p, { inviteCode: t.inviteCode }, u());
  const round = await createRound(db, 'org', { tournamentId: t.id, date: '2026-11-14', course: { name: 'C', holes } as never }, u());
  const set = await setGroups(
    db,
    'org',
    { tournamentId: t.id, roundId: round.id, groups: [{ playerIds: ['p1', 'p2'] }, { playerIds: ['p3', 'p4'] }] as never },
    u(),
  );
  return { tid: t.id, rid: round.id, g1: set.groups[0].id, g2: set.groups[1].id };
}

type Fields = { playerId: string; hole: number; strokes: number; groupId: string; enteredBy: string; clientTime?: number; kind?: string };

// What the phone writes (the security rule is tested separately), then the function's run on it.
async function submit(tid: string, rid: string, f: Fields, usage = u()) {
  const data = { kind: 'played', clientTime: T0, ...f };
  const id = `${data.playerId}_${data.hole}_${data.clientTime}`;
  await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).collection('submissions').doc(id).set(data);
  const result = await processSubmission(db, tid, rid, id, usage);
  return { id, result };
}
const roundDoc = async (tid: string, rid: string) => (await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).get()).data()!;
const subDoc = async (tid: string, rid: string, id: string) =>
  (await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).collection('submissions').doc(id).get()).data()!;
const scoreDocs = async (tid: string, rid: string) =>
  (await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).collection('scores').get()).docs.map((d) => ({ id: d.id, ...d.data() })) as any[];
async function feedOf(tid: string, type: string) {
  const snap = await db.collection('tournaments').doc(tid).collection('activity').where('type', '==', type).get();
  return snap.docs.map((d) => d.data());
}

describe('accepting a score', () => {
  it('writes the official score under the same id and marks the submission accepted', async () => {
    const { tid, rid, g1 } = await setup();
    const { id, result } = await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 5, groupId: g1, enteredBy: 'p2' });
    expect(result).toMatchObject({ result: 'recorded', decision: { outcome: 'accepted' } });
    const scores = await scoreDocs(tid, rid);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ id, playerId: 'p1', hole: 1, strokes: 5, kind: 'played', groupId: g1, enteredBy: 'p2', status: 'accepted', submissionId: id, clientTime: T0 });
    const sub = await subDoc(tid, rid, id);
    expect(sub.outcome).toBe('accepted');
    expect(sub.processedAt).toBeDefined();
    expect(sub.reason).toBeUndefined();
  });

  it('a pickup is recorded as a pickup', async () => {
    const { tid, rid, g1 } = await setup();
    await submit(tid, rid, { playerId: 'p1', hole: 3, strokes: 8, kind: 'pickup', groupId: g1, enteredBy: 'p1' });
    expect((await scoreDocs(tid, rid))[0]).toMatchObject({ kind: 'pickup', strokes: 8 });
  });

  it('a pickup is recorded as the maximum, with the phone\'s own number kept; a real score at the maximum stays a played score', async () => {
    const { tid, rid, g1 } = await setup();
    // par 4 everywhere, so the maximum is 8. The phone says 5 for a pickup, the server records 8.
    await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 5, kind: 'pickup', groupId: g1, enteredBy: 'p1' });
    // A player who actually took 8 is a played 8, a different thing from the pickup 8.
    await submit(tid, rid, { playerId: 'p2', hole: 1, strokes: 8, kind: 'played', groupId: g1, enteredBy: 'p2' });
    const scores = await scoreDocs(tid, rid);
    const pickup = scores.find((s) => s.playerId === 'p1');
    const played = scores.find((s) => s.playerId === 'p2');
    expect(pickup).toMatchObject({ kind: 'pickup', strokes: 8, strokesEntered: 5 });
    expect(played).toMatchObject({ kind: 'played', strokes: 8 });
    expect(played.strokesEntered).toBeUndefined();
  });

  it('a pickup in a round with no course keeps the number it came with', async () => {
    const t = await createTournament(db, 'org', { name: 'No course', startDate: '2026-11-13', endDate: '2026-11-15' }, u());
    await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, u());
    const round = await createRound(db, 'org', { tournamentId: t.id, date: '2026-11-14' }, u());
    const set = await setGroups(db, 'org', { tournamentId: t.id, roundId: round.id, groups: [{ playerIds: ['p1'] }] as never }, u());
    await submit(t.id, round.id, { playerId: 'p1', hole: 1, strokes: 9, kind: 'pickup', groupId: set.groups[0].id, enteredBy: 'p1' });
    expect((await scoreDocs(t.id, round.id))[0]).toMatchObject({ kind: 'pickup', strokes: 9 });
  });

  it('a tournament set to record every stroke accepts a 14 on a par 4, and refuses a pickup', async () => {
    const t = await createTournament(db, 'org', { name: 'High school', startDate: '2026-11-13', endDate: '2026-11-15' }, u());
    await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, u());
    // Chosen once up front on the tournament; the round inherits it.
    await updateTournament(db, 'org', { tournamentId: t.id, defaultScoring: { maxScore: { mode: 'none' } } }, u());
    const round = await createRound(db, 'org', { tournamentId: t.id, date: '2026-11-14', course: { name: 'C', holes } as never }, u());
    expect((await roundDoc(t.id, round.id)).scoring.maxScore).toEqual({ mode: 'none', value: null });
    const set = await setGroups(db, 'org', { tournamentId: t.id, roundId: round.id, groups: [{ playerIds: ['p1'] }] as never }, u());
    const g = set.groups[0].id;

    await submit(t.id, round.id, { playerId: 'p1', hole: 1, strokes: 14, groupId: g, enteredBy: 'p1' });
    expect((await scoreDocs(t.id, round.id))[0]).toMatchObject({ kind: 'played', strokes: 14 });
    const { id } = await submit(t.id, round.id, { playerId: 'p1', hole: 2, strokes: 14, kind: 'pickup', groupId: g, enteredBy: 'p1' });
    expect((await subDoc(t.id, round.id, id)).reasonCode).toBe('noPickups');
  });

  it('the default scoring is merged against what the tournament has, only a real change is logged, and a round can still differ', async () => {
    const t = await createTournament(db, 'org', { name: 'Defaults', startDate: '2026-11-13', endDate: '2026-11-15' }, u());
    const tdoc = async () => (await db.collection('tournaments').doc(t.id).get()).data()!;
    await updateTournament(db, 'org', { tournamentId: t.id, defaultScoring: { maxScore: { mode: 'none' } } }, u());
    await updateTournament(db, 'org', { tournamentId: t.id, defaultScoring: { handicapMode: 'gross' } }, u());
    // The second edit named only the handicap mode; the maximum stays "none".
    expect((await tdoc()).defaultScoring).toMatchObject({ handicapMode: 'gross', maxScore: { mode: 'none', value: null } });
    const logged = (await feedOf(t.id, 'tournament_updated')).length;
    expect(logged).toBe(2);
    // The same value again changes nothing and leaves no event.
    await updateTournament(db, 'org', { tournamentId: t.id, defaultScoring: { handicapMode: 'gross' } }, u());
    expect((await feedOf(t.id, 'tournament_updated')).length).toBe(logged);

    // A round inherits it, an explicit setting on the round wins, and a partial edit keeps the rest.
    const inherited = await createRound(db, 'org', { tournamentId: t.id, date: '2026-11-14' }, u());
    expect((await roundDoc(t.id, inherited.id)).scoring).toMatchObject({ handicapMode: 'gross', maxScore: { mode: 'none' } });
    const explicit = await createRound(db, 'org', { tournamentId: t.id, date: '2026-11-15', scoring: { maxScore: { mode: 'doublePar' } } }, u());
    expect((await roundDoc(t.id, explicit.id)).scoring).toMatchObject({ handicapMode: 'gross', maxScore: { mode: 'doublePar' } });
    await updateRound(db, 'org', { tournamentId: t.id, roundId: inherited.id, scoring: { handicapMode: 'net' } }, u());
    expect((await roundDoc(t.id, inherited.id)).scoring).toMatchObject({ handicapMode: 'net', maxScore: { mode: 'none' } });

    // Clearing the tournament default goes back to the standard rules for rounds made afterwards.
    await updateTournament(db, 'org', { tournamentId: t.id, defaultScoring: null }, u());
    const later = await createRound(db, 'org', { tournamentId: t.id, date: '2026-11-13' }, u());
    expect((await roundDoc(t.id, later.id)).scoring.maxScore).toEqual({ mode: 'doublePar', value: null });
  });

  it('a 14 on a par 4 is turned away when the round keeps the usual maximum', async () => {
    const { tid, rid, g1 } = await setup();
    const { id } = await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 14, groupId: g1, enteredBy: 'p1' });
    expect((await subDoc(tid, rid, id)).reasonCode).toBe('overMax');
    expect(await scoreDocs(tid, rid)).toHaveLength(0);
  });

  it('the same submission processed twice leaves one score and does not repeat the work', async () => {
    const { tid, rid, g1 } = await setup();
    const { id } = await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g1, enteredBy: 'p1' });
    const again = await processSubmission(db, tid, rid, id, u());
    expect(again.result).toBe('already');
    expect(await scoreDocs(tid, rid)).toHaveLength(1);
    expect(await feedOf(tid, 'round_started')).toHaveLength(1);
  });

  it('a submission that is gone is skipped quietly', async () => {
    const { tid, rid } = await setup();
    expect((await processSubmission(db, tid, rid, 'nope_1_1', u())).result).toBe('gone');
  });

  it('racing entries for the same player and hole are both kept, ordered by the phone clock', async () => {
    const { tid, rid, g1 } = await setup();
    await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g1, enteredBy: 'p1', clientTime: T0 });
    await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 5, groupId: g1, enteredBy: 'p2', clientTime: T0 + 5000 });
    const scores = (await scoreDocs(tid, rid)).sort((a, b) => a.clientTime - b.clientTime);
    expect(scores.map((s) => [s.strokes, s.enteredBy])).toEqual([[4, 'p1'], [5, 'p2']]);
  });

  it('a phone clock far ahead is pulled back to the server clock and the original is kept', async () => {
    const { tid, rid, g1 } = await setup();
    const future = Date.now() + 3 * 24 * 3600 * 1000;
    const before = Date.now();
    await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g1, enteredBy: 'p1', clientTime: future });
    const [score] = await scoreDocs(tid, rid);
    expect(score.clientTimeRaw).toBe(future);
    expect(score.clientTime).toBeGreaterThanOrEqual(before);
    expect(score.clientTime).toBeLessThanOrEqual(Date.now());
  });

  it('an organizer can enter a score for a player in a group they are not in', async () => {
    const { tid, rid, g2 } = await setup();
    const { result } = await submit(tid, rid, { playerId: 'p3', hole: 1, strokes: 4, groupId: g2, enteredBy: 'org' });
    expect(result.decision?.outcome).toBe('accepted');
  });
});

describe('the first score starts the round', () => {
  it('goes live, snapshots handicaps (not withdrawn players), starts the tournament, and tells everyone once', async () => {
    const { tid, rid, g1 } = await setup();
    await setMyHandicap(db, 'p1', { tournamentId: tid, handicap: 12 }, u());
    await setMyHandicap(db, 'p2', { tournamentId: tid, handicap: 20.5 }, u());
    await setMyHandicap(db, 'p4', { tournamentId: tid, handicap: 3 }, u());
    await removePlayer(db, 'org', { tournamentId: tid, playerId: 'p4' }, u()); // before Start: the entry is deleted
    expect((await roundDoc(tid, rid)).status).toBe('scheduled');

    const { result } = await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g1, enteredBy: 'p1' });
    expect(result.startedRound).toBe(true);

    const round = await roundDoc(tid, rid);
    expect(round.status).toBe('live');
    expect(round.startedAt).toBeDefined();
    expect(round.playingHandicaps).toEqual({ p1: 12, p2: 20.5 });
    expect((await db.collection('tournaments').doc(tid).get()).data()!.startedAt).toBeDefined();
    const started = await feedOf(tid, 'round_started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ level: 'all', category: 'changes', actorId: 'p1', data: { roundId: rid, auto: true, withHandicaps: 2 } });
    expect(await feedOf(tid, 'tournament_started')).toHaveLength(1);

    // A second score does not start anything again, and a later roster handicap change leaves the snapshot alone.
    await setMyHandicap(db, 'p1', { tournamentId: tid, handicap: 30 }, u()).catch(() => undefined); // locked after start
    await submit(tid, rid, { playerId: 'p2', hole: 1, strokes: 5, groupId: g1, enteredBy: 'p2' });
    expect((await roundDoc(tid, rid)).playingHandicaps).toEqual({ p1: 12, p2: 20.5 });
    expect(await feedOf(tid, 'round_started')).toHaveLength(1);
  });

  it('a rejected score does not start the round', async () => {
    const { tid, rid, g2 } = await setup();
    await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g2, enteredBy: 'p1' }); // p1 is not in g2
    expect((await roundDoc(tid, rid)).status).toBe('scheduled');
    expect(await feedOf(tid, 'round_started')).toHaveLength(0);
  });
});

describe('turning a score away', () => {
  async function rejected(tid: string, rid: string, f: Fields) {
    const scoresBefore = (await scoreDocs(tid, rid)).length;
    const { id, result } = await submit(tid, rid, f);
    const sub = await subDoc(tid, rid, id);
    expect(result.decision?.outcome).toBe('rejected');
    expect(sub.outcome).toBe('rejected');
    expect(typeof sub.reason).toBe('string');
    expect(await scoreDocs(tid, rid)).toHaveLength(scoresBefore); // a rejection never writes a score
    return sub;
  }

  it('someone not in the group, a group that is not in this round, and a player not in the named group', async () => {
    const { tid, rid, g1, g2 } = await setup();
    expect((await rejected(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g1, enteredBy: 'p3' })).reasonCode).toBe('notInGroup');
    expect((await rejected(tid, rid, { playerId: 'p1', hole: 2, strokes: 4, groupId: 'no-such-group', enteredBy: 'p1' })).reasonCode).toBe('notInGroup');
    expect((await rejected(tid, rid, { playerId: 'p1', hole: 3, strokes: 4, groupId: g2, enteredBy: 'p3' })).reasonCode).toBe('notInGroup');
  });

  it('a hole outside the round, and more strokes than the round allows', async () => {
    const { tid, rid, g1 } = await setup();
    await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).update({ holesPlanned: 9 });
    expect((await rejected(tid, rid, { playerId: 'p1', hole: 12, strokes: 4, groupId: g1, enteredBy: 'p1' })).reasonCode).toBe('outOfRange');
    // par 4 everywhere, so double par is 8
    expect((await rejected(tid, rid, { playerId: 'p1', hole: 2, strokes: 9, groupId: g1, enteredBy: 'p1' })).reasonCode).toBe('overMax');
  });

  it('a player withdrawn after the start, while the round is under way', async () => {
    const { tid, rid, g1 } = await setup();
    await submit(tid, rid, { playerId: 'p2', hole: 1, strokes: 4, groupId: g1, enteredBy: 'p2' }); // starts the round
    await removePlayer(db, 'org', { tournamentId: tid, playerId: 'p2' }, u()); // kept as withdrawn, still in the live group
    expect((await rejected(tid, rid, { playerId: 'p2', hole: 2, strokes: 4, groupId: g1, enteredBy: 'p1' })).reasonCode).toBe('withdrawn');
  });

  it('a cancelled round and a suspended tournament', async () => {
    const { tid, rid, g1 } = await setup();
    await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).update({ status: 'cancelled' });
    expect((await rejected(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g1, enteredBy: 'p1' })).reasonCode).toBe('cancelled');
    await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).update({ status: 'live' });
    await db.collection('tournaments').doc(tid).update({ status: 'suspended' });
    expect((await rejected(tid, rid, { playerId: 'p1', hole: 2, strokes: 4, groupId: g1, enteredBy: 'p1' })).reasonCode).toBe('suspended');
  });

  it('a round that was deleted while the phone was offline', async () => {
    const { tid, rid, g1 } = await setup();
    // The phone's entry arrives after the round was deleted (deleteRound only allows it while no submission exists).
    await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).collection('groups').doc(g1).delete();
    await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).delete();
    const { id, result } = await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g1, enteredBy: 'p1' });
    expect(result.decision?.outcome).toBe('rejected');
    expect((await subDoc(tid, rid, id)).reasonCode).toBe('noSuchRound');
  });

  it('a submission it cannot read is rejected, not crashed on', async () => {
    const { tid, rid } = await setup();
    const ref = db.collection('tournaments').doc(tid).collection('rounds').doc(rid).collection('submissions').doc('junk');
    await ref.set({ playerId: 'p1', hole: 'one', strokes: 4 });
    expect((await processSubmission(db, tid, rid, 'junk', u())).result).toBe('recorded');
    expect((await ref.get()).data()).toMatchObject({ outcome: 'rejected', reasonCode: 'malformed' });
  });
});

describe('review and final rounds', () => {
  async function inReview(tid: string, rid: string, status: string) {
    // Make the round live first (a score starts it), then put it in review a minute ago.
    await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).update({
      status,
      reviewStartedAt: Timestamp.fromMillis(T0 + 1000),
    });
  }

  it('a score entered before review began but sent afterwards is kept and flagged late', async () => {
    const { tid, rid, g1 } = await setup();
    await inReview(tid, rid, 'pending_review');
    const { id } = await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g1, enteredBy: 'p1', clientTime: T0 });
    expect((await scoreDocs(tid, rid))[0].status).toBe('late');
    const sub = await subDoc(tid, rid, id);
    expect(sub).toMatchObject({ outcome: 'accepted_late', reasonCode: 'late' });
    expect(sub.reason).toContain('review');
  });

  it('a score entered after review began is refused for a player, accepted for the organizer', async () => {
    const { tid, rid, g1 } = await setup();
    await inReview(tid, rid, 'pending_review');
    const player = await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g1, enteredBy: 'p1', clientTime: T0 + 5000 });
    expect((await subDoc(tid, rid, player.id)).reasonCode).toBe('inReview');
    const admin = await submit(tid, rid, { playerId: 'p1', hole: 2, strokes: 4, groupId: g1, enteredBy: 'org', clientTime: T0 + 5000 });
    expect(admin.result.decision?.outcome).toBe('accepted');
  });

  it('a final round refuses a new entry', async () => {
    const { tid, rid, g1 } = await setup();
    await inReview(tid, rid, 'finalized');
    const { id } = await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g1, enteredBy: 'org', clientTime: T0 + 5000 });
    expect((await subDoc(tid, rid, id)).reasonCode).toBe('finalized');
  });
});

describe('startRound', () => {
  it('an organizer starts it: live, handicaps fixed, tournament started, everyone told; repeating is harmless', async () => {
    const { tid, rid } = await setup();
    await setMyHandicap(db, 'p1', { tournamentId: tid, handicap: 7 }, u());
    expect(await startRound(db, 'org', { tournamentId: tid, roundId: rid }, u())).toEqual({ roundId: rid, alreadyLive: false });
    const round = await roundDoc(tid, rid);
    expect(round.status).toBe('live');
    expect(round.playingHandicaps).toEqual({ p1: 7 });
    expect((await feedOf(tid, 'round_started'))[0]).toMatchObject({ actorId: 'org', data: { auto: false } });
    expect(await startRound(db, 'org', { tournamentId: tid, roundId: rid }, u())).toEqual({ roundId: rid, alreadyLive: true });
    expect(await feedOf(tid, 'round_started')).toHaveLength(1);
  });

  it('only an admin, and not a cancelled or finished round', async () => {
    const { tid, rid } = await setup();
    expect((await rejection(startRound(db, 'p1', { tournamentId: tid, roundId: rid }, u()))).code).toBe('permission-denied');
    expect((await rejection(startRound(db, 'org', { tournamentId: tid, roundId: 'nope' }, u()))).code).toBe('not-found');
    await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).update({ status: 'finalized' });
    expect((await rejection(startRound(db, 'org', { tournamentId: tid, roundId: rid }, u()))).code).toBe('failed-precondition');
  });
});

describe('guards that depend on scores', () => {
  it('deleteRound refuses once any submission exists, even one that was turned away', async () => {
    const { tid, rid, g1, g2 } = await setup();
    await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g2, enteredBy: 'p1' }); // rejected: round stays scheduled
    expect((await roundDoc(tid, rid)).status).toBe('scheduled');
    const err = await rejection(deleteRound(db, 'org', { tournamentId: tid, roundId: rid }, u()));
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toContain('waiting to sync');
    expect(g1).toBeDefined();
  });

  it('setGroups will not take a scored player out of a live round, but lets them move groups', async () => {
    const { tid, rid, g1, g2 } = await setup();
    await submit(tid, rid, { playerId: 'p1', hole: 1, strokes: 4, groupId: g1, enteredBy: 'p1' }); // round is live now

    const without = await rejection(
      setGroups(db, 'org', { tournamentId: tid, roundId: rid, groups: [{ id: g1, playerIds: ['p2'] }, { id: g2, playerIds: ['p3', 'p4'] }] as never }, u()),
    );
    expect(without.code).toBe('failed-precondition');
    expect(without.message).toContain('already has scores');

    // Moving p1 into the other group is fine, and so is removing someone with no score (p2).
    await setGroups(db, 'org', { tournamentId: tid, roundId: rid, groups: [{ id: g1, playerIds: ['p2'] }, { id: g2, playerIds: ['p1', 'p3', 'p4'] }] as never }, u());
    await setGroups(db, 'org', { tournamentId: tid, roundId: rid, groups: [{ id: g2, playerIds: ['p1', 'p3', 'p4'] }] as never }, u());
  });
});
