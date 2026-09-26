import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const id = util.autoId();
  const now = util.time.nowISO8601();
  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ PK: `TOURNAMENT#${id}`, SK: 'METADATA' }),
    attributeValues: util.dynamodb.toMapValues({
      id,
      name: ctx.args.name,
      createdAt: now,
      organizerId: ctx.identity.sub,
    }),
  };
}

export function response(ctx) {
  return ctx.result;
}
