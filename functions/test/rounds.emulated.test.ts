import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setGroups } from '../src/groups';
import { MAX_ROUNDS_PER_TOURNAMENT } from '../src/limits';
import { joinTournament, removePlayer } from '../src/roster';
import { startTournament } from '../src/lifecycle';
import { createRound, updateRound } from '../src/rounds';
import { updateTournament } from '../src/tournamentAdmin';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.
// Rounds (createRound, updateRound) and their groups (setGroups).

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-rounds' }, 'rounds-test'));
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

const holes = (count: number) => Array.from({ length: count }, (_, i) => ({ par: 4, strokeIndex: i + 1 }));
const course = (count = 18) => ({ name: 'Pebble Beach', tees: 'Blue', rating: 74.9, slope: 144, holes: holes(count) });

// org1 runs the tournament (dates 2026-11-13 to 2026-11-15); p1..p6 have joined.
async function setup(extra: { startDate?: string; endDate?: string } = { startDate: '2026-11-13', endDate: '2026-11-15' }) {
  const t = await createTournament(db, 'org1', { name: 'Round Cup', ...extra }, u());
  for (const p of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await joinTournament(db, p, { inviteCode: t.inviteCode }, u());
  return { tid: t.id };
}

const tournamentDoc = async (tid: string) => (await db.collection('tournaments').doc(tid).get()).data()!;
const roundDoc = async (tid: string, rid: string) =>
  (await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).get()).data();
const groupDocs = async (tid: string, rid: string) =>
  (await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).collection('groups').get()).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a: any, b: any) => a.order - b.order) as any[];
async function feedOf(tid: string, type: string) {
  const snap = await db.collection('tournaments').doc(tid).collection('activity').where('type', '==', type).get();
  return snap.docs.map((d) => d.data());
}
const addScore = (tid: string, rid: string) =>
  db.collection('tournaments').doc(tid).collection('rounds').doc(rid).collection('scores').doc('s1').set({ hole: 1 });

describe('createRound', () => {
  it('creates a round with every default filled in', async () => {
    const { tid } = await setup();
    const usage = u();
    const round = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, usage);

    expect(round).toMatchObject({
      number: 1,
      date: '2026-11-14',
      status: 'scheduled',
      holesPlanned: 18,
      firstHole: 1,
      maxGroupSize: 4,
      skippedHoles: [],
      course: null,
      courseSource: null,
      formats: [{ formatId: 'strokePlay', config: {} }],
      scoring: { handicapMode: 'net', maxScore: { mode: 'doublePar', value: null }, tiebreak: null },
      skins: { enabled: false, mode: 'perSkin', value: null, carryover: false },
    });
    const stored = (await roundDoc(tid, round.id))!;
    expect(stored.createdBy).toBe('org1');
    expect(stored.createdAt).toBeDefined();
    expect(stored.startedAt).toBeNull();
    expect(usage.tournamentId).toBe(tid);
    expect(usage.docsWritten).toBe(2); // the round and its feed event
  });

  it('numbers rounds in the order they are created', async () => {
    const { tid } = await setup();
    const a = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-15' }, u());
    const b = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-13' }, u());
    expect([a.number, b.number]).toEqual([1, 2]);
  });

  it('stores a hand-entered course as the round\'s own copy', async () => {
    const { tid } = await setup();
    const round = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14', course: course() }, u());
    expect(round.course?.holes).toHaveLength(18);
    expect(round.courseSource).toBe('manual');
    expect((await roundDoc(tid, round.id))!.courseVerifiedAt).toBeNull();
  });

  it('takes the tournament defaults for holes and group size, and a request can override them', async () => {
    const { tid } = await setup();
    await updateTournament(db, 'org1', { tournamentId: tid, defaultHolesPlanned: 9, defaultMaxGroupSize: 3 }, u());
    const inherited = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u());
    expect(inherited).toMatchObject({ holesPlanned: 9, maxGroupSize: 3, firstHole: 1 });
    const overridden = await createRound(
      db,
      'org1',
      { tournamentId: tid, date: '2026-11-14', holesPlanned: 18, maxGroupSize: 5 },
      u(),
    );
    expect(overridden).toMatchObject({ holesPlanned: 18, maxGroupSize: 5 });
  });

  it('supports a back-nine round, which needs an 18-hole course', async () => {
    const { tid } = await setup();
    const back = await createRound(
      db,
      'org1',
      { tournamentId: tid, date: '2026-11-14', holesPlanned: 9, firstHole: 10, course: course(18) },
      u(),
    );
    expect(back).toMatchObject({ holesPlanned: 9, firstHole: 10 });
    const err = await rejection(
      createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14', holesPlanned: 9, firstHole: 10, course: course(9) }, u()),
    );
    expect(err.code).toBe('invalid-argument');
  });

  it('keeps skipped holes and rejects ones outside the holes played', async () => {
    const { tid } = await setup();
    const ok = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14', skippedHoles: [12, 4] }, u());
    expect(ok.skippedHoles).toEqual([4, 12]);
    const err = await rejection(
      createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14', holesPlanned: 9, skippedHoles: [12] }, u()),
    );
    expect(err.code).toBe('invalid-argument');
  });

  it('refuses a non-admin and writes nothing', async () => {
    const { tid } = await setup();
    const err = await rejection(createRound(db, 'p1', { tournamentId: tid, date: '2026-11-14' }, u()));
    expect(err.code).toBe('permission-denied');
    expect((await db.collection('tournaments').doc(tid).collection('rounds').get()).size).toBe(0);
  });

  it('lets the co-admin create rounds', async () => {
    const { tid } = await setup();
    await db.collection('tournaments').doc(tid).update({ coAdminId: 'p1' });
    const round = await createRound(db, 'p1', { tournamentId: tid, date: '2026-11-14' }, u());
    expect(round.number).toBe(1);
  });

  it('rejects a missing or impossible date, unknown settings, and an unknown tournament', async () => {
    const { tid } = await setup();
    for (const date of [undefined, '', '14/11/2026', '2026-02-30']) {
      expect((await rejection(createRound(db, 'org1', { tournamentId: tid, date }, u()))).code).toBe('invalid-argument');
    }
    expect(
      (await rejection(createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14', mulligans: 3 } as never, u()))).code,
    ).toBe('invalid-argument');
    expect((await rejection(createRound(db, 'org1', { tournamentId: 'nope', date: '2026-11-14' }, u()))).code).toBe('not-found');
  });

  it('refuses a round on a suspended tournament', async () => {
    const { tid } = await setup();
    await db.collection('tournaments').doc(tid).update({ status: 'suspended' });
    expect((await rejection(createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u()))).code).toBe(
      'failed-precondition',
    );
  });

  it('caps the number of rounds', async () => {
    const { tid } = await setup();
    const rounds = db.collection('tournaments').doc(tid).collection('rounds');
    for (let i = 1; i <= MAX_ROUNDS_PER_TOURNAMENT; i++) await rounds.doc(`r${i}`).set({ number: i });
    const err = await rejection(createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u()));
    expect(err.code).toBe('resource-exhausted');
  });

  describe('dates outside the tournament', () => {
    it('refuses unless the admin agrees to widen the tournament dates', async () => {
      const { tid } = await setup();
      const err = await rejection(createRound(db, 'org1', { tournamentId: tid, date: '2026-11-17' }, u()));
      expect(err.code).toBe('failed-precondition');
      expect(err.message).toContain('extendTournamentDates');
      expect((await tournamentDoc(tid)).endDate).toBe('2026-11-15');
    });

    it('widens the dates when agreed, and records it', async () => {
      const { tid } = await setup();
      await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-17', extendTournamentDates: true }, u());
      await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-12', extendTournamentDates: true }, u());
      const t = await tournamentDoc(tid);
      expect([t.startDate, t.endDate]).toEqual(['2026-11-12', '2026-11-17']);
      const events = await feedOf(tid, 'tournament_updated');
      expect(events).toHaveLength(2);
      expect(events.some((e) => e.changes.endDate?.to === '2026-11-17')).toBe(true);
    });

    it('does not check a tournament that has no dates', async () => {
      const { tid } = await setup({});
      const round = await createRound(db, 'org1', { tournamentId: tid, date: '2030-01-01' }, u());
      expect(round.date).toBe('2030-01-01');
    });
  });

  describe('the activity feed', () => {
    it('keeps a new round between the admins before Start', async () => {
      const { tid } = await setup();
      await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14', course: course() }, u());
      const [event] = await feedOf(tid, 'round_created');
      expect(event).toMatchObject({ category: 'changes', level: 'admins', actorId: 'org1' });
      expect(event.data).toMatchObject({ number: 1, date: '2026-11-14', courseName: 'Pebble Beach' });
    });

    it('announces a round added after Start to everyone', async () => {
      const { tid } = await setup();
      await startTournament(db, 'org1', { tournamentId: tid }, u());
      await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u());
      const [event] = await feedOf(tid, 'round_created');
      expect(event.level).toBe('all');
    });
  });
});

describe('updateRound', () => {
  async function oneRound(extra: Record<string, unknown> = {}) {
    const { tid } = await setup();
    const round = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14', course: course(), ...extra }, u());
    return { tid, rid: round.id };
  }

  it('changes only the settings given and logs what changed', async () => {
    const { tid, rid } = await oneRound();
    const round = await updateRound(
      db,
      'org1',
      { tournamentId: tid, roundId: rid, maxGroupSize: 3, scoring: { handicapMode: 'gross' }, timeZone: 'America/Chicago' },
      u(),
    );
    expect(round).toMatchObject({ maxGroupSize: 3, timeZone: 'America/Chicago', holesPlanned: 18 });
    expect(round.scoring.handicapMode).toBe('gross');
    const [event] = await feedOf(tid, 'round_updated');
    expect(Object.keys(event.changes).sort()).toEqual(['maxGroupSize', 'scoring', 'timeZone']);
    expect(event.changes.maxGroupSize).toEqual({ from: 4, to: 3 });
    expect(event.data).toMatchObject({ roundId: rid, number: 1 });
  });

  it('does nothing, and leaves no event, when nothing really changes', async () => {
    const { tid, rid } = await oneRound();
    const usage = u();
    await updateRound(db, 'org1', { tournamentId: tid, roundId: rid, maxGroupSize: 4, course: course() }, usage);
    expect(await feedOf(tid, 'round_updated')).toHaveLength(0);
    expect(usage.docsWritten).toBe(0);
  });

  it('shows a course edit in the feed even when only hole data moved', async () => {
    const { tid, rid } = await oneRound();
    const edited = course();
    edited.holes[4].par = 3;
    const round = await updateRound(db, 'org1', { tournamentId: tid, roundId: rid, course: edited }, u());
    expect(round.course?.holes[4].par).toBe(3);
    const [event] = await feedOf(tid, 'round_updated');
    expect(event.changes.course.from.par).toBe(72);
    expect(event.changes.course.to.par).toBe(71);
    expect((await roundDoc(tid, rid))!.courseSource).toBe('manual');
  });

  it('clears the course with null', async () => {
    const { tid, rid } = await oneRound();
    const round = await updateRound(db, 'org1', { tournamentId: tid, roundId: rid, course: null }, u());
    expect(round.course).toBeNull();
    expect(round.courseSource).toBeNull();
  });

  it('refuses the course and the holes in play once a score exists, but still allows other changes', async () => {
    const { tid, rid } = await oneRound();
    await addScore(tid, rid);
    for (const change of [{ course: null }, { holesPlanned: 9 }, { skippedHoles: [3] }, { firstHole: 10, holesPlanned: 9 }]) {
      const err = await rejection(updateRound(db, 'org1', { tournamentId: tid, roundId: rid, ...change }, u()));
      expect(err.code, JSON.stringify(change)).toBe('failed-precondition');
      expect(err.message).toContain('score has been entered');
    }
    const ok = await updateRound(db, 'org1', { tournamentId: tid, roundId: rid, skins: { enabled: true, value: 5 } }, u());
    expect(ok.skins).toMatchObject({ enabled: true, value: 5 });
  });

  it('revalidates what depends on the holes played when they change', async () => {
    const { tid, rid } = await oneRound({ skippedHoles: [12] });
    // 18 -> 9 front nine leaves skipped hole 12 outside the range
    expect((await rejection(updateRound(db, 'org1', { tournamentId: tid, roundId: rid, holesPlanned: 9 }, u()))).code).toBe(
      'invalid-argument',
    );
    // changing both together is fine
    const round = await updateRound(db, 'org1', { tournamentId: tid, roundId: rid, holesPlanned: 9, skippedHoles: [] }, u());
    expect(round.holesPlanned).toBe(9);
    // a back nine needs an 18-hole course, which this round has
    const back = await updateRound(db, 'org1', { tournamentId: tid, roundId: rid, firstHole: 10 }, u());
    expect(back.firstHole).toBe(10);
  });

  it('refuses a change that would strand an existing group', async () => {
    const { tid, rid } = await oneRound();
    await setGroups(
      db,
      'org1',
      { tournamentId: tid, roundId: rid, groups: [{ playerIds: ['p1', 'p2', 'p3', 'p4'] }, { playerIds: ['p5'], teeHole: 14 }] },
      u(),
    );
    const small = await rejection(updateRound(db, 'org1', { tournamentId: tid, roundId: rid, maxGroupSize: 3 }, u()));
    expect(small.code).toBe('failed-precondition');
    expect(small.message).toContain('more than 3');
    const stranded = await rejection(updateRound(db, 'org1', { tournamentId: tid, roundId: rid, holesPlanned: 9 }, u()));
    expect(stranded.code).toBe('failed-precondition');
    expect(stranded.message).toContain('starts on hole 14');
  });

  it('moving the date outside the tournament follows the same agreement rule', async () => {
    const { tid, rid } = await oneRound();
    expect(
      (await rejection(updateRound(db, 'org1', { tournamentId: tid, roundId: rid, date: '2026-11-20' }, u()))).code,
    ).toBe('failed-precondition');
    await updateRound(db, 'org1', { tournamentId: tid, roundId: rid, date: '2026-11-20', extendTournamentDates: true }, u());
    expect((await tournamentDoc(tid)).endDate).toBe('2026-11-20');
  });

  it('refuses a non-admin, an unknown round, an empty change, unknown settings, and a cancelled round', async () => {
    const { tid, rid } = await oneRound();
    expect((await rejection(updateRound(db, 'p1', { tournamentId: tid, roundId: rid, maxGroupSize: 2 }, u()))).code).toBe(
      'permission-denied',
    );
    expect((await rejection(updateRound(db, 'org1', { tournamentId: tid, roundId: 'nope', maxGroupSize: 2 }, u()))).code).toBe(
      'not-found',
    );
    expect((await rejection(updateRound(db, 'org1', { tournamentId: tid, roundId: rid }, u()))).code).toBe('invalid-argument');
    expect(
      (await rejection(updateRound(db, 'org1', { tournamentId: tid, roundId: rid, status: 'finalized' } as never, u()))).code,
    ).toBe('invalid-argument');
    await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).update({ status: 'cancelled' });
    expect((await rejection(updateRound(db, 'org1', { tournamentId: tid, roundId: rid, maxGroupSize: 2 }, u()))).code).toBe(
      'failed-precondition',
    );
  });
});

describe('setGroups', () => {
  async function oneRound(extra: Record<string, unknown> = {}) {
    const { tid } = await setup();
    const round = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14', ...extra }, u());
    return { tid, rid: round.id };
  }
  const call = (tid: string, rid: string, groups: unknown[], uid = 'org1', usage = u()) =>
    setGroups(db, uid, { tournamentId: tid, roundId: rid, groups: groups as never }, usage);

  it('creates groups of different sizes in the order given', async () => {
    const { tid, rid } = await oneRound();
    const usage = u();
    const { groups } = await call(tid, rid, [{ playerIds: ['p1', 'p2', 'p3', 'p4'] }, { playerIds: ['p5', 'p6'] }], 'org1', usage);

    expect(groups.map((g) => [g.order, g.playerIds.length, g.teeHole, g.teeTime])).toEqual([
      [1, 4, 1, null],
      [2, 2, 1, null],
    ]);
    const stored = await groupDocs(tid, rid);
    expect(stored.map((g) => g.id)).toEqual(groups.map((g) => g.id));
    expect(stored[0].createdAt).toBeDefined();
    expect(usage.docsWritten).toBe(3); // two groups and the feed event
    const [event] = await feedOf(tid, 'groups_changed');
    expect(event).toMatchObject({ category: 'changes', level: 'admins' });
    expect(event.data).toMatchObject({ groups: 2, added: 2, changed: 0, removed: 0 });
  });

  it('stores tee times as exact instants and a shotgun starting hole', async () => {
    const { tid, rid } = await oneRound();
    const { groups } = await call(tid, rid, [
      { playerIds: ['p1', 'p2'], teeTime: '2026-11-14T13:30:00-06:00', teeHole: 5 },
    ]);
    expect(groups[0]).toMatchObject({ teeTime: '2026-11-14T19:30:00.000Z', teeHole: 5 });
    const [stored] = await groupDocs(tid, rid);
    expect(stored.teeTime.toMillis()).toBe(Date.parse('2026-11-14T19:30:00Z'));
  });

  it('is a no-op, with no event and no writes, when the same groups are sent again', async () => {
    const { tid, rid } = await oneRound();
    const first = await call(tid, rid, [{ playerIds: ['p1', 'p2'], teeTime: '2026-11-14T13:30:00-06:00' }, { playerIds: ['p3'] }]);
    const usage = u();
    const again = await call(
      tid,
      rid,
      first.groups.map((g) => ({ id: g.id, playerIds: g.playerIds, teeTime: g.teeTime, teeHole: g.teeHole })),
      'org1',
      usage,
    );
    expect(again.groups.map((g) => g.id)).toEqual(first.groups.map((g) => g.id));
    expect(usage.docsWritten).toBe(0);
    expect(await feedOf(tid, 'groups_changed')).toHaveLength(1);
  });

  it('keeps the id of a group sent with its id, changes it, adds new groups and removes ones left out', async () => {
    const { tid, rid } = await oneRound();
    const first = await call(tid, rid, [{ playerIds: ['p1', 'p2'] }, { playerIds: ['p3', 'p4'] }, { playerIds: ['p5'] }]);
    const [a, b] = first.groups;
    const second = await call(tid, rid, [
      { id: b.id, playerIds: ['p3', 'p4', 'p6'] },
      { id: a.id, playerIds: ['p1', 'p2'] },
      { playerIds: ['p5'] },
    ]);
    expect(second.groups.slice(0, 2).map((g) => g.id)).toEqual([b.id, a.id]);
    expect(second.groups[2].id).not.toBe(first.groups[2].id);
    const events = (await feedOf(tid, 'groups_changed')).map((e) => e.data);
    const latest = events.find((d) => d.removed === 1)!;
    expect(latest).toMatchObject({ added: 1, removed: 1, changed: 2 }); // b gained a player; a only moved to order 2
    expect(await groupDocs(tid, rid)).toHaveLength(3);
    // an empty list removes every group
    await call(tid, rid, []);
    expect(await groupDocs(tid, rid)).toHaveLength(0);
  });

  it('tells everyone when a tee time that was already set moves, but not when it is first set', async () => {
    const { tid, rid } = await oneRound();
    const first = await call(tid, rid, [{ playerIds: ['p1', 'p2'] }]);
    const gid = first.groups[0].id;
    await call(tid, rid, [{ id: gid, playerIds: ['p1', 'p2'], teeTime: '2026-11-14T13:30:00-06:00' }]);
    expect(await feedOf(tid, 'tee_time_changed')).toHaveLength(0);

    await call(tid, rid, [{ id: gid, playerIds: ['p1', 'p2'], teeTime: '2026-11-14T14:00:00-06:00' }]);
    const [event] = await feedOf(tid, 'tee_time_changed');
    expect(event).toMatchObject({ category: 'essentials', level: 'all' });
    expect(event.data.groups[0]).toMatchObject({
      groupId: gid,
      from: '2026-11-14T19:30:00.000Z',
      to: '2026-11-14T20:00:00.000Z',
      playerIds: ['p1', 'p2'],
    });

    // taking the tee time away also counts as a change players should see
    await call(tid, rid, [{ id: gid, playerIds: ['p1', 'p2'] }]);
    expect(await feedOf(tid, 'tee_time_changed')).toHaveLength(2);
  });

  it('saves sides for match play', async () => {
    const { tid, rid } = await oneRound();
    const sides = [{ playerIds: ['p1', 'p2'] }, { playerIds: ['p3', 'p4'] }];
    const { groups } = await call(tid, rid, [{ playerIds: ['p1', 'p2', 'p3', 'p4'], sides }]);
    expect(groups[0].sides).toEqual(sides);
    expect((await groupDocs(tid, rid))[0].sides).toEqual(sides);
  });

  it('refuses a player who is not on the roster, or who was removed, and changes nothing', async () => {
    const { tid, rid } = await oneRound();
    await call(tid, rid, [{ playerIds: ['p1'] }]);
    const stranger = await rejection(call(tid, rid, [{ playerIds: ['p1', 'nobody'] }]));
    expect(stranger.code).toBe('failed-precondition');
    expect(stranger.message).toContain('roster');

    await startTournament(db, 'org1', { tournamentId: tid }, u());
    await removePlayer(db, 'org1', { tournamentId: tid, playerId: 'p2' }, u()); // after Start: marked withdrawn
    const withdrawn = await rejection(call(tid, rid, [{ playerIds: ['p1', 'p2'] }]));
    expect(withdrawn.code).toBe('failed-precondition');
    expect(withdrawn.message).toContain('removed');
    expect((await groupDocs(tid, rid)).map((g) => g.playerIds)).toEqual([['p1']]);
  });

  it('refuses a group that is too big for the round, and a starting hole that is out of play', async () => {
    const { tid, rid } = await oneRound({ maxGroupSize: 2, skippedHoles: [7] });
    expect((await rejection(call(tid, rid, [{ playerIds: ['p1', 'p2', 'p3'] }]))).code).toBe('invalid-argument');
    expect((await rejection(call(tid, rid, [{ playerIds: ['p1'], teeHole: 7 }]))).code).toBe('invalid-argument');
    expect((await rejection(call(tid, rid, [{ playerIds: ['p1'], teeHole: 19 }]))).code).toBe('invalid-argument');
  });

  it('starts a back-nine round on hole 10', async () => {
    const { tid, rid } = await oneRound({ holesPlanned: 9, firstHole: 10, course: course(18) });
    const { groups } = await call(tid, rid, [{ playerIds: ['p1'] }, { playerIds: ['p2'], teeHole: 14 }]);
    expect(groups.map((g) => g.teeHole)).toEqual([10, 14]);
    expect((await rejection(call(tid, rid, [{ playerIds: ['p1'], teeHole: 1 }]))).code).toBe('invalid-argument');
  });

  it('rejects an id that does not belong to the round, a non-list, a non-admin, and an unknown round', async () => {
    const { tid, rid } = await oneRound();
    expect((await rejection(call(tid, rid, [{ id: 'made-up', playerIds: ['p1'] }]))).code).toBe('invalid-argument');
    expect((await rejection(setGroups(db, 'org1', { tournamentId: tid, roundId: rid } as never, u()))).code).toBe('invalid-argument');
    expect((await rejection(call(tid, rid, [{ playerIds: ['p1'] }], 'p1'))).code).toBe('permission-denied');
    expect((await rejection(call(tid, 'nope', [{ playerIds: ['p1'] }]))).code).toBe('not-found');
  });

  it('refuses to change the groups of a round that is cancelled', async () => {
    const { tid, rid } = await oneRound();
    await db.collection('tournaments').doc(tid).collection('rounds').doc(rid).update({ status: 'cancelled' });
    expect((await rejection(call(tid, rid, [{ playerIds: ['p1'] }]))).code).toBe('failed-precondition');
  });

  it('announces group changes to everyone once the tournament has started', async () => {
    const { tid, rid } = await oneRound();
    await startTournament(db, 'org1', { tournamentId: tid }, u());
    await call(tid, rid, [{ playerIds: ['p1'] }]);
    const [event] = await feedOf(tid, 'groups_changed');
    expect(event.level).toBe('all');
  });
});
