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
      // A round with a group, plus the round-level collections that later steps will open one at a time.
      const round = doc(db, 'tournaments', tid, 'rounds', 'r1');
      await setDoc(round, { number: 1, status: 'scheduled' });
      await setDoc(doc(round, 'groups', 'g1'), { order: 1, playerIds: ['mem'], teeHole: 1 });
      for (const [sub, id] of [['scores', 's1'], ['disputes', 'd1'], ['cards', 'c1']]) {
        await setDoc(doc(round, sub, id), { playerId: 'mem', hole: 1 });
      }
      await setDoc(doc(round, 'submissions', 'sub1'), { playerId: 'mem', hole: 1, strokes: 4, enteredBy: 'mem' });
      await setDoc(doc(round, 'submissions', 'sub-other'), { playerId: 'mem', hole: 2, strokes: 5, enteredBy: 'other' });
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

describe('rounds and groups', () => {
  const round = (tid: string, ...rest: string[]) => ['tournaments', tid, 'rounds', 'r1', ...rest] as const;

  it('a roster member, the organizer and a co-admin can read rounds and groups', async () => {
    for (const uid of ['mem', 'org', 'co']) {
      const db = as(uid);
      await assertSucceeds(getDoc(doc(db, ...round('t1'))));
      await assertSucceeds(getDocs(collection(db, 'tournaments', 't1', 'rounds')));
      await assertSucceeds(getDoc(doc(db, ...round('t1', 'groups', 'g1'))));
      await assertSucceeds(getDocs(collection(db, ...round('t1', 'groups'))));
    }
  });

  it('a stranger cannot read the rounds or groups of a private tournament, and a signed-out user nothing', async () => {
    await assertFails(getDoc(doc(as('stranger'), ...round('t1'))));
    await assertFails(getDocs(collection(as('stranger'), 'tournaments', 't1', 'rounds')));
    await assertFails(getDoc(doc(as('stranger'), ...round('t1', 'groups', 'g1'))));
    await assertFails(getDoc(doc(anon(), ...round('t2'))));
    await assertFails(getDocs(collection(anon(), ...round('t2', 'groups'))));
  });

  it('spectators of a public tournament can read rounds and groups', async () => {
    await assertSucceeds(getDoc(doc(as('stranger'), ...round('t2'))));
    await assertSucceeds(getDocs(collection(as('stranger'), 'tournaments', 't2', 'rounds')));
    await assertSucceeds(getDoc(doc(as('stranger'), ...round('t2', 'groups', 'g1'))));
  });

  it('a suspended tournament hides them from members; admins still see them', async () => {
    await assertFails(getDoc(doc(as('mem'), ...round('t3'))));
    await assertFails(getDoc(doc(as('stranger'), ...round('t4', 'groups', 'g1'))));
    await assertSucceeds(getDoc(doc(as('org'), ...round('t3'))));
  });

  it('nobody can write them from a client, not even the organizer', async () => {
    const db = as('org');
    await assertFails(setDoc(doc(db, 'tournaments', 't1', 'rounds', 'new'), { number: 2 }));
    await assertFails(updateDoc(doc(db, ...round('t1')), { status: 'finalized' }));
    await assertFails(deleteDoc(doc(db, ...round('t1'))));
    await assertFails(setDoc(doc(db, ...round('t1', 'groups', 'new')), { playerIds: ['org'] }));
    await assertFails(updateDoc(doc(db, ...round('t1', 'groups', 'g1')), { playerIds: ['mem', 'org'] }));
    await assertFails(deleteDoc(doc(db, ...round('t1', 'groups', 'g1'))));
  });
});

// Disputes and the derived cards and standings do not exist as readable data yet. Each is opened by the
// build step that creates it, with its own allow and deny tests; until then no client can read or write any
// of them, whoever they are. (When one opens, move its lines out of this test.)
describe('round data that is not opened yet', () => {
  it('is closed to everyone: admins, members, spectators and strangers', async () => {
    for (const sub of [['disputes', 'd1'], ['cards', 'c1']]) {
      for (const uid of ['org', 'co', 'mem', 'stranger']) {
        const db = as(uid);
        await assertFails(getDoc(doc(db, 'tournaments', 't2', 'rounds', 'r1', sub[0], sub[1])));
        await assertFails(getDocs(collection(db, 'tournaments', 't2', 'rounds', 'r1', sub[0])));
        await assertFails(setDoc(doc(db, 'tournaments', 't2', 'rounds', 'r1', sub[0], 'mine'), { playerId: uid, hole: 1 }));
      }
      await assertFails(getDoc(doc(anon(), 'tournaments', 't2', 'rounds', 'r1', sub[0], sub[1])));
    }
  });
});

describe('the score inbox (submissions) and official scores', () => {
  const subs = (tid: string, ...rest: string[]) => ['tournaments', tid, 'rounds', 'r1', 'submissions', ...rest] as const;
  const T = 1_700_000_000_000;
  const good = (uid: string, over: Record<string, unknown> = {}) => ({
    playerId: 'mem',
    hole: 3,
    strokes: 5,
    kind: 'played',
    groupId: 'g1',
    enteredBy: uid,
    clientTime: T,
    ...over,
  });
  const id = (data: Record<string, unknown>) => `${data.playerId}_${data.hole}_${data.clientTime}`;

  it('a roster member can create a well-formed submission under its own content-derived id', async () => {
    const data = good('mem');
    await assertSucceeds(setDoc(doc(as('mem'), ...subs('t1', id(data))), data));
  });

  it('a pickup is accepted like a played hole', async () => {
    const data = good('mem', { kind: 'pickup', strokes: 8 });
    await assertSucceeds(setDoc(doc(as('mem'), ...subs('t1', id(data))), data));
  });

  it('is refused for a stranger, a signed-out user, and someone who is not on the roster', async () => {
    const data = good('stranger');
    await assertFails(setDoc(doc(as('stranger'), ...subs('t1', id(data))), data));
    await assertFails(setDoc(doc(anon(), ...subs('t1', id(data))), data));
    // A spectator of a public tournament may watch but not write into the round.
    await assertFails(setDoc(doc(as('stranger'), ...subs('t2', id(data))), data));
  });

  it('cannot claim to be somebody else', async () => {
    const data = good('org'); // enteredBy says org, but mem is signed in
    await assertFails(setDoc(doc(as('mem'), ...subs('t1', id(data))), data));
  });

  it('refuses extra fields (so the function-only outcome fields cannot be set), and missing ones', async () => {
    for (const extra of [{ outcome: 'accepted' }, { reason: 'x' }, { processedAt: 1 }, { note: 'hi' }]) {
      const data = { ...good('mem'), ...extra };
      await assertFails(setDoc(doc(as('mem'), ...subs('t1', id(data))), data));
    }
    const { groupId: _gone, ...missing } = good('mem');
    await assertFails(setDoc(doc(as('mem'), ...subs('t1', id(missing))), missing));
  });

  it('refuses values out of range or of the wrong type', async () => {
    for (const bad of [
      { strokes: 0 }, { strokes: 21 }, { strokes: 4.5 }, { strokes: '4' },
      { hole: 0 }, { hole: 19 }, { hole: 2.5 },
      { kind: 'dispute' }, { kind: 'correction' }, { kind: 'x' },
      { clientTime: 0 }, { clientTime: -5 }, { clientTime: 'now' },
      { playerId: '' }, { groupId: '' }, { playerId: 5 },
    ]) {
      const data = { ...good('mem'), ...bad };
      await assertFails(setDoc(doc(as('mem'), ...subs('t1', `${data.playerId}_${data.hole}_${data.clientTime}`)), data));
    }
  });

  it('refuses a document id that does not match the content (no overwriting someone elses id, no flooding)', async () => {
    const data = good('mem');
    await assertFails(setDoc(doc(as('mem'), ...subs('t1', 'anything-at-all')), data));
    await assertFails(setDoc(doc(as('mem'), ...subs('t1', `mem_4_${T}`)), data));
  });

  it('cannot be updated or deleted by anyone, including the one who wrote it and the organizer', async () => {
    for (const uid of ['mem', 'org']) {
      await assertFails(updateDoc(doc(as(uid), ...subs('t1', 'sub1')), { strokes: 1 }));
      await assertFails(updateDoc(doc(as(uid), ...subs('t1', 'sub1')), { outcome: 'accepted' }));
      await assertFails(deleteDoc(doc(as(uid), ...subs('t1', 'sub1'))));
    }
  });

  it('a person reads their own submissions (and lists them with the filter); admins read all; others none', async () => {
    await assertSucceeds(getDoc(doc(as('mem'), ...subs('t1', 'sub1'))));
    await assertFails(getDoc(doc(as('mem'), ...subs('t1', 'sub-other'))));
    await assertSucceeds(getDocs(query(collection(as('mem'), ...subs('t1')), where('enteredBy', '==', 'mem'))));
    await assertFails(getDocs(collection(as('mem'), ...subs('t1')))); // an unfiltered list would expose others
    await assertSucceeds(getDocs(collection(as('org'), ...subs('t1'))));
    await assertSucceeds(getDoc(doc(as('co'), ...subs('t1', 'sub-other'))));
    await assertFails(getDoc(doc(as('stranger'), ...subs('t1', 'sub1'))));
    await assertFails(getDoc(doc(as('stranger'), ...subs('t2', 'sub1')))); // spectators of a public tournament too
    await assertFails(getDoc(doc(anon(), ...subs('t1', 'sub1'))));
  });

  it('official scores: members and admins read them; spectators, strangers and signed-out users cannot; nobody writes', async () => {
    const score = (tid: string) => ['tournaments', tid, 'rounds', 'r1', 'scores', 's1'] as const;
    await assertSucceeds(getDoc(doc(as('mem'), ...score('t1'))));
    await assertSucceeds(getDoc(doc(as('org'), ...score('t1'))));
    await assertSucceeds(getDocs(collection(as('mem'), 'tournaments', 't1', 'rounds', 'r1', 'scores')));
    await assertFails(getDoc(doc(as('stranger'), ...score('t1'))));
    await assertFails(getDoc(doc(as('stranger'), ...score('t2')))); // public: spectators see cards, not raw entries
    await assertFails(getDoc(doc(anon(), ...score('t1'))));
    await assertFails(getDoc(doc(as('mem'), ...score('t3')))); // suspended
    for (const uid of ['mem', 'org']) {
      await assertFails(setDoc(doc(as(uid), 'tournaments', 't1', 'rounds', 'r1', 'scores', 'new'), { playerId: 'mem', hole: 1, strokes: 3 }));
      await assertFails(updateDoc(doc(as(uid), ...score('t1')), { strokes: 1 }));
      await assertFails(deleteDoc(doc(as(uid), ...score('t1'))));
    }
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
