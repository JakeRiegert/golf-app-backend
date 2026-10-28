import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { diff, logActivity } from './activity';
import { assertAdmin, requireId, requireTournamentId } from './authz';
import { getDb } from './firestore';
import { MAX_WAGER_POT_AMOUNT, Visibility } from './limits';
import { cleanDate, cleanName, cleanVisibility } from './tournaments';
import { callable, UsageTracker } from './usage';

export interface UpdateTournamentInput {
  tournamentId?: string;
  name?: string;
  // undefined = leave unchanged, null = clear.
  startDate?: string | null;
  endDate?: string | null;
  wagerPotAmount?: number | null;
  visibility?: string;
  // true = start (same as startTournament), false = reopen (players can edit their handicap again).
  started?: boolean;
}

export interface UpdatedTournament {
  tournamentId: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  wagerPotAmount: number | null;
  visibility: Visibility;
  started: boolean;
}

export interface AssignCoAdminInput {
  tournamentId?: string;
  // null = remove the co-admin.
  playerId?: string | null;
}

export interface CoAdminResult {
  tournamentId: string;
  coAdminId: string | null;
}

const UPDATABLE_FIELDS = new Set(['tournamentId', 'name', 'startDate', 'endDate', 'wagerPotAmount', 'visibility', 'started']);

function cleanWagerPot(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_WAGER_POT_AMOUNT) {
    throw new HttpsError('invalid-argument', `wagerPotAmount must be a number from 0 to ${MAX_WAGER_POT_AMOUNT}`);
  }
  return Math.round(value * 100) / 100;
}

// Admin: edit a tournament's details. Only the fields provided change. Unknown fields are
// rejected rather than ignored, so a typo cannot silently do nothing (and nothing here can touch
// the organizer, status or invite code). Dates are validated together: the end cannot precede the
// start once both are applied. Organizer or co-admin only; a suspended tournament is read-only.
export async function updateTournament(
  db: Firestore,
  uid: string,
  input: UpdateTournamentInput,
  usage: UsageTracker,
): Promise<UpdatedTournament> {
  const tournamentId = requireTournamentId(input.tournamentId);
  for (const key of Object.keys(input)) {
    if (!UPDATABLE_FIELDS.has(key)) {
      throw new HttpsError('invalid-argument', `${key} cannot be changed here`);
    }
  }

  const changes: Record<string, unknown> = {};
  if (input.name !== undefined) changes.name = cleanName(input.name);
  if (input.startDate !== undefined) changes.startDate = cleanDate('startDate', input.startDate);
  if (input.endDate !== undefined) changes.endDate = cleanDate('endDate', input.endDate);
  if (input.wagerPotAmount !== undefined) changes.wagerPotAmount = cleanWagerPot(input.wagerPotAmount);
  if (input.visibility !== undefined) changes.visibility = cleanVisibility(input.visibility);
  if (input.started !== undefined && typeof input.started !== 'boolean') {
    throw new HttpsError('invalid-argument', 'started must be true or false');
  }
  if (Object.keys(changes).length === 0 && input.started === undefined) {
    throw new HttpsError('invalid-argument', 'provide at least one field to change');
  }

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);

  return db.runTransaction(async (tx) => {
    const current = await assertAdmin(tx, tournamentRef, uid, usage);

    const startDate = 'startDate' in changes ? (changes.startDate as string | null) : (current.startDate ?? null);
    const endDate = 'endDate' in changes ? (changes.endDate as string | null) : (current.endDate ?? null);
    if (startDate && endDate && endDate < startDate) {
      throw new HttpsError('invalid-argument', 'endDate cannot be before startDate');
    }

    const updates: Record<string, unknown> = { ...changes };
    let started = Boolean(current.startedAt);
    if (input.started === true && !started) {
      updates.startedAt = FieldValue.serverTimestamp();
      started = true;
    } else if (input.started === false && started) {
      updates.startedAt = null;
      started = false;
    }
    if (Object.keys(updates).length > 0) {
      tx.update(tournamentRef, updates);
      usage.wrote();
    }

    // Record what really changed. Start and Reopen are announced to everyone, and so is any edit
    // once the tournament has started or one that changes who can see it; early setup edits stay
    // between the admins.
    const startedBefore = Boolean(current.startedAt);
    if (started && !startedBefore) {
      logActivity(tx, tournamentRef, usage, { type: 'tournament_started', actorId: uid, level: 'all' });
    } else if (!started && startedBefore) {
      logActivity(tx, tournamentRef, usage, { type: 'tournament_reopened', actorId: uid, level: 'all' });
    }
    const fieldChanges = diff(
      {
        name: current.name,
        startDate: current.startDate ?? null,
        endDate: current.endDate ?? null,
        wagerPotAmount: current.wagerPotAmount ?? null,
        visibility: current.visibility,
      },
      changes,
    );
    if (Object.keys(fieldChanges).length > 0) {
      logActivity(tx, tournamentRef, usage, {
        type: 'tournament_updated',
        actorId: uid,
        level: started || 'visibility' in fieldChanges ? 'all' : 'admins',
        changes: fieldChanges,
      });
    }

    const merged = { ...current, ...changes };
    return {
      tournamentId,
      name: merged.name as string,
      startDate,
      endDate,
      wagerPotAmount: (merged.wagerPotAmount as number | null) ?? null,
      visibility: merged.visibility as Visibility,
      started,
    };
  });
}

// Admin: name the co-admin, who shares the organizer's admin powers so one dead phone does not
// block the trip. The organizer or the current co-admin may assign (blueprint requirement 24).
// The co-admin must be on the roster, and cannot be the organizer, who is already an admin.
// playerId: null removes the co-admin. Assigning replaces any existing co-admin.
export async function assignCoAdmin(
  db: Firestore,
  uid: string,
  input: AssignCoAdminInput,
  usage: UsageTracker,
): Promise<CoAdminResult> {
  const tournamentId = requireTournamentId(input.tournamentId);
  if (input.playerId === undefined) {
    throw new HttpsError('invalid-argument', 'playerId is required (use null to remove the co-admin)');
  }
  const playerId = input.playerId === null ? null : requireId('playerId', input.playerId);

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);

  return db.runTransaction(async (tx) => {
    const tournament = await assertAdmin(tx, tournamentRef, uid, usage);
    if (playerId !== null) {
      if (playerId === tournament.organizerId) {
        throw new HttpsError('invalid-argument', 'The organizer is already an admin');
      }
      const member = await tx.get(tournamentRef.collection('players').doc(playerId));
      usage.read();
      if (!member.exists) {
        throw new HttpsError('not-found', 'That player is not on this tournament\'s roster');
      }
    }

    tx.update(tournamentRef, { coAdminId: playerId });
    usage.wrote();
    const previous = (tournament.coAdminId as string | null | undefined) ?? null;
    if (previous !== playerId) {
      logActivity(tx, tournamentRef, usage, {
        type: 'co_admin_changed',
        actorId: uid,
        targetPlayerId: playerId ?? previous,
        level: 'all',
        changes: { coAdminId: { from: previous, to: playerId } },
      });
    }
    return { tournamentId, coAdminId: playerId };
  });
}

export const updateTournamentCallable = callable<UpdateTournamentInput, UpdatedTournament>(
  'updateTournament',
  async (request, usage, uid) => updateTournament(getDb(), uid, request.data ?? {}, usage),
);

export const assignCoAdminCallable = callable<AssignCoAdminInput, CoAdminResult>(
  'assignCoAdmin',
  async (request, usage, uid) => assignCoAdmin(getDb(), uid, request.data ?? {}, usage),
);
