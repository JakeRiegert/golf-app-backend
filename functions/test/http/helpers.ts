// HTTP-level test helpers: talk to the Auth, Functions and Firestore emulators the way the real
// app does (sign-in token, callable POST, Firestore REST read), instead of calling our TypeScript
// directly. Run via `npm run test:http`, which starts the emulators and builds the functions first.
//
// Where the suite points is configured by environment variables so the same tests can target
// another environment later (a QA project, or a post-deploy smoke run) by changing the base URLs.
import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

export const PROJECT = process.env.TEST_PROJECT ?? 'demo-golf-http';
const FUNCTIONS = process.env.TEST_FUNCTIONS_URL ?? `http://127.0.0.1:5101/${PROJECT}/us-central1`;
const AUTH = process.env.TEST_AUTH_URL ?? 'http://127.0.0.1:9199';
const FIRESTORE = process.env.TEST_FIRESTORE_URL ?? 'http://127.0.0.1:8181';

export interface TestUser {
  uid: string;
  email: string;
  token: string;
}

// A fresh throwaway account, signed in. The email is random so tests never collide, including
// test files running in parallel worker processes (a timestamp plus a per-process counter is not
// unique across them).
export async function signUp(label: string): Promise<TestUser> {
  const email = `${label}-${randomUUID()}@example.com`;
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse-battery', returnSecureToken: true }),
  });
  const body = (await res.json()) as { idToken: string; localId: string };
  if (!res.ok) throw new Error(`sign-up failed: ${JSON.stringify(body)}`);
  return { uid: body.localId, email, token: body.idToken };
}

export interface CallResult<T = any> {
  http: number;
  result?: T;
  error?: { status: string; message: string };
}

// Call a callable function over HTTP. user = null sends no token at all.
export async function call<T = any>(user: TestUser | null, name: string, data: unknown): Promise<CallResult<T>> {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
    },
    body: JSON.stringify({ data }),
  });
  // A non-callable answer (for example a 404 page for an unknown function) is not JSON.
  const text = await res.text();
  let body: { result?: T; error?: { status: string; message: string } } = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: { status: 'NOT_JSON', message: text.slice(0, 200) } };
  }
  return { http: res.status, result: body.result, error: body.error };
}

// A call that must succeed; returns just the result.
export async function ok<T = any>(user: TestUser, name: string, data: unknown): Promise<T> {
  const res = await call<T>(user, name, data);
  expect(res.error, `${name} should succeed but returned ${JSON.stringify(res.error)}`).toBeUndefined();
  expect(res.http).toBe(200);
  return res.result as T;
}

// A call that must be refused with the given callable error status (e.g. 'PERMISSION_DENIED').
export async function refused(user: TestUser | null, name: string, data: unknown, status: string): Promise<string> {
  const res = await call(user, name, data);
  expect(res.error?.status, `${name} should be refused with ${status}, got ${JSON.stringify(res)}`).toBe(status);
  expect(res.http).toBeGreaterThanOrEqual(400);
  return res.error?.message ?? '';
}

const docsBase = `${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents`;
const authHeader = (user: TestUser | null): Record<string, string> =>
  user ? { Authorization: `Bearer ${user.token}` } : {};

// Convert Firestore REST's typed values back to plain JS.
function plain(value: any): any {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('timestampValue' in value) return value.timestampValue;
  if ('mapValue' in value) return fields(value.mapValue.fields ?? {});
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(plain);
  return value;
}
const fields = (f: Record<string, any>) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, plain(v)]));

export interface ReadResult {
  http: number;
  data?: Record<string, any>;
}

// Read one document as this user (null = anonymous), under the real security rules.
export async function readDoc(user: TestUser | null, path: string): Promise<ReadResult> {
  const res = await fetch(`${docsBase}/${path}`, { headers: authHeader(user) });
  if (!res.ok) return { http: res.status };
  const body = (await res.json()) as { fields?: Record<string, any> };
  return { http: res.status, data: fields(body.fields ?? {}) };
}

// List a collection as this user. Rules are checked for the whole list.
export async function listDocs(
  user: TestUser | null,
  path: string,
): Promise<{ http: number; docs: { id: string; data: Record<string, any> }[] }> {
  const res = await fetch(`${docsBase}/${path}`, { headers: authHeader(user) });
  if (!res.ok) return { http: res.status, docs: [] };
  const body = (await res.json()) as { documents?: { name: string; fields?: Record<string, any> }[] };
  return {
    http: res.status,
    docs: (body.documents ?? []).map((d) => ({ id: d.name.split('/').pop()!, data: fields(d.fields ?? {}) })),
  };
}

// "My tournaments": a collection-group query on roster entries where playerId == the given uid.
export async function myRosterEntries(
  user: TestUser | null,
  playerId: string,
): Promise<{ http: number; paths: string[] }> {
  const res = await fetch(`${docsBase}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(user) },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'players', allDescendants: true }],
        where: {
          fieldFilter: { field: { fieldPath: 'playerId' }, op: 'EQUAL', value: { stringValue: playerId } },
        },
      },
    }),
  });
  if (!res.ok) return { http: res.status, paths: [] };
  const rows = (await res.json()) as { document?: { name: string } }[];
  return {
    http: res.status,
    paths: rows.filter((r) => r.document).map((r) => r.document!.name.split('/documents/')[1]),
  };
}

// A direct client write, which the rules must always refuse.
export async function writeDoc(user: TestUser | null, path: string): Promise<number> {
  const res = await fetch(`${docsBase}/${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeader(user) },
    body: JSON.stringify({ fields: { hacked: { booleanValue: true } } }),
  });
  return res.status;
}

// ---- common setup -------------------------------------------------------------------------

export interface Trip {
  tournamentId: string;
  inviteCode: string;
  organizer: TestUser;
}

// An organizer with a created tournament (and a signed-in profile).
export async function newTrip(extra: Record<string, unknown> = {}): Promise<Trip> {
  const organizer = await signUp('organizer');
  await ok(organizer, 'upsertPlayerProfile', { displayName: 'Organizer' });
  const created = await ok(organizer, 'createTournament', { name: 'HTTP Cup', ...extra });
  return { tournamentId: created.id, inviteCode: created.inviteCode, organizer };
}

// A signed-in player who has joined the trip by invite code.
export async function joinedPlayer(trip: Trip, label = 'player'): Promise<TestUser> {
  const user = await signUp(label);
  await ok(user, 'upsertPlayerProfile', { displayName: label });
  await ok(user, 'joinTournament', { inviteCode: trip.inviteCode });
  return user;
}

export async function createTeams(trip: Trip, names: string[]): Promise<Record<string, string>> {
  const { teams } = await ok(trip.organizer, 'createTeams', {
    tournamentId: trip.tournamentId,
    teams: names.map((name) => ({ name })),
  });
  return Object.fromEntries(teams.map((t: { id: string; name: string }) => [t.name, t.id]));
}

// A filtered query on a subcollection of a document, as a client would run it. Security rules
// allow or deny the whole query, so the filters must prove every possible result is readable.
// (The emulator does not enforce composite indexes; the real project needs the ones in
// firestore.indexes.json for the ordered feed queries.)
export async function queryCollection(
  user: TestUser | null,
  parentDoc: string,
  collectionId: string,
  filters: [field: string, value: string][] = [],
  orderByDesc?: string,
): Promise<{ http: number; docs: { id: string; data: Record<string, any> }[] }> {
  const where =
    filters.length === 0
      ? undefined
      : filters.length === 1
        ? { fieldFilter: { field: { fieldPath: filters[0][0] }, op: 'EQUAL', value: { stringValue: filters[0][1] } } }
        : {
            compositeFilter: {
              op: 'AND',
              filters: filters.map(([field, value]) => ({
                fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } },
              })),
            },
          };
  const res = await fetch(`${docsBase}/${parentDoc}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(user) },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        ...(where ? { where } : {}),
        ...(orderByDesc ? { orderBy: [{ field: { fieldPath: orderByDesc }, direction: 'DESCENDING' }] } : {}),
      },
    }),
  });
  if (!res.ok) return { http: res.status, docs: [] };
  const rows = (await res.json()) as { document?: { name: string; fields?: Record<string, any> } }[];
  return {
    http: res.status,
    docs: rows
      .filter((r) => r.document)
      .map((r) => ({ id: r.document!.name.split('/').pop()!, data: fields(r.document!.fields ?? {}) })),
  };
}
