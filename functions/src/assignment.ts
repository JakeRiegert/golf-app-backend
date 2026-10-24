import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { assertAdmin, readActiveTournament, requireId, requireTournamentId } from './authz';
import { getDb } from './firestore';
import { MAX_HANDICAP, MIN_HANDICAP } from './limits';
import { callable, UsageTracker } from './usage';

export type AssignedBy = 'player' | 'admin' | null;

export interface RosterAssignment {
  playerId: string;
  teamId: string | null;
  handicap: number | null;
  teamAssignedBy: AssignedBy;
}

export interface AssignPlayerInput {
  tournamentId?: string;
  playerId?: string;
  // undefined = leave unchanged, null = clear.
  teamId?: string | null;
  handicap?: number | null;
}

export interface ChooseTeamInput {
  tournamentId?: string;
  // null = leave my team.
  teamId?: string | null;
}

function cleanTeamId(value: unknown): string | null {
  if (value === null) return null;
  return requireId('teamId', value);
}

function cleanHandicap(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_HANDICAP || value > MAX_HANDICAP) {
    throw new HttpsError('invalid-argument', `handicap must be a number from ${MIN_HANDICAP} to ${MAX_HANDICAP}`);
  }
  return Math.round(value * 10) / 10;
}

// Two ways to put a player on a team, one record. Who set it is stored on the roster entry
// (teamAssignedBy) so the rules between them are simple:
//   - a player may choose or change their own team until an admin has assigned them;
//   - an admin (organizer or co-admin) can assign anyone at any time, which locks the player's
//     choice; clearing the team (teamId: null) hands control back to the player.
// Handicap is admin-only: it feeds the bets and scoring, so it is not self-reported.

// Admin: set a roster member's team and/or handicap.
export async function assignTournamentPlayer(
  db: Firestore,
  uid: string,
  input: AssignPlayerInput,
  usage: UsageTracker,
): Promise<RosterAssignment> {
  const tournamentId = requireTournamentId(input.tournamentId);
  const playerId = requireId('playerId', input.playerId);
  const teamId = input.teamId === undefined ? undefined : cleanTeamId(input.teamId);
  const handicap = input.handicap === undefined ? undefined : cleanHandicap(input.handicap);
  if (teamId === undefined && handicap === undefined) {
    throw new HttpsError('invalid-argument', 'provide a teamId or a handicap to change');
  }

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const memberRef = tournamentRef.collection('players').doc(playerId);

  return db.runTransaction(async (tx) => {
    await assertAdmin(tx, tournamentRef, uid, usage);
    const member = await tx.get(memberRef);
    usage.read();
    if (!member.exists) {
      throw new HttpsError('not-found', 'That player is not on this tournament\'s roster');
    }
    if (typeof teamId === 'string') {
      const team = await tx.get(tournamentRef.collection('teams').doc(teamId));
      usage.read();
      if (!team.exists) {
        throw new HttpsError('not-found', 'Team not found in this tournament');
      }
    }

    const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (teamId !== undefined) {
      updates.teamId = teamId;
      updates.teamAssignedBy = teamId === null ? null : 'admin';
    }
    if (handicap !== undefined) updates.handicap = handicap;
    tx.update(memberRef, updates);
    usage.wrote();

    const current = member.data() ?? {};
    return {
      playerId,
      teamId: teamId !== undefined ? teamId : (current.teamId ?? null),
      handicap: handicap !== undefined ? handicap : (current.handicap ?? null),
      teamAssignedBy:
        teamId !== undefined ? (teamId === null ? null : 'admin') : ((current.teamAssignedBy as AssignedBy) ?? null),
    };
  });
}

// Player: choose (or leave) my own team. Only while no admin has assigned me.
export async function chooseTeam(
  db: Firestore,
  uid: string,
  input: ChooseTeamInput,
  usage: UsageTracker,
): Promise<RosterAssignment> {
  const tournamentId = requireTournamentId(input.tournamentId);
  if (input.teamId === undefined) {
    throw new HttpsError('invalid-argument', 'teamId is required (use null to leave your team)');
  }
  const teamId = cleanTeamId(input.teamId);

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const memberRef = tournamentRef.collection('players').doc(uid);

  return db.runTransaction(async (tx) => {
    await readActiveTournament(tx, tournamentRef, usage);
    const member = await tx.get(memberRef);
    usage.read();
    const current = member.data();
    if (!current) {
      throw new HttpsError('permission-denied', 'Join this tournament before choosing a team');
    }
    if (current.teamAssignedBy === 'admin') {
      throw new HttpsError(
        'permission-denied',
        'The organizer has set your team. Ask them if you need it changed.',
      );
    }
    if (teamId !== null) {
      const team = await tx.get(tournamentRef.collection('teams').doc(teamId));
      usage.read();
      if (!team.exists) {
        throw new HttpsError('not-found', 'Team not found in this tournament');
      }
    }

    const teamAssignedBy: AssignedBy = teamId === null ? null : 'player';
    tx.update(memberRef, { teamId, teamAssignedBy, updatedAt: FieldValue.serverTimestamp() });
    usage.wrote();
    return { playerId: uid, teamId, handicap: current.handicap ?? null, teamAssignedBy };
  });
}

export const assignTournamentPlayerCallable = callable<AssignPlayerInput, RosterAssignment>(
  'assignTournamentPlayer',
  async (request, usage, uid) => assignTournamentPlayer(getDb(), uid, request.data ?? {}, usage),
);

export const chooseTeamCallable = callable<ChooseTeamInput, RosterAssignment>(
  'chooseTeam',
  async (request, usage, uid) => chooseTeam(getDb(), uid, request.data ?? {}, usage),
);
