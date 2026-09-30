import { clientWith, command } from '../../_common/aws';

/**
 * Cognito Identity Pool → Databricks ユーザー ID に 1:1 対応する擬似 Identity ID。
 * サーバは Authorization ヘッダに "Bearer dbx:<userId>" を設定してハンドラを呼ぶ（server/event.ts）。
 * ファイルの所有者チェック（S3 キー先頭 = Identity ID）はこの値で元コードのまま機能する。
 */
export const identityIdFor = (userId: string) => `dbx-${userId}`;

export const GetIdCommand = command('GetId');
export const ListIdentityPoolsCommand = command('ListIdentityPools');
export const DescribeIdentityPoolCommand = command('DescribeIdentityPool');

const POOL_ID = 'databricks:identity-pool';

export const CognitoIdentityClient = clientWith({
  ListIdentityPools: async () => ({ IdentityPools: [{ IdentityPoolId: POOL_ID }] }),
  DescribeIdentityPool: async () => ({
    IdentityPoolId: POOL_ID,
    CognitoIdentityProviders: [
      {
        ProviderName: `cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.USER_POOL_ID}`,
      },
    ],
  }),
  GetId: async (i) => {
    const token = String(Object.values(i.Logins ?? {})[0] ?? '');
    const m = /^dbx:(.+)$/.exec(token);
    if (!m) throw new Error('Invalid identity token');
    return { IdentityId: identityIdFor(m[1]) };
  },
});
