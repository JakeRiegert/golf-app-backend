import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { assertAdmin, requireTournamentId } from './authz';
import { getDb } from './firestore';
import { MAX_TEAM_NAME_LENGTH, MAX_TEAMS_PER_TOURNAMENT } from './limits';
import { callable, UsageTracker } from './usage';

export interface TeamInput {
  name?: string;
  color?: string | null;
}

export interface CreateTeamsInput {
  tournamentId?: string;
  teams?: TeamInput[];
}

export interface UpdateTeamInput extends TeamInput {
  tournamentId?: string;
  teamId?: string;
}

export interface Team {
  id: string;
  name: string;
  color: string | null;
}

function cleanTeamName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', 'team name is required');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEAM_NAME_LENGTH) {
    throw new HttpsError('invalid-argument', `team name must be 1-${MAX_TEAM_NAME_LENGTH} characters`);
  }
  return trimmed;
}

// A team color is optional and, when present, a #RRGGBB hex string (what a color picker gives
// us), stored upper-case so equal colors compare equal.
function cleanColor(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new HttpsError('invalid-argument', 'color must look like #1A7F37');
  }
  return value.toUpperCase();
}

const nameKey = (name: string) => name.toLowerCase();

// Create one or more teams in a tournament, all or nothing. Organizer or co-admin only. Team
// names are unique within a tournament (ignoring case) and a tournament holds at most
// MAX_TEAMS_PER_TOURNAMENT teams, so the whole collection is cheap to read in one go.
export async function createTeams(
  db: Firestore,
  uid: string,
  input: CreateTeamsInput,
  usage: UsageTracker,
): Promise<{ teams: Team[] }> {
  const tournamentId = requireTournamentId(input.tournamentId);
  if (!Array.isArray(input.teams) || input.teams.length === 0) {
    throw new HttpsError('invalid-argument', 'teams must be a non-empty list');
  }
  if (input.teams.length > MAX_TEAMS_PER_TOURNAMENT) {
    throw new HttpsError('invalid-argument', `at most ${MAX_TEAMS_PER_TOURNAMENT} teams can be created at once`);
  }
  const wanted = input.teams.map((team) => ({
    name: cleanTeamName(team?.name),
    color: cleanColor(team?.color),
  }));
  const seen = new Set<string>();
  for (const { name } of wanted) {
    if (seen.has(nameKey(name))) {
      throw new HttpsError('invalid-argument', `team name "${name}" appears more than once`);
    }
    seen.add(nameKey(name));
  }

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const teamsRef = tournamentRef.collection('teams');

  return db.runTransaction(async (tx) => {
    await assertAdmin(tx, tournamentRef, uid, usage);
    const existing = await tx.get(teamsRef);
    usage.read(existing.size);
    if (existing.size + wanted.length > MAX_TEAMS_PER_TOURNAMENT) {
      throw new HttpsError(
        'resource-exhausted',
        `A tournament can have at most ${MAX_TEAMS_PER_TOURNAMENT} teams (it has ${existing.size})`,
      );
    }
    const taken = new Set(existing.docs.map((doc) => nameKey(doc.data().name as string)));
    for (const { name } of wanted) {
      if (taken.has(nameKey(name))) {
        throw new HttpsError('already-exists', `This tournament already has a team named "${name}"`);
      }
    }

    const created = wanted.map((team) => {
      const ref = teamsRef.doc();
      tx.create(ref, { ...team, createdAt: FieldValue.serverTimestamp() });
      return { id: ref.id, ...team };
    });
    usage.wrote(created.length);
    return { teams: created };
  });
}

// Rename a team and/or change its color. Only fields that are provided change; passing
// color: null clears it. Organizer or co-admin only.
export async function updateTeam(
  db: Firestore,
  uid: string,
  input: UpdateTeamInput,
  usage: UsageTracker,
): Promise<Team> {
  const tournamentId = requireTournamentId(input.tournamentId);
  if (typeof input.teamId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.teamId)) {
    throw new HttpsError('invalid-argument', 'teamId is required');
  }
  const name = input.name === undefined ? undefined : cleanTeamName(input.name);
  const color = input.color === undefined ? undefined : cleanColor(input.color);
  if (name === undefined && color === undefined) {
    throw new HttpsError('invalid-argument', 'provide a name or a color to change');
  }

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const teamsRef = tournamentRef.collection('teams');
  const teamRef = teamsRef.doc(input.teamId);

  return db.runTransaction(async (tx) => {
    await assertAdmin(tx, tournamentRef, uid, usage);
    const teams = await tx.get(teamsRef);
    usage.read(teams.size);
    const current = teams.docs.find((doc) => doc.id === teamRef.id);
    if (!current) {
      throw new HttpsError('not-found', 'Team not found in this tournament');
    }
    if (name !== undefined) {
      const clash = teams.docs.some((doc) => doc.id !== teamRef.id && nameKey(doc.data().name) === nameKey(name));
      if (clash) {
        throw new HttpsError('already-exists', `This tournament already has a team named "${name}"`);
      }
    }

    const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (name !== undefined) updates.name = name;
    if (color !== undefined) updates.color = color;
    tx.update(teamRef, updates);
    usage.wrote();
    return {
      id: teamRef.id,
      name: name ?? (current.data().name as string),
      color: color !== undefined ? color : ((current.data().color as string | null) ?? null),
    };
  });
}

export const createTeamsCallable = callable<CreateTeamsInput, { teams: Team[] }>(
  'createTeams',
  async (request, usage, uid) => createTeams(getDb(), uid, request.data ?? {}, usage),
);

export const updateTeamCallable = callable<UpdateTeamInput, Team>(
  'updateTeam',
  async (request, usage, uid) => updateTeam(getDb(), uid, request.data ?? {}, usage),
);
