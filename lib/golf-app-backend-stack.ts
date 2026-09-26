import * as cdk from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import { Construct } from 'constructs';
import * as path from 'path';

// Golf Live Scoring — first end-to-end slice: create a tournament with just a name.
// Scope deliberately cut down from the full design (see docs/blueprint.md in the design
// repo): native Cognito auth instead of Google/Apple federation, and a direct AppSync ->
// DynamoDB resolver instead of the tournaments-roster Lambda. Both get layered back in once
// this thin slice is proven end to end.

export class GolfAppBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Auth: Cognito User Pool, native email/password for now ---
    const userPool = new cognito.UserPool(this, 'GolfAppUserPool', {
      userPoolName: 'golf-app-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: false,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev/portfolio project -- fine to tear down
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'GolfAppUserPoolClient', {
      userPool,
      authFlows: { userSrp: true },
      generateSecret: false, // required for a mobile/public client
    });

    // --- Data: Tournaments table ---
    // On-demand billing (see cost guardrails in docs/blueprint.md). PK/SK match the
    // single-table pattern already designed for the real Tournaments table -- this slice
    // only ever writes the Tournament METADATA item, but the key shape is the real one.
    const tournamentsTable = new dynamodb.TableV2(this, 'TournamentsTable', {
      tableName: 'Tournaments',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // dev/portfolio project
    });

    // --- API: AppSync GraphQL, Cognito-authorized ---
    const api = new appsync.GraphqlApi(this, 'GolfAppApi', {
      name: 'golf-app-api',
      definition: appsync.Definition.fromFile(
        path.join(__dirname, '../graphql/schema.graphql'),
      ),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
      },
      logConfig: { fieldLogLevel: appsync.FieldLogLevel.ERROR },
    });

    const tournamentsDataSource = api.addDynamoDbDataSource(
      'TournamentsDataSource',
      tournamentsTable,
    );

    tournamentsDataSource.createResolver('CreateTournamentResolver', {
      typeName: 'Mutation',
      fieldName: 'createTournament',
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      code: appsync.Code.fromAsset(
        path.join(__dirname, '../graphql/resolvers/createTournament.js'),
      ),
    });

    tournamentsDataSource.createResolver('GetTournamentResolver', {
      typeName: 'Query',
      fieldName: 'getTournament',
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      code: appsync.Code.fromAsset(
        path.join(__dirname, '../graphql/resolvers/getTournament.js'),
      ),
    });

    // --- Outputs the Flutter app's Amplify config needs ---
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'GraphQLApiUrl', { value: api.graphqlUrl });
    new cdk.CfnOutput(this, 'GraphQLApiId', { value: api.apiId });
    new cdk.CfnOutput(this, 'Region', { value: cdk.Stack.of(this).region });
  }
}
