import { util } from '@aws-appsync/utils';

export function request(ctx) {
  return {
    operation: 'GetItem',
    key: util.dynamodb.toMapValues({ PK: `TOURNAMENT#${ctx.args.id}`, SK: 'METADATA' }),
  };
}

export function response(ctx) {
  return ctx.result;
}
