import crypto from 'node:crypto';
import type { Request } from 'express';

export type RequestUser = { userId: string; email: string; groups: string[] };

/**
 * Express のリクエストを API Gateway (REST, Lambda proxy 統合) のイベントに変換する。
 * Cognito オーソライザが付与していた claims を Databricks のユーザー情報で埋める。
 * Authorization ヘッダは「Bearer dbx:<userId>」とし、Cognito Identity 互換シムが Identity ID に解決する。
 */
export const toApiGatewayEvent = (
  req: Request,
  user: RequestUser,
  resource: string,
  pathParameters: Record<string, string>,
) => {
  const headers: Record<string, string> = {};
  const multiValueHeaders: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const values = Array.isArray(v) ? v : [String(v)];
    headers[k] = values.join(',');
    multiValueHeaders[k] = values;
  }
  const authorization = `Bearer dbx:${user.userId}`;
  headers.Authorization = authorization;
  headers.authorization = authorization;

  const query: Record<string, string> = {};
  const multiQuery: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(req.query)) {
    const values = (Array.isArray(v) ? v : [v]).map(String);
    query[k] = values[values.length - 1];
    multiQuery[k] = values;
  }

  const body = typeof req.body === 'string' && req.body.length > 0 ? req.body : null;

  return {
    resource,
    path: req.path,
    httpMethod: req.method,
    headers,
    multiValueHeaders,
    queryStringParameters: Object.keys(query).length ? query : null,
    multiValueQueryStringParameters: Object.keys(multiQuery).length ? multiQuery : null,
    pathParameters: Object.keys(pathParameters).length ? pathParameters : null,
    stageVariables: null,
    body,
    isBase64Encoded: false,
    requestContext: {
      accountId: '000000000000',
      apiId: 'databricks',
      stage: 'api',
      httpMethod: req.method,
      path: req.originalUrl,
      resourcePath: resource,
      requestId: crypto.randomUUID(),
      requestTimeEpoch: Date.now(),
      identity: { sourceIp: String(req.headers['x-real-ip'] ?? req.ip ?? ''), userAgent: req.headers['user-agent'] ?? '' },
      authorizer: {
        claims: {
          sub: user.userId,
          email: user.email,
          'cognito:username': user.userId,
          'cognito:groups': user.groups.join(','),
        },
      },
    },
  };
};

/** Lambda の Context 相当（ストリーミング Lambda では context.identity.cognitoIdentityId を参照している） */
export const lambdaContext = (functionName: string, identityId?: string) => ({
  functionName,
  awsRequestId: crypto.randomUUID(),
  callbackWaitsForEmptyEventLoop: true,
  getRemainingTimeInMillis: () => 110_000,
  identity: identityId ? { cognitoIdentityId: identityId, cognitoIdentityPoolId: 'databricks:identity-pool' } : undefined,
});
