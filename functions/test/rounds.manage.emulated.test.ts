import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setGroups } from '../src/groups';
import { joinTournament } from '../src/roster';
import { createRound, deleteRound, updateRound } from '../src/rounds';
import { updateTournament } from '../src/tournamentAdmin';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.
// Round names, deleteRound, and the rule that tournament dates keep including every round.

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-rounds-manage' }, 'rounds-manage-test'));
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

async function setup() {
  const t = await createTournament(db, 'org1', { name: 'Manage Cup', startDate: '2026-11-13', endDate: '2026-11-15' }, u());
  for (const p of ['p1', 'p2']) await joinTournament(db, p, { inviteCode: t.inviteCode }, u());
  return { tid: t.id };
}

const roundRef = (tid: string, rid: string) => db.collection('tournaments').doc(tid).collection('rounds').doc(rid);
const tournamentData = async (tid: string) => (await db.collection('tournaments').doc(tid).get()).data()!;
async function feedOf(tid: string, type: string) {
  const snap = await db.collection('tournaments').doc(tid).collection('activity').where('type', '==', type).get();
  return snap.docs.map((d) => d.data());
}

describe('round names', () => {
  it('stores a trimmed name, and no name means null', async () => {
    const { tid } = await setup();
    const named = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14', name: '  Practice  ' }, u());
    const plain = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u());
    const blank = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14', name: '   ' }, u());
    expect([named.name, plain.name, blank.name]).toEqual(['Practice', null, null]);
    expect((await roundRef(tid, named.id).get()).data()!.name).toBe('Practice');
  });

  it('refuses a name that is too long, not text, or has control characters', async () => {
    const { tid } = await setup();
    for (const name of ['x'.repeat(41), 7, 'tab\there']) {
      const err = await rejection(createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14', name: name as never }, u()));
      expect(err.code).toBe('invalid-argument');
    }
  });

  it('renames and clears a name, and a repeat of the same name leaves no feed event', async () => {
    const { tid } = await setup();
    const round = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u());
    await updateRound(db, 'org1', { tournamentId: tid, roundId: round.id, name: 'Friday AM' }, u());
    expect((await roundRef(tid, round.id).get()).data()!.name).toBe('Friday AM');
    await updateRound(db, 'org1', { tournamentId: tid, roundId: round.id, name: 'Friday AM' }, u());
    const events = await feedOf(tid, 'round_updated');
    expect(events).toHaveLength(1);
    expect(events[0].changes.name).toEqual({ from: null, to: 'Friday AM' });

    const cleared = await updateRound(db, 'org1', { tournamentId: tid, roundId: round.id, name: null }, u());
    expect(cleared.name).toBeNull();
    expect((await roundRef(tid, round.id).get()).data()!.name).toBeNull();
  });

  it('a round added later for an earlier day keeps its own number, and nothing else is renumbered', async () => {
    const { tid } = await setup();
    const a = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-15' }, u());
    const b = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-13' }, u());
    expect([a.number, b.number]).toEqual([1, 2]);
    expect((await roundRef(tid, a.id).get()).data()!.number).toBe(1);
  });
});

describe('deleteRound', () => {
  it('removes the round and its groups, and tells everyone because the groups had been published', async () => {
    const { tid } = await setup();
    const round = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u());
    await setGroups(db, 'org1', { tournamentId: tid, roundId: round.id, groups: [{ playerIds: ['p1', 'p2'] }] as never }, u());
    const usage = u();
    const result = await deleteRound(db, 'org1', { tournamentId: tid, roundId: round.id }, usage);

    expect(result).toEqual({ roundId: round.id, deleted: true });
    expect((await roundRef(tid, round.id).get()).exists).toBe(false);
    expect((await roundRef(tid, round.id).collection('groups').get()).empty).toBe(true);
    const [event] = await feedOf(tid, 'round_deleted');
    expect(event).toMatchObject({ level: 'all', category: 'changes', data: { roundId: round.id, number: 1, date: '2026-11-14' } });
    expect(usage.docsWritten).toBe(3); // one group, the round, the feed event
  });

  it('an empty round before Start is announced to admins only', async () => {
    const { tid } = await setup();
    const round = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u());
    await deleteRound(db, 'org1', { tournamentId: tid, roundId: round.id }, u());
    expect((await feedOf(tid, 'round_deleted'))[0].level).toBe('admins');
  });

  it('refuses a round with a score, one that is no longer scheduled, a non-admin, and an unknown round', async () => {
    const { tid } = await setup();
    const scored = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u());
    await roundRef(tid, scored.id).collection('scores').doc('s1').set({ hole: 1 });
    expect((await rejection(deleteRound(db, 'org1', { tournamentId: tid, roundId: scored.id }, u()))).code).toBe('failed-precondition');

    const live = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u());
    await roundRef(tid, live.id).update({ status: 'live' });
    const err = await rejection(deleteRound(db, 'org1', { tournamentId: tid, roundId: live.id }, u()));
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toContain('live');

    const plain = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u());
    expect((await rejection(deleteRound(db, 'p1', { tournamentId: tid, roundId: plain.id }, u()))).code).toBe('permission-denied');
    expect((await rejection(deleteRound(db, 'org1', { tournamentId: tid, roundId: 'nope' }, u()))).code).toBe('not-found');
    expect((await roundRef(tid, plain.id).get()).exists).toBe(true);
    expect((await roundRef(tid, scored.id).get()).exists).toBe(true);
  });

  it('a second delete of the same round reports not-found and changes nothing', async () => {
    const { tid } = await setup();
    const round = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u());
    await deleteRound(db, 'org1', { tournamentId: tid, roundId: round.id }, u());
    expect((await rejection(deleteRound(db, 'org1', { tournamentId: tid, roundId: round.id }, u()))).code).toBe('not-found');
    expect(await feedOf(tid, 'round_deleted')).toHaveLength(1);
  });
});

describe('tournament dates keep including every round', () => {
  it('refuses to narrow the dates past a round, naming it, and allows it once the round is deleted', async () => {
    const { tid } = await setup();
    const late = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-25', extendTournamentDates: true }, u());
    expect((await tournamentData(tid)).endDate).toBe('2026-11-25');

    const err = await rejection(updateTournament(db, 'org1', { tournamentId: tid, endDate: '2026-11-15' }, u()));
    expect(err.code).toBe('failed-precondition');
    expect(err.message).toContain('Round 1');
    expect(err.message).toContain('2026-11-25');
    expect((await tournamentData(tid)).endDate).toBe('2026-11-25');

    await deleteRound(db, 'org1', { tournamentId: tid, roundId: late.id }, u());
    await updateTournament(db, 'org1', { tournamentId: tid, endDate: '2026-11-15' }, u());
    expect((await tournamentData(tid)).endDate).toBe('2026-11-15');
  });

  it('names a named round by its name, and a start date after a round is refused too', async () => {
    const { tid } = await setup();
    await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-13', name: 'Practice' }, u());
    const err = await rejection(updateTournament(db, 'org1', { tournamentId: tid, startDate: '2026-11-14' }, u()));
    expect(err.message).toContain('"Practice"');
  });

  it('allows a change that still includes every round, an unrelated edit, and clearing a date', async () => {
    const { tid } = await setup();
    await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-14' }, u());
    await updateTournament(db, 'org1', { tournamentId: tid, startDate: '2026-11-14', endDate: '2026-11-14' }, u());
    await updateTournament(db, 'org1', { tournamentId: tid, name: 'Renamed' }, u());
    await updateTournament(db, 'org1', { tournamentId: tid, endDate: null }, u());
    expect(await tournamentData(tid)).toMatchObject({ name: 'Renamed', endDate: null });
  });

  it('moving the round back inside the dates also makes narrowing possible', async () => {
    const { tid } = await setup();
    const round = await createRound(db, 'org1', { tournamentId: tid, date: '2026-11-25', extendTournamentDates: true }, u());
    await updateRound(db, 'org1', { tournamentId: tid, roundId: round.id, date: '2026-11-14' }, u());
    await updateTournament(db, 'org1', { tournamentId: tid, endDate: '2026-11-15' }, u());
    expect((await tournamentData(tid)).endDate).toBe('2026-11-15');
  });
});
