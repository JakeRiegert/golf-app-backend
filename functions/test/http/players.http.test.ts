import { describe, expect, it } from 'vitest';

import { call, ok, readDoc, refused, signUp, writeDoc } from './helpers';

// HTTP-level: signed-in users calling upsertPlayerProfile and reading what it wrote, under the
// real security rules. Needs the Auth, Functions and Firestore emulators: `npm run test:http`.
describe('upsertPlayerProfile over HTTP', { timeout: 60_000 }, () => {
  it('rejects a call with no sign-in token', async () => {
    const res = await call(null, 'upsertPlayerProfile', {});
    expect(res.http).toBe(401);
    expect(res.error?.status).toBe('UNAUTHENTICATED');
  });

  it('creates the profile; the owner reads the public profile and the private email', async () => {
    const user = await signUp('profile');
    const profile = await ok(user, 'upsertPlayerProfile', { displayName: '  Pat  ' });
    expect(profile).toMatchObject({ id: user.uid, displayName: 'Pat' });

    const publicDoc = await readDoc(user, `players/${user.uid}`);
    expect(publicDoc.data).toMatchObject({ displayName: 'Pat' });
    expect(publicDoc.data?.createdAt).toBeDefined();

    const privateDoc = await readDoc(user, `players/${user.uid}/private/profile`);
    expect(privateDoc.http).toBe(200);
    expect(privateDoc.data?.email).toBe(user.email);
  });

  it('keeps createdAt on a repeat call and does not clear a name that was not provided', async () => {
    const user = await signUp('repeat');
    await ok(user, 'upsertPlayerProfile', { displayName: 'Sam' });
    const first = (await readDoc(user, `players/${user.uid}`)).data!;

    await ok(user, 'upsertPlayerProfile', {});
    const second = (await readDoc(user, `players/${user.uid}`)).data!;
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.displayName).toBe('Sam');
  });

  it("lets another player see the public profile but never the email; anonymous sees neither", async () => {
    const owner = await signUp('owner');
    const other = await signUp('other');
    await ok(owner, 'upsertPlayerProfile', { displayName: 'Owner' });

    expect((await readDoc(other, `players/${owner.uid}`)).http).toBe(200);
    expect((await readDoc(other, `players/${owner.uid}/private/profile`)).http).toBe(403);
    expect((await readDoc(null, `players/${owner.uid}`)).http).toBe(403);
    expect((await readDoc(null, `players/${owner.uid}/private/profile`)).http).toBe(403);
  });

  it('rejects bad input', async () => {
    const user = await signUp('bad');
    await refused(user, 'upsertPlayerProfile', { displayName: 'x'.repeat(51) }, 'INVALID_ARGUMENT');
    await refused(user, 'upsertPlayerProfile', { displayName: 42 }, 'INVALID_ARGUMENT');
    await refused(user, 'upsertPlayerProfile', { avatarUrl: 'http://insecure.example/a.png' }, 'INVALID_ARGUMENT');
  });

  it('refuses a direct client write to a profile', async () => {
    const user = await signUp('writer');
    await ok(user, 'upsertPlayerProfile', { displayName: 'Writer' });
    expect(await writeDoc(user, `players/${user.uid}`)).toBe(403);
  });
});
