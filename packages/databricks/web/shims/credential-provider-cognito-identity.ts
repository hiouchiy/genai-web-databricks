/** Cognito Identity Pool の一時認証情報は不要（同一オリジンの App API を Cookie セッションで呼ぶ） */
export const fromCognitoIdentityPool = (_opts?: unknown) => async () => ({
  accessKeyId: 'databricks',
  secretAccessKey: 'databricks',
});
