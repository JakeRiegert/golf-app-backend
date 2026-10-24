import { DocumentData, DocumentReference, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { TOURNAMENT_STATUS } from './limits';
import { UsageTracker } from './usage';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Document IDs cannot contain '/', so reject anything that is not a plain string ID up front.
export function requireId(field: string, value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new HttpsError('invalid-argument', `${field} is required`);
  }
  return value;
}

export function requireTournamentId(value: unknown): string {
  return requireId('tournamentId', value);
}

// Reads the tournament inside the caller's transaction and requires it to exist and be active.
// A suspended tournament is read-only for everyone (plan D9): admins can still see it, but
// every write is refused until it is reactivated.
export async function readActiveTournament(
  tx: Transaction,
  tournamentRef: DocumentReference,
  usage: UsageTracker,
): Promise<DocumentData> {
  const snap = await tx.get(tournamentRef);
  usage.read();
  const tournament = snap.data();
  if (!tournament) {
    throw new HttpsError('not-found', 'Tournament not found');
  }
  if (tournament.status !== TOURNAMENT_STATUS.ACTIVE) {
    throw new HttpsError('failed-precondition', 'This tournament is suspended');
  }
  return tournament;
}

export function isAdminOf(tournament: DocumentData, uid: string): boolean {
  return tournament.organizerId === uid || tournament.coAdminId === uid;
}

// Requires the caller to be the tournament's organizer or co-admin. Returns the tournament data
// so callers do not have to read it again.
export async function assertAdmin(
  tx: Transaction,
  tournamentRef: DocumentReference,
  uid: string,
  usage: UsageTracker,
): Promise<DocumentData> {
  const tournament = await readActiveTournament(tx, tournamentRef, usage);
  if (!isAdminOf(tournament, uid)) {
    throw new HttpsError('permission-denied', "Only this tournament's organizer or co-admin can do that");
  }
  return tournament;
}
