import { getMe } from './session';

/** aws-amplify/auth 互換: Cognito セッションの代わりに Databricks SSO のユーザー情報を返す */
const token = (value: string, payload: Record<string, unknown>) => ({
  payload,
  toString: () => value,
});

export const fetchAuthSession = async (_opts?: unknown) => {
  const me = await getMe();
  const payload = { sub: me.sub, email: me.email, 'cognito:groups': me.groups };
  return {
    tokens: { idToken: token(me.idToken, payload), accessToken: token(me.idToken, payload) },
    identityId: `dbx-${me.sub}`,
    userSub: me.sub,
    credentials: undefined,
  };
};

export const getCurrentUser = async () => {
  const me = await getMe();
  return { userId: me.sub, username: me.email, signInDetails: { loginId: me.email } };
};

export const fetchUserAttributes = async () => {
  const me = await getMe();
  return { sub: me.sub, email: me.email };
};

/** サインイン／サインアウトは Databricks SSO が担う */
export const signIn = async (_input?: unknown) => ({ isSignedIn: true, nextStep: { signInStep: 'DONE' } });
export const signInWithRedirect = async (_input?: unknown) => {};
export const signOut = async (_input?: unknown) => {};
export type SignInInput = { username: string; password?: string; options?: unknown };
