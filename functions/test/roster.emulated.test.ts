import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { joinTournament } from '../src/roster';
import { createTournament } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-roster' }, 'roster-test'));
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection('tournaments'));
  await db.recursiveDelete(db.collection('inviteCodes'));
});

async function rejection(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (err) {
    return err as HttpsError;
  }
  throw new Error('expected the call to be rejected');
}

async function newTournament() {
  return createTournament(db, 'org1', { name: 'Join Me' }, new UsageTracker());
}

async function rosterIds(tid: string) {
  return (await db.collection('tournaments').doc(tid).collection('players').get()).docs.map((d) => d.id).sort();
}

describe('joinTournament', () => {
  it('adds the caller to the roster with a join time and no team', async () => {
    const t = await newTournament();
    const usage = new UsageTracker();
    const result = await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, usage);

    expect(result).toEqual({ tournamentId: t.id, name: 'Join Me', alreadyMember: false });
    expect(await rosterIds(t.id)).toEqual(['org1', 'p1']);
    const entry = (await db.collection('tournaments').doc(t.id).collection('players').doc('p1').get()).data();
    expect(entry).toMatchObject({ playerId: 'p1', teamId: null, handicap: null });
    expect(entry?.joinedAt).toBeDefined();
    expect(usage.tournamentId).toBe(t.id);
    expect(usage.docsWritten).toBe(1);
  });

  it('is idempotent: joining twice does not duplicate or move joinedAt', async () => {
    const t = await newTournament();
    await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, new UsageTracker());
    const ref = db.collection('tournaments').doc(t.id).collection('players').doc('p1');
    const first = (await ref.get()).data();

    const usage = new UsageTracker();
    const again = await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, usage);

    expect(again.alreadyMember).toBe(true);
    expect(usage.docsWritten).toBe(0);
    expect(await rosterIds(t.id)).toEqual(['org1', 'p1']);
    expect((await ref.get()).data()?.joinedAt.isEqual(first?.joinedAt)).toBe(true);
  });

  it('treats the organizer joining their own tournament as already a member', async () => {
    const t = await newTournament();
    const result = await joinTournament(db, 'org1', { inviteCode: t.inviteCode }, new UsageTracker());
    expect(result.alreadyMember).toBe(true);
    expect(await rosterIds(t.id)).toEqual(['org1']);
  });

  it('accepts a code typed in lower case with spaces around it', async () => {
    const t = await newTournament();
    const typed = `  ${t.inviteCode.toLowerCase()} `;
    const result = await joinTournament(db, 'p1', { inviteCode: typed }, new UsageTracker());
    expect(result.tournamentId).toBe(t.id);
  });

  it('rejects an unknown code with not-found, and codes that cannot be IDs', async () => {
    for (const code of ['NOSUCH99', 'a/b', '../x', 'x'.repeat(200)]) {
      const err = await rejection(joinTournament(db, 'p1', { inviteCode: code }, new UsageTracker()));
      expect(err.code).toBe('not-found');
    }
  });

  it.each([[{}], [{ inviteCode: '   ' }], [{ inviteCode: 42 }]])('rejects a missing or blank code (%j)', async (input) => {
    const err = await rejection(joinTournament(db, 'p1', input as never, new UsageTracker()));
    expect(err.code).toBe('invalid-argument');
  });

  it('rejects joining a suspended tournament', async () => {
    const t = await newTournament();
    await db.collection('tournaments').doc(t.id).update({ status: 'suspended' });
    const err = await rejection(joinTournament(db, 'p1', { inviteCode: t.inviteCode }, new UsageTracker()));
    expect(err.code).toBe('failed-precondition');
    expect(await rosterIds(t.id)).toEqual(['org1']);
  });

  it('rejects a new player when the roster is full, but still lets existing members through', async () => {
    const t = await newTournament(); // roster: org1
    await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, new UsageTracker(), 2); // org1, p1: full

    const err = await rejection(joinTournament(db, 'p2', { inviteCode: t.inviteCode }, new UsageTracker(), 2));
    expect(err.code).toBe('resource-exhausted');
    expect(await rosterIds(t.id)).toEqual(['org1', 'p1']);

    const existing = await joinTournament(db, 'p1', { inviteCode: t.inviteCode }, new UsageTracker(), 2);
    expect(existing.alreadyMember).toBe(true);
  });

  it('does not overfill when many players join at once', async () => {
    const t = await newTournament(); // roster: org1; a cap of 4 leaves 3 seats
    const attempts = ['a', 'b', 'c', 'd', 'e', 'f'].map((uid) =>
      joinTournament(db, uid, { inviteCode: t.inviteCode }, new UsageTracker(), 4).then(
        () => 'joined',
        (err: HttpsError) => err.code,
      ),
    );
    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter((o) => o === 'joined')).toHaveLength(3);
    expect(outcomes.filter((o) => o === 'resource-exhausted')).toHaveLength(3);
    expect(await rosterIds(t.id)).toHaveLength(4);
  });
});
