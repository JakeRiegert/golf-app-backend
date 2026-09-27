import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

// First real Lambda RPC, replacing the direct AppSync -> DynamoDB resolver createTournament
// used in the initial thin slice (see docs/blueprint.md's Lambda decomposition -- this is the
// seed of the real tournaments-roster Lambda). One handler routed by AppSync field name, the
// standard shape for an AppSync direct-Lambda-resolver data source; more tournaments-roster
// operations (join, update, assignCoAdmin, createTeams, tournamentPlayers.assign) get added
// as more cases here, not as separate Lambdas -- see the "kept as one function" reasoning in
// blueprint.md for why.

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
    default:
      throw new Error(`tournamentsRoster: unhandled field "${event.info.fieldName}"`);
  }
};

async function createTournament(event: AppSyncEvent) {
  const organizerId = event.identity?.sub;
  if (!organizerId) {
    throw new Error('createTournament: no authenticated caller identity on the event');
  }

  const name = event.arguments.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('createTournament: name is required');
  }

  const id = randomUUID();
  const item = {
    PK: `TOURNAMENT#${id}`,
    SK: 'METADATA',
    id,
    name,
    createdAt: new Date().toISOString(),
    organizerId,
  };

  await client.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));

  return item;
}
