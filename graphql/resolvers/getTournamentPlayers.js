import { util } from '@aws-appsync/utils';

export function request(ctx) {
  return {
    operation: 'Query',
    query: {
      expression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      expressionValues: util.dynamodb.toMapValues({
        ':pk': `TOURNAMENT#${ctx.args.tournamentId}`,
        ':skPrefix': 'PLAYER#',
      }),
    },
  };
}

export function response(ctx) {
  return ctx.result.items;
}
