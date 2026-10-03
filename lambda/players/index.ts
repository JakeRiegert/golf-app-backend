import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';

// First real operation of the players Lambda (see docs/blueprint.md's Lambda decomposition,
// function #1) -- upsertPlayerProfile only for now; updateNotificationPrefs gets added as a
// second case here once the notification rules engine exists, same "one function, routed by
// fieldName" shape as tournamentsRoster.

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});
const TABLE_NAME = process.env.PLAYERS_TABLE_NAME!;
const USER_POOL_ID = process.env.USER_POOL_ID!;

interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: { sub?: string; claims?: Record<string, unknown> };
}

export const handler = async (event: AppSyncEvent) => {
  switch (event.info.fieldName) {
    case 'upsertPlayerProfile':
      return upsertPlayerProfile(event);
    default:
      throw new Error(`players: unhandled field "${event.info.fieldName}"`);
  }
};

// Amplify Flutter's AppSync Cognito User Pools auth provider sends the ACCESS token, not the
// ID token (amplify_auth_cognito_dart's CognitoUserPoolsAuthProvider.getLatestAuthToken() is
// hardcoded to `userPoolTokensResult.value.accessToken`, not configurable) -- so
// event.identity.claims never carries email, since access tokens don't carry profile claims
// per OIDC. Looked up directly from Cognito instead. ListUsers (filtered by sub), not
// AdminGetUser, since AdminGetUser needs the exact Cognito username, which isn't guaranteed to
// equal sub for a federated (Google) identity -- ListUsers's sub filter works for both.
async function lookupEmail(sub: string): Promise<string | null> {
  const result = await cognito.send(
    new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `sub = "${sub}"`,
      Limit: 1,
    }),
  );
  const attributes = result.Users?.[0]?.Attributes;
  return attributes?.find((a) => a.Name === 'email')?.Value ?? null;
}

async function upsertPlayerProfile(event: AppSyncEvent) {
  const id = event.identity?.sub;
  if (!id) {
    throw new Error('upsertPlayerProfile: no authenticated caller identity on the event');
  }

  const email = await lookupEmail(id);
  const displayName = (event.arguments.displayName as string | undefined) ?? null;
  const avatarUrl = (event.arguments.avatarUrl as string | undefined) ?? null;
  const now = new Date().toISOString();

  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `PLAYER#${id}`, SK: 'PROFILE' },
      UpdateExpression:
        'SET id = :id, email = :email, displayName = :displayName, avatarUrl = :avatarUrl, ' +
        'updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: {
        ':id': id,
        ':email': email,
        ':displayName': displayName,
        ':avatarUrl': avatarUrl,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  return result.Attributes;
}
