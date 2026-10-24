import { randomInt } from 'node:crypto';

import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { getDb } from './firestore';
import { MAX_TOURNAMENT_NAME_LENGTH, TOURNAMENT_STATUS, VISIBILITY, Visibility } from './limits';
import { callable, UsageTracker } from './usage';

export interface CreateTournamentInput {
  name?: string;
  startDate?: string;
  endDate?: string;
  visibility?: string;
}

export interface CreatedTournament {
  id: string;
  name: string;
  inviteCode: string;
  startDate: string | null;
  endDate: string | null;
  visibility: Visibility;
}

// No 0/O/1/I/L so a code survives being read aloud or printed on a QR card. 8 characters from
// 31 symbols is about 40 bits: short enough to type, long enough that guessing is impractical
// (the join function is also rate-limited and App Check protected later, plan 5b).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_CODE_ATTEMPTS = 5;
const ALREADY_EXISTS = 6; // gRPC status code surfaced by Firestore's create()

export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', 'name is required');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TOURNAMENT_NAME_LENGTH) {
    throw new HttpsError('invalid-argument', `name must be 1-${MAX_TOURNAMENT_NAME_LENGTH} characters`);
  }
  return trimmed;
}

// Dates are calendar days ("2026-11-14"), not instants: a golf trip happens on a day wherever
// it is played, so there is no time zone to get wrong.
function cleanDate(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpsError('invalid-argument', `${field} must be a date like 2026-11-14`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpsError('invalid-argument', `${field} is not a real calendar date`);
  }
  return value;
}

function cleanVisibility(value: unknown): Visibility {
  if (value === undefined || value === null) return VISIBILITY.PRIVATE;
  if (value !== VISIBILITY.PRIVATE && value !== VISIBILITY.PUBLIC) {
    throw new HttpsError('invalid-argument', `visibility must be '${VISIBILITY.PRIVATE}' or '${VISIBILITY.PUBLIC}'`);
  }
  return value;
}

// Creates the tournament and everything that must exist with it, in one atomic batch:
//   tournaments/{id}                  public-ish details (spectators of a public tournament read this)
//   tournaments/{id}/players/{uid}    the organizer joins their own roster (plan D7b)
//   tournaments/{id}/private/settings the invite code (members/admins only, plan D7a)
//   inviteCodes/{code}                server-only lookup used by joinTournament
// The invite code is separate from the tournament ID so a leaked code can be rotated without
// touching the ID everything else hangs off. inviteCodes/{code} is written with create(), so a
// code collision fails the whole batch and we retry with a fresh code.
export async function createTournament(
  db: Firestore,
  uid: string,
  input: CreateTournamentInput,
  usage: UsageTracker,
  codeGenerator: () => string = generateInviteCode,
): Promise<CreatedTournament> {
  const name = cleanName(input.name);
  const startDate = cleanDate('startDate', input.startDate);
  const endDate = cleanDate('endDate', input.endDate);
  if (startDate && endDate && endDate < startDate) {
    throw new HttpsError('invalid-argument', 'endDate cannot be before startDate');
  }
  const visibility = cleanVisibility(input.visibility);

  const tournamentRef = db.collection('tournaments').doc();
  usage.forTournament(tournamentRef.id);
  const now = FieldValue.serverTimestamp();

  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    const inviteCode = codeGenerator();
    const batch = db.batch();
    batch.create(tournamentRef, {
      name,
      organizerId: uid,
      coAdminId: null,
      startDate,
      endDate,
      wagerPotAmount: null,
      visibility,
      status: TOURNAMENT_STATUS.ACTIVE,
      createdAt: now,
    });
    batch.create(tournamentRef.collection('players').doc(uid), {
      playerId: uid,
      teamId: null,
      teamAssignedBy: null,
      handicap: null,
      joinedAt: now,
    });
    batch.create(tournamentRef.collection('private').doc('settings'), { inviteCode, updatedAt: now });
    batch.create(db.collection('inviteCodes').doc(inviteCode), {
      tournamentId: tournamentRef.id,
      createdAt: now,
    });

    try {
      await batch.commit();
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === ALREADY_EXISTS && attempt < MAX_CODE_ATTEMPTS) continue;
      throw err;
    }
    usage.wrote(4);
    return { id: tournamentRef.id, name, inviteCode, startDate, endDate, visibility };
  }
  // Unreachable: the last attempt either returns or throws above.
  throw new HttpsError('internal', 'could not allocate an invite code');
}

export const createTournamentCallable = callable<CreateTournamentInput, CreatedTournament>(
  'createTournament',
  async (request, usage, uid) => createTournament(getDb(), uid, request.data ?? {}, usage),
);
