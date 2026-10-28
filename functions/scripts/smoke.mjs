#!/usr/bin/env node
// Post-deploy smoke test: a short, real walkthrough against a deployed (or emulated) backend, run
// right after a deploy to catch what emulator tests cannot: public access to the functions, the
// runtime service account's permissions, the Admin SDK start-up, the security rules and the
// composite indexes as Google Cloud actually enforces them.
//
// It creates three throwaway users with the Admin SDK (the deploy identity's credentials), signs
// them in with custom tokens, drives a tournament through the real HTTPS endpoints, and deletes
// everything it made (users, profiles, tournament, invite code) even when a check fails.
//
//   Emulators:  npm run smoke:emulated
//   Real:       SMOKE_PROJECT=<project> SMOKE_API_KEY=<web API key> npm run smoke
//               (needs Application Default Credentials that may create users and write Firestore;
//                in CI that is the deploy service account via Workload Identity Federation)
//
// Optional overrides: SMOKE_FUNCTIONS_URL, SMOKE_AUTH_URL, SMOKE_FIRESTORE_URL. When the Auth
// emulator is running (FIREBASE_AUTH_EMULATOR_HOST is set) the emulator addresses are the default.
import { randomUUID } from 'node:crypto';

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const emulated = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);
const project = process.env.SMOKE_PROJECT ?? (emulated ? 'demo-golf-http' : '');
if (!project) {
  console.error('SMOKE_PROJECT is required (the Google Cloud project to test).');
  process.exit(2);
}
const apiKey = process.env.SMOKE_API_KEY ?? (emulated ? 'fake-key' : '');
if (!apiKey) {
  console.error('SMOKE_API_KEY is required (the Firebase web API key, which is public).');
  process.exit(2);
}
const FUNCTIONS = process.env.SMOKE_FUNCTIONS_URL ??
  (emulated ? `http://127.0.0.1:5101/${project}/us-central1` : `https://us-central1-${project}.cloudfunctions.net`);
const AUTH = process.env.SMOKE_AUTH_URL ??
  (emulated ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com` : 'https://identitytoolkit.googleapis.com');
const FIRESTORE = process.env.SMOKE_FIRESTORE_URL ??
  (emulated ? `http://${process.env.FIRESTORE_EMULATOR_HOST}` : 'https://firestore.googleapis.com');
const docs = `${FIRESTORE}/v1/projects/${project}/databases/(default)/documents`;

// Under Workload Identity Federation the SDK cannot discover which service account signs custom
// tokens, so CI names it (SMOKE_SERVICE_ACCOUNT); it needs roles/iam.serviceAccountTokenCreator on itself.
const app = initializeApp({
  projectId: project,
  ...(process.env.SMOKE_SERVICE_ACCOUNT ? { serviceAccountId: process.env.SMOKE_SERVICE_ACCOUNT } : {}),
});
const auth = getAuth(app);
const db = getFirestore(app);

const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const created = { uids: [], tournamentId: null, inviteCode: null };

// ---- tiny check runner ------------------------------------------------------------------------
const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// ---- helpers -----------------------------------------------------------------------------------
async function signIn(label) {
  const uid = `smoke-${runId}-${label}`;
  await auth.createUser({ uid, email: `${uid}@example.invalid`, displayName: `Smoke ${label}` });
  created.uids.push(uid);
  const custom = await auth.createCustomToken(uid);
  const res = await fetch(`${AUTH}/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`sign-in failed for ${label}: ${JSON.stringify(body).slice(0, 200)}`);
  return { uid, token: body.idToken };
}

async function call(user, name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { error: { status: 'NOT_JSON', message: text.slice(0, 200) } }; }
  return { http: res.status, result: body.result, error: body.error };
}
async function ok(user, name, data) {
  const res = await call(user, name, data);
  expect(!res.error && res.http === 200, `${name} should succeed, got ${res.http} ${JSON.stringify(res.error)}`);
  return res.result;
}
async function refused(user, name, data, status) {
  const res = await call(user, name, data);
  expect(res.error?.status === status, `${name} should be refused with ${status}, got ${res.http} ${JSON.stringify(res.error ?? res.result)}`);
}

const headers = (user) => (user ? { Authorization: `Bearer ${user.token}` } : {});
const readStatus = async (user, path) => (await fetch(`${docs}/${path}`, { headers: headers(user) })).status;
async function readDoc(user, path) {
  const res = await fetch(`${docs}/${path}`, { headers: headers(user) });
  return { http: res.status, body: res.ok ? await res.json() : null };
}
async function runQuery(user, parent, structuredQuery) {
  const res = await fetch(`${docs}${parent ? `/${parent}` : ''}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers(user) },
    body: JSON.stringify({ structuredQuery }),
  });
  const body = res.ok ? await res.json() : [];
  return { http: res.status, rows: Array.isArray(body) ? body.filter((r) => r.document) : [], raw: res.ok ? null : JSON.stringify(body).slice(0, 300) };
}
const eq = (field, value) => ({ fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } } });

// ---- the walkthrough ---------------------------------------------------------------------------
let a, b, c;
let teamIds = [];
try {
  await check('anonymous callers are refused (sign-in required)', async () => {
    const res = await call(null, 'createTournament', { name: 'anon' });
    expect(res.http === 401 && res.error?.status === 'UNAUTHENTICATED', `expected 401 UNAUTHENTICATED, got ${res.http} ${JSON.stringify(res.error)}`);
  });

  await check('sign three throwaway users in', async () => {
    [a, b, c] = [await signIn('a'), await signIn('b'), await signIn('c')];
  });
  if (!a || !b || !c) throw new Error('could not sign in; the remaining checks need users');

  await check('profile is created through the function (runtime account can write Firestore)', async () => {
    await ok(a, 'upsertPlayerProfile', { displayName: 'Smoke A' });
    expect((await readDoc(a, `players/${a.uid}/private/profile`)).http === 200, 'owner could not read their own private profile');
    await ok(b, 'upsertPlayerProfile', { displayName: 'Smoke B' });
  });

  await check('a tournament is created with an invite code', async () => {
    const t = await ok(a, 'createTournament', { name: `SMOKE ${runId}` });
    expect(t.id && t.inviteCode && t.inviteCode !== t.id, 'missing id or invite code');
    created.tournamentId = t.id;
    created.inviteCode = t.inviteCode;
  });
  const tid = created.tournamentId;
  if (!tid) throw new Error('no tournament; the remaining checks need one');

  await check('the organizer can read it and the invite code; anonymous and strangers cannot', async () => {
    expect((await readDoc(a, `tournaments/${tid}`)).http === 200, 'organizer cannot read the tournament');
    expect((await readDoc(a, `tournaments/${tid}/private/settings`)).http === 200, 'organizer cannot read the invite code');
    expect((await readStatus(null, `tournaments/${tid}`)) === 403, 'anonymous read was not denied');
    expect((await readStatus(c, `tournaments/${tid}`)) === 403, 'a stranger could read a private tournament');
    expect((await readStatus(c, `tournaments/${tid}/private/settings`)) === 403, 'a stranger could read the invite code');
  });

  await check('"my tournaments" works (collection-group index)', async () => {
    const res = await runQuery(a, '', { from: [{ collectionId: 'players', allDescendants: true }], where: eq('playerId', a.uid) });
    expect(res.http === 200, `query failed: ${res.http} ${res.raw}`);
    expect(res.rows.some((r) => r.document.name.includes(`tournaments/${tid}/players/${a.uid}`)), 'the organizer entry was not returned');
    expect((await runQuery(c, '', { from: [{ collectionId: 'players', allDescendants: true }], where: eq('playerId', a.uid) })).http === 403, 'a stranger could list someone else\'s entries');
  });

  await check('teams can be created; a duplicate name is refused', async () => {
    const { teams } = await ok(a, 'createTeams', { tournamentId: tid, teams: [{ name: 'Red' }, { name: 'Blue' }] });
    expect(teams.length === 2, 'expected two teams');
    teamIds = teams.map((t) => t.id);
    await refused(a, 'createTeams', { tournamentId: tid, teams: [{ name: 'red' }] }, 'ALREADY_EXISTS');
  });

  await check('a second user joins by code and can read; the stranger still cannot', async () => {
    const joined = await ok(b, 'joinTournament', { inviteCode: created.inviteCode });
    expect(joined.alreadyMember === false, 'expected a new join');
    expect((await readDoc(b, `tournaments/${tid}`)).http === 200, 'member cannot read the tournament');
    expect((await readStatus(c, `tournaments/${tid}`)) === 403, 'stranger can read after another user joined');
    expect((await readStatus(b, `players/${a.uid}/private/profile`)) === 403, 'a player could read another player\'s private profile');
    await refused(c, 'createTeams', { tournamentId: tid, teams: [{ name: 'X' }] }, 'PERMISSION_DENIED');
  });

  await check('Start locks the player\'s team and handicap, and the feed announces it (feed index)', async () => {
    await ok(b, 'chooseTeam', { tournamentId: tid, teamId: teamIds[0] }); // allowed before the start
    await ok(a, 'startTournament', { tournamentId: tid });
    await refused(b, 'chooseTeam', { tournamentId: tid, teamId: teamIds[1] }, 'PERMISSION_DENIED');
    await refused(b, 'setMyHandicap', { tournamentId: tid, handicap: 10 }, 'PERMISSION_DENIED');
    const feed = await runQuery(b, `tournaments/${tid}`, {
      from: [{ collectionId: 'activity' }],
      where: eq('level', 'all'),
      orderBy: [{ field: { fieldPath: 'at' }, direction: 'DESCENDING' }],
    });
    expect(feed.http === 200, `the ordered feed query failed (is the composite index deployed?): ${feed.http} ${feed.raw}`);
    expect(feed.rows.some((r) => r.document.fields?.type?.stringValue === 'tournament_started'), 'the start was not announced');
    expect((await runQuery(b, `tournaments/${tid}`, { from: [{ collectionId: 'activity' }] })).http === 403, 'a member could list the whole feed');
    expect((await runQuery(c, `tournaments/${tid}`, { from: [{ collectionId: 'activity' }], where: eq('level', 'all') })).http === 403, 'a stranger could read the feed');
  });
} catch (err) {
  results.push({ name: 'walkthrough stopped early', ok: false, ms: 0, error: err.message });
} finally {
  await check('cleanup removes everything this run created', async () => {
    if (created.tournamentId) await db.recursiveDelete(db.collection('tournaments').doc(created.tournamentId));
    if (created.inviteCode) await db.collection('inviteCodes').doc(created.inviteCode).delete();
    for (const uid of created.uids) await db.recursiveDelete(db.collection('players').doc(uid));
    if (created.uids.length) await auth.deleteUsers(created.uids);
    if (created.tournamentId) {
      expect(!(await db.collection('tournaments').doc(created.tournamentId).get()).exists, 'tournament still exists');
    }
  });
}

// ---- report ------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\nSmoke test against ${project}${emulated ? ' (emulators)' : ''}, run ${runId}`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${String(r.ms).padStart(5)}ms  ${r.name}${r.ok ? '' : `\n        ${r.error}`}`);
console.log(failed.length === 0 ? `\nAll ${results.length} checks passed.` : `\n${failed.length} of ${results.length} checks FAILED.`);
process.exit(failed.length === 0 ? 0 : 1);
