import { util } from '@aws-appsync/utils';

export function request(ctx) {
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ PK: `PLAYER#${ctx.args.id}`, SK: 'PROFILE' }),
  };
}

// email is the one field worth gating -- visible to the profile's owner only, until a
// Friendship/opt-in-sharing concept exists (see docs/blueprint.md). displayName/avatarUrl
// stay public to any signed-in caller, since the point of those fields is other players
// seeing teammates' names/avatars on a tournament roster.
export function response(ctx) {
  const item = ctx.result;
  if (!item) return null;

  const isOwner = ctx.identity.sub === item.id;
  return {
    ...item,
    email: isOwner ? item.email : null,
  };
}
