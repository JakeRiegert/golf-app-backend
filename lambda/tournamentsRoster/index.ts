import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

// tournaments-roster Lambda (see docs/blueprint.md's Lambda decomposition) -- one handler
// routed by AppSync field name, deliberately kept as a single function despite mixing public
// (joinTournament) and privileged (organizer/co-admin-only) operations: every operation here
// needs identical AWS IAM (Tournaments table write, nothing else), so splitting wouldn't
// create a real AWS-enforced security perimeter, only code-organization clarity. Authorization
// between the public and privileged paths is enforced in application code below instead.

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TOURNAMENTS_TABLE_NAME!;

interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: { sub?: string };
}

export const handler = async (event: AppSyncEvent) => {
  switch (event.info.fieldName) {
    case 'createTournament':
      return createTournament(event);
    case 'joinTournament':
      return joinTournament(event);
    case 'updateTournament':
      return updateTournament(event);
    case 'assignCoAdmin':
      return assignCoAdmin(event);
    case 'createTeams':
      return createTeams(event);
    case 'updateTeam':
      return updateTeam(event);
    case 'assignTournamentPlayer':
      return assignTournamentPlayer(event);
    default:
      throw new Error(`tournamentsRoster: unhandled field "${event.info.fieldName}"`);
  }
};

function requireCaller(event: AppSyncEvent): string {
  const id = event.identity?.sub;
  if (!id) {
    throw new Error(`${event.info.fieldName}: no authenticated caller identity on the event`);
  }
  return id;
}

// 8 hex chars from a fresh UUID -- not security-critical (this is a friends-trip invite code,
// not a password), just needs to be short enough to type/read aloud and non-guessable enough
// in practice. Looked up via GSI2, kept deliberately separate from tournamentId (see the
// "Invite code" open question in the plan) so a leaked link can be rotated later without
// touching the tournament's real, structurally load-bearing primary key.
function generateInviteCode(): string {
  return randomUUID().slice(0, 8).toUpperCase();
}

// Always aliases attribute names via ExpressionAttributeNames (#key), not just known reserved
// words like "name" -- cheap insurance against DynamoDB's ~600-word reserved list, and every
// dynamic-update call site here goes through this one helper instead of re-deriving the
// expression inline.
function buildDynamicUpdate(fields: Record<string, unknown>) {
  const provided = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (provided.length === 0) {
    throw new Error('at least one field must be provided');
  }
  const setClauses = provided.map(([key]) => `#${key} = :${key}`).join(', ');
  const names = Object.fromEntries(provided.map(([key]) => [`#${key}`, key]));
  const values = Object.fromEntries(provided.map(([key, value]) => [`:${key}`, value]));
  return { setClauses, names, values };
}

async function getTournament(tournamentId: string) {
  const result = await client.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: `TOURNAMENT#${tournamentId}`, SK: 'METADATA' } }),
  );
  return result.Item;
}

async function assertOrganizerOrCoAdmin(tournamentId: string, callerId: string) {
  const tournament = await getTournament(tournamentId);
  if (!tournament) {
    throw new Error(`tournament ${tournamentId} not found`);
  }
  if (tournament.organizerId !== callerId && tournament.coAdminId !== callerId) {
    throw new Error("not authorized: caller is not this tournament's organizer or co-admin");
  }
  return tournament;
}

async function createTournament(event: AppSyncEvent) {
  const organizerId = requireCaller(event);

  const name = event.arguments.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('createTournament: name is required');
  }
  const startDate = (event.arguments.startDate as string | undefined) ?? null;
  const endDate = (event.arguments.endDate as string | undefined) ?? null;

  const id = randomUUID();
  const inviteCode = generateInviteCode();
  const item = {
    PK: `TOURNAMENT#${id}`,
    SK: 'METADATA',
    id,
    name,
    createdAt: new Date().toISOString(),
    organizerId,
    inviteCode,
    startDate,
    endDate,
    coAdminId: null,
    wagerPotAmount: null,
    GSI2PK: `INVITECODE#${inviteCode}`,
    GSI2SK: 'METADATA',
  };

  await client.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return item;
}

async function joinTournament(event: AppSyncEvent) {
  const playerId = requireCaller(event);

  const inviteCode = event.arguments.inviteCode;
  if (typeof inviteCode !== 'string' || inviteCode.trim().length === 0) {
    throw new Error('joinTournament: inviteCode is required');
  }

  const lookup = await client.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': `INVITECODE#${inviteCode}` },
      Limit: 1,
    }),
  );
  const tournament = lookup.Items?.[0];
  if (!tournament) {
    throw new Error('joinTournament: invalid invite code');
  }

  const now = new Date().toISOString();
  const sortDate = tournament.startDate ?? tournament.createdAt;

  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TOURNAMENT#${tournament.id}`, SK: `PLAYER#${playerId}` },
      UpdateExpression:
        'SET tournamentId = :tournamentId, playerId = :playerId, ' +
        'teamId = if_not_exists(teamId, :null), handicap = if_not_exists(handicap, :null), ' +
        'joinedAt = if_not_exists(joinedAt, :now), ' +
        'GSI1PK = :gsi1pk, GSI1SK = :gsi1sk',
      ExpressionAttributeValues: {
        ':tournamentId': tournament.id,
        ':playerId': playerId,
        ':null': null,
        ':now': now,
        ':gsi1pk': `PLAYER#${playerId}`,
        ':gsi1sk': `TOURNAMENT#${sortDate}#${tournament.id}`,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  return result.Attributes;
}

async function updateTournament(event: AppSyncEvent) {
  const callerId = requireCaller(event);
  const tournamentId = event.arguments.tournamentId as string;
  await assertOrganizerOrCoAdmin(tournamentId, callerId);

  const { setClauses, names, values } = buildDynamicUpdate({
    name: event.arguments.name,
    startDate: event.arguments.startDate,
    endDate: event.arguments.endDate,
    wagerPotAmount: event.arguments.wagerPotAmount,
  });

  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TOURNAMENT#${tournamentId}`, SK: 'METADATA' },
      UpdateExpression: `SET ${setClauses}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );

  return result.Attributes;
}

async function assignCoAdmin(event: AppSyncEvent) {
  const callerId = requireCaller(event);
  const tournamentId = event.arguments.tournamentId as string;
  await assertOrganizerOrCoAdmin(tournamentId, callerId);

  const playerId = event.arguments.playerId as string;
  if (!playerId) {
    throw new Error('assignCoAdmin: playerId is required');
  }

  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TOURNAMENT#${tournamentId}`, SK: 'METADATA' },
      UpdateExpression: 'SET coAdminId = :playerId',
      ExpressionAttributeValues: { ':playerId': playerId },
      ReturnValues: 'ALL_NEW',
    }),
  );

  return result.Attributes;
}

async function createTeams(event: AppSyncEvent) {
  const callerId = requireCaller(event);
  const tournamentId = event.arguments.tournamentId as string;
  await assertOrganizerOrCoAdmin(tournamentId, callerId);

  const teams = event.arguments.teams as Array<{ name: string; color?: string }>;
  if (!Array.isArray(teams) || teams.length === 0) {
    throw new Error('createTeams: teams must be a non-empty array');
  }

  const now = new Date().toISOString();
  const items = teams.map((team) => {
    const id = randomUUID();
    return {
      PK: `TOURNAMENT#${tournamentId}`,
      SK: `TEAM#${id}`,
      id,
      tournamentId,
      name: team.name,
      color: team.color ?? null,
      createdAt: now,
    };
  });

  await Promise.all(items.map((item) => client.send(new PutCommand({ TableName: TABLE_NAME, Item: item }))));

  return items;
}

async function updateTeam(event: AppSyncEvent) {
  const callerId = requireCaller(event);
  const tournamentId = event.arguments.tournamentId as string;
  await assertOrganizerOrCoAdmin(tournamentId, callerId);

  const teamId = event.arguments.teamId as string;
  const { setClauses, names, values } = buildDynamicUpdate({
    name: event.arguments.name,
    color: event.arguments.color,
  });

  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TOURNAMENT#${tournamentId}`, SK: `TEAM#${teamId}` },
      UpdateExpression: `SET ${setClauses}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );

  return result.Attributes;
}

async function assignTournamentPlayer(event: AppSyncEvent) {
  const callerId = requireCaller(event);
  const tournamentId = event.arguments.tournamentId as string;
  await assertOrganizerOrCoAdmin(tournamentId, callerId);

  // tournamentPlayers.assign's "tournamentPlayerId" param (blueprint.md) has no separate
  // identity in the key schema -- the join entity is keyed by (tournamentId, playerId)
  // directly (SK = PLAYER#<playerId>), so this RPC takes playerId, not a separate ID.
  const playerId = event.arguments.playerId as string;
  const teamId = event.arguments.teamId as string | undefined;
  const handicap = event.arguments.handicap as number | undefined;

  if (teamId !== undefined) {
    const team = await client.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { PK: `TOURNAMENT#${tournamentId}`, SK: `TEAM#${teamId}` } }),
    );
    if (!team.Item) {
      throw new Error(`assignTournamentPlayer: team ${teamId} not found in this tournament`);
    }
  }

  const { setClauses, names, values } = buildDynamicUpdate({ teamId, handicap });

  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TOURNAMENT#${tournamentId}`, SK: `PLAYER#${playerId}` },
      UpdateExpression: `SET ${setClauses}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }),
  );

  return result.Attributes;
}
