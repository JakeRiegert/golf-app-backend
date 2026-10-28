import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Run through `npm run test:rules`, which starts the Firestore emulator around vitest.
// Seed users: org = organizer, co = co-admin (NOT on the roster), mem = roster member,
// stranger = signed in but unrelated, alice = a profile owner.

let env: RulesTestEnvironment;

const rulesPath = fileURLToPath(new URL('../../firestore.rules', import.meta.url));

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-golf-rules',
    firestore: { rules: readFileSync(rulesPath, 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const tournament = (extra: Record<string, unknown>) => ({
      name: 'T',
      organizerId: 'org',
      coAdminId: 'co',
      visibility: 'private',
      status: 'active',
      ...extra,
    });

    // t1: private + active, with roster/teams/private settings.
    // t2: public + active.  t3: private + suspended.  t4: public + suspended.
    const seeds: [string, Record<string, unknown>][] = [
      ['t1', tournament({})],
      ['t2', tournament({ visibility: 'public' })],
      ['t3', tournament({ status: 'suspended' })],
      ['t4', tournament({ visibility: 'public', status: 'suspended' })],
    ];
    for (const [tid, data] of seeds) {
      await setDoc(doc(db, 'tournaments', tid), data);
      await setDoc(doc(db, 'tournaments', tid, 'players', 'mem'), { playerId: 'mem', teamId: null });
      await setDoc(doc(db, 'tournaments', tid, 'teams', 'tm1'), { name: 'Red' });
      await setDoc(doc(db, 'tournaments', tid, 'private', 'settings'), { inviteCode: 'ABC12345' });
      // Activity feed: one event per level, and a player-level event about someone else.
      const event = (level: string, targetPlayerId: string | null) => ({ type: 'x', actorId: 'org', level, targetPlayerId });
      await setDoc(doc(db, 'tournaments', tid, 'activity', 'a-all'), event('all', null));
      await setDoc(doc(db, 'tournaments', tid, 'activity', 'a-about-mem'), event('affected', 'mem'));
      await setDoc(doc(db, 'tournaments', tid, 'activity', 'a-about-other'), event('affected', 'other'));
      await setDoc(doc(db, 'tournaments', tid, 'activity', 'a-admins'), event('admins', 'mem'));
    }

    await setDoc(doc(db, 'players', 'alice'), { displayName: 'Alice' });
    await setDoc(doc(db, 'players', 'alice', 'private', 'profile'), { email: 'alice@example.com' });
    await setDoc(doc(db, 'inviteCodes', 'ABC12345'), { tournamentId: 't1' });
  });
});

const as = (uid: string) => env.authenticatedContext(uid).firestore();
const anon = () => env.unauthenticatedContext().firestore();

describe('signed-out users', () => {
  it('can read nothing', async () => {
    await assertFails(getDoc(doc(anon(), 'tournaments', 't2')));
    await assertFails(getDoc(doc(anon(), 'players', 'alice')));
    await assertFails(getDocs(collection(anon(), 'tournaments', 't2', 'players')));
  });
});

describe('private tournament (t1)', () => {
  it('a stranger cannot read the tournament, roster, teams, or settings', async () => {
    const db = as('stranger');
    await assertFails(getDoc(doc(db, 'tournaments', 't1')));
    await assertFails(getDocs(collection(db, 'tournaments', 't1', 'players')));
    await assertFails(getDocs(collection(db, 'tournaments', 't1', 'teams')));
    await assertFails(getDoc(doc(db, 'tournaments', 't1', 'private', 'settings')));
  });

  it('a roster member can read everything, including the invite code', async () => {
    const db = as('mem');
    await assertSucceeds(getDoc(doc(db, 'tournaments', 't1')));
    await assertSucceeds(getDocs(collection(db, 'tournaments', 't1', 'players')));
    await assertSucceeds(getDocs(collection(db, 'tournaments', 't1', 'teams')));
    await assertSucceeds(getDoc(doc(db, 'tournaments', 't1', 'private', 'settings')));
  });

  it('the organizer and a co-admin who is not on the roster can read everything', async () => {
    for (const uid of ['org', 'co']) {
      const db = as(uid);
      await assertSucceeds(getDoc(doc(db, 'tournaments', 't1')));
      await assertSucceeds(getDocs(collection(db, 'tournaments', 't1', 'players')));
      await assertSucceeds(getDoc(doc(db, 'tournaments', 't1', 'private', 'settings')));
    }
  });
});

describe('public tournament (t2): spectating', () => {
  it('a stranger can read the tournament, roster, and teams', async () => {
    const db = as('stranger');
    await assertSucceeds(getDoc(doc(db, 'tournaments', 't2')));
    await assertSucceeds(getDocs(collection(db, 'tournaments', 't2', 'players')));
    await assertSucceeds(getDocs(collection(db, 'tournaments', 't2', 'teams')));
  });

  it('a stranger can never read the invite code', async () => {
    await assertFails(getDoc(doc(as('stranger'), 'tournaments', 't2', 'private', 'settings')));
  });
});

describe('suspended tournaments', () => {
  it('members and spectators are blocked; admins still get in', async () => {
    await assertFails(getDoc(doc(as('mem'), 'tournaments', 't3')));
    await assertFails(getDocs(collection(as('mem'), 'tournaments', 't3', 'players')));
    await assertFails(getDoc(doc(as('mem'), 'tournaments', 't3', 'private', 'settings')));
    await assertFails(getDoc(doc(as('stranger'), 'tournaments', 't4')));

    await assertSucceeds(getDoc(doc(as('org'), 'tournaments', 't3')));
    await assertSucceeds(getDocs(collection(as('co'), 'tournaments', 't4', 'players')));
  });
});

describe('player profiles', () => {
  it('any signed-in user can read a public profile', async () => {
    await assertSucceeds(getDoc(doc(as('stranger'), 'players', 'alice')));
  });

  it('only the owner can read the private profile (email)', async () => {
    await assertSucceeds(getDoc(doc(as('alice'), 'players', 'alice', 'private', 'profile')));
    await assertFails(getDoc(doc(as('stranger'), 'players', 'alice', 'private', 'profile')));
  });
});

describe('server-only data', () => {
  it('no client can read the invite-code lookup', async () => {
    await assertFails(getDoc(doc(as('org'), 'inviteCodes', 'ABC12345')));
    await assertFails(getDoc(doc(as('stranger'), 'inviteCodes', 'ABC12345')));
  });
});

describe('client writes are always denied (all writes go through functions)', () => {
  it('denies create, update, and delete everywhere, even for the organizer', async () => {
    const db = as('org');
    await assertFails(setDoc(doc(db, 'tournaments', 'new'), { name: 'x' }));
    await assertFails(updateDoc(doc(db, 'tournaments', 't1'), { name: 'renamed' }));
    await assertFails(deleteDoc(doc(db, 'tournaments', 't1')));
    await assertFails(setDoc(doc(db, 'tournaments', 't1', 'players', 'org'), { playerId: 'org' }));
    await assertFails(updateDoc(doc(db, 'tournaments', 't1', 'teams', 'tm1'), { name: 'Blue' }));
    await assertFails(setDoc(doc(db, 'tournaments', 't1', 'private', 'settings'), { inviteCode: 'X' }));
    await assertFails(setDoc(doc(db, 'inviteCodes', 'NEWCODE'), { tournamentId: 't1' }));
  });

  it('denies a user writing their own profile', async () => {
    const db = as('alice');
    await assertFails(updateDoc(doc(db, 'players', 'alice'), { displayName: 'Hacked' }));
    await assertFails(setDoc(doc(db, 'players', 'alice', 'private', 'profile'), { email: 'x@y.z' }));
  });
});

describe('my tournaments (collection-group query on roster entries)', () => {
  const mine = (db: ReturnType<typeof as>, uid: string) =>
    getDocs(query(collectionGroup(db, 'players'), where('playerId', '==', uid)));

  it('a player can list their own roster entries across tournaments, including suspended ones', async () => {
    const snap = await assertSucceeds(mine(as('mem'), 'mem'));
    expect(snap.docs.map((d) => d.ref.parent.parent?.id).sort()).toEqual(['t1', 't2', 't3', 't4']);
  });

  it("cannot list someone else's entries", async () => {
    await assertFails(mine(as('stranger'), 'mem'));
  });

  it('cannot list every roster entry by omitting the filter', async () => {
    await assertFails(getDocs(collectionGroup(as('mem'), 'players')));
  });

  it('a signed-out user cannot list anything', async () => {
    await assertFails(mine(anon(), 'mem'));
  });

  it("does not widen anything else: other players' entries and private profiles stay closed", async () => {
    await assertFails(getDoc(doc(as('stranger'), 'tournaments', 't1', 'players', 'mem')));
    await assertSucceeds(getDoc(doc(as('mem'), 'tournaments', 't3', 'players', 'mem')));
    await assertFails(getDoc(doc(as('stranger'), 'players', 'alice', 'private', 'profile')));
  });
});

describe('activity feed', () => {
  const feed = (db: ReturnType<typeof as>, tid = 't1') => collection(db, 'tournaments', tid, 'activity');

  it('admins read everything, including admins-only events, even the co-admin who is not on the roster', async () => {
    for (const uid of ['org', 'co']) {
      const snap = await assertSucceeds(getDocs(feed(as(uid))));
      expect(snap.docs.map((d) => d.id).sort()).toEqual(['a-about-mem', 'a-about-other', 'a-admins', 'a-all']);
    }
  });

  it('a member reads events for everyone and events about themselves, when they ask with the matching filters', async () => {
    const db = as('mem');
    const everyone = await assertSucceeds(getDocs(query(feed(db), where('level', '==', 'all'))));
    expect(everyone.docs.map((d) => d.id)).toEqual(['a-all']);
    const aboutMe = await assertSucceeds(
      getDocs(query(feed(db), where('level', '==', 'affected'), where('targetPlayerId', '==', 'mem'))),
    );
    expect(aboutMe.docs.map((d) => d.id)).toEqual(['a-about-mem']);
    await assertSucceeds(getDoc(doc(db, 'tournaments', 't1', 'activity', 'a-all')));
    await assertSucceeds(getDoc(doc(db, 'tournaments', 't1', 'activity', 'a-about-mem')));
  });

  it('a member cannot read admins-only events, events about others, or list without filters', async () => {
    const db = as('mem');
    await assertFails(getDoc(doc(db, 'tournaments', 't1', 'activity', 'a-admins')));
    await assertFails(getDoc(doc(db, 'tournaments', 't1', 'activity', 'a-about-other')));
    await assertFails(getDocs(feed(db)));
    await assertFails(getDocs(query(feed(db), where('level', '==', 'affected')))); // would include others
    await assertFails(getDocs(query(feed(db), where('targetPlayerId', '==', 'mem')))); // would include admins-only
    await assertFails(getDocs(query(feed(db), where('level', '==', 'admins'))));
  });

  it('strangers, spectators of a public tournament and signed-out users read nothing', async () => {
    await assertFails(getDocs(query(feed(as('stranger')), where('level', '==', 'all'))));
    await assertFails(getDocs(query(feed(as('stranger'), 't2'), where('level', '==', 'all')))); // public: still no feed
    await assertFails(getDoc(doc(as('stranger'), 'tournaments', 't2', 'activity', 'a-all')));
    await assertFails(getDocs(query(feed(anon()), where('level', '==', 'all'))));
  });

  it('members are blocked while the tournament is suspended; admins still read', async () => {
    await assertFails(getDocs(query(feed(as('mem'), 't3'), where('level', '==', 'all'))));
    await assertSucceeds(getDocs(feed(as('org'), 't3')));
  });

  it('nobody can write, edit or delete events from a client', async () => {
    for (const uid of ['org', 'co', 'mem', 'stranger']) {
      const db = as(uid);
      await assertFails(setDoc(doc(db, 'tournaments', 't1', 'activity', 'new'), { level: 'all' }));
      await assertFails(updateDoc(doc(db, 'tournaments', 't1', 'activity', 'a-all'), { level: 'admins' }));
      await assertFails(deleteDoc(doc(db, 'tournaments', 't1', 'activity', 'a-all')));
    }
  });
});
