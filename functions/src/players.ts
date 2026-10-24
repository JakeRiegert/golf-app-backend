import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { getDb } from './firestore';
import { MAX_AVATAR_URL_LENGTH, MAX_DISPLAY_NAME_LENGTH } from './limits';
import { callable, UsageTracker } from './usage';

export interface UpsertProfileInput {
  displayName?: string;
  avatarUrl?: string;
}

// The only identity claims we use. email comes from the ID token, never from the client.
export interface TokenClaims {
  email?: string;
  name?: string;
  picture?: string;
}

export interface PublicProfile {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
}

function cleanDisplayName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', 'displayName must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new HttpsError(
      'invalid-argument',
      `displayName must be 1-${MAX_DISPLAY_NAME_LENGTH} characters`,
    );
  }
  return trimmed;
}

function cleanAvatarUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.startsWith('https://') || value.length > MAX_AVATAR_URL_LENGTH) {
    throw new HttpsError(
      'invalid-argument',
      `avatarUrl must be an https URL up to ${MAX_AVATAR_URL_LENGTH} characters`,
    );
  }
  return value;
}

// Create-or-update the caller's profile. Only fields actually provided are changed; on the
// first call, missing fields are seeded from the sign-in provider (Google's name and photo).
// Precedence per field: explicit input, then what is already stored, then the provider's
// claim, then null. Public profile (players/uid) and email (players/uid/private/profile) are
// separate documents because security rules are per-document.
export async function upsertProfile(
  db: Firestore,
  uid: string,
  claims: TokenClaims,
  input: UpsertProfileInput,
  usage: UsageTracker,
): Promise<PublicProfile> {
  const displayName = cleanDisplayName(input.displayName);
  const avatarUrl = cleanAvatarUrl(input.avatarUrl);

  const profileRef = db.collection('players').doc(uid);
  const privateRef = profileRef.collection('private').doc('profile');

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(profileRef);
    usage.read();
    const existing = snap.data();
    const now = FieldValue.serverTimestamp();

    const profile = {
      displayName: displayName ?? existing?.displayName ?? claims.name ?? null,
      avatarUrl: avatarUrl ?? existing?.avatarUrl ?? claims.picture ?? null,
      updatedAt: now,
      ...(snap.exists ? {} : { createdAt: now }),
    };

    tx.set(profileRef, profile, { merge: true });
    tx.set(privateRef, { email: claims.email ?? null, updatedAt: now }, { merge: true });
    usage.wrote(2);

    return { id: uid, displayName: profile.displayName, avatarUrl: profile.avatarUrl };
  });
}

export const upsertPlayerProfile = callable<UpsertProfileInput, PublicProfile>(
  'upsertPlayerProfile',
  async (request, usage, uid) => {
    const token = request.auth?.token;
    const claims: TokenClaims = {
      email: token?.email,
      name: token?.name as string | undefined,
      picture: token?.picture as string | undefined,
    };
    return upsertProfile(getDb(), uid, claims, request.data ?? {}, usage);
  },
);
