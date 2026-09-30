import type { ReactNode } from 'react';
import { signOut as dbxSignOut } from './aws-amplify-auth';

/**
 * @aws-amplify/ui-react 互換: ログイン画面（Authenticator）は描画せず、常に認証済みとして子要素を表示する。
 * 認証は Databricks Apps の前段（ワークスペース SSO）で完了している。
 */
type AuthenticatorProps = { children?: ReactNode | ((p: { signOut: () => void; user: unknown }) => ReactNode) } & Record<
  string,
  unknown
>;

const context = {
  route: 'authenticated',
  authStatus: 'authenticated',
  user: { userId: '', username: '' },
  signOut: () => {
    void dbxSignOut();
  },
};

export const Authenticator = Object.assign(
  ({ children }: AuthenticatorProps) => (
    <>{typeof children === 'function' ? children({ signOut: context.signOut, user: context.user }) : children}</>
  ),
  { Provider: ({ children }: { children?: ReactNode }) => <>{children}</> },
);

export const useAuthenticator = (_selector?: unknown) => context;
export const translations = {};
export const withAuthenticator = <T,>(c: T) => c;
