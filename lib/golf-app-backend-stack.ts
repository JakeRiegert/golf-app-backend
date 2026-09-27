import * as cdk from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as iam from 'aws-cdk-lib/aws-iam';
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

    // --- CI/CD: GitHub Actions OIDC federation, no stored AWS credentials in GitHub ---
    // GitHub's token issuer, trusted account-wide. clientIds: ['sts.amazonaws.com'] is the
    // fixed audience GitHub's OIDC tokens carry -- required, not a per-repo value.
    const githubOidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    // Scoped to exactly this repo, exactly the main branch -- a workflow run from a PR
    // branch, a fork, or any other repo cannot assume this role, only a push to main here.
    const githubDeployRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: 'github-actions-golf-app-backend-deploy',
      assumedBy: new iam.FederatedPrincipal(
        githubOidcProvider.openIdConnectProviderArn,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub':
              'repo:JakeRiegert/golf-app-backend:ref:refs/heads/main',
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      // AdministratorAccess, same pragmatic call as the jake-dev local IAM user (see
      // docs/blueprint.md) -- broader than ideal, reasonable for a solo hobby project,
      // worth scoping down later rather than blocking on it now.
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // aws-actions/configure-aws-credentials tags the assumed session by default even under
    // OIDC. sts:AssumeRoleWithWebIdentity alone isn't enough to permit that -- sts:TagSession
    // must be explicitly allowed too, or AWS denies the whole request (surfaced as a generic
    // "Not authorized to perform sts:AssumeRoleWithWebIdentity", not a tagging-specific error,
    // which is what made this one non-obvious to diagnose from the log alone).
    githubDeployRole.assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.FederatedPrincipal(githubOidcProvider.openIdConnectProviderArn, {})],
        actions: ['sts:TagSession'],
        conditions: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub':
              'repo:JakeRiegert/golf-app-backend:ref:refs/heads/main',
          },
        },
      }),
    );

    new cdk.CfnOutput(this, 'GitHubActionsDeployRoleArn', {
      value: githubDeployRole.roleArn,
    });
  }
}
