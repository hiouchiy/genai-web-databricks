import { identity } from 'genai-dbx-runtime';
import { type AnyInput, clientWith, command, exception } from '../../_common/aws';

/** Cognito User Pool → Databricks ワークスペースユーザー（SCIM）+ Lakebase のグループ所属 */
export const UserNotFoundException = exception('UserNotFoundException');

const toCognitoUser = (u: { userId: string; email: string }) => ({
  Username: u.userId,
  Enabled: true,
  UserStatus: 'CONFIRMED',
  Attributes: [
    { Name: 'sub', Value: u.userId },
    { Name: 'email', Value: u.email },
    { Name: 'email_verified', Value: 'true' },
  ],
});

/** ListUsers の Filter（例: email="a@b.c", sub="123"）を解釈する */
const parseFilter = (filter: string | undefined) => {
  const m = /^\s*(\w+)\s*\^?=\s*"(.*)"\s*$/.exec(filter ?? '');
  return m ? { attr: m[1], value: m[2] } : undefined;
};

export const ListUsersCommand = command('ListUsers');
export const AdminGetUserCommand = command('AdminGetUser');
export const AdminAddUserToGroupCommand = command('AdminAddUserToGroup');
export const AdminRemoveUserFromGroupCommand = command('AdminRemoveUserFromGroup');
export const AdminListGroupsForUserCommand = command('AdminListGroupsForUser');
export const AdminDeleteUserCommand = command('AdminDeleteUser');
export const AdminSetUserPasswordCommand = command('AdminSetUserPassword');
export const AdminUserGlobalSignOutCommand = command('AdminUserGlobalSignOut');

export const CognitoIdentityProviderClient = clientWith({
  ListUsers: async (i: AnyInput) => {
    const f = parseFilter(i.Filter);
    let user: { userId: string; email: string } | undefined;
    if (f?.attr === 'email') user = await identity.findUserByEmail(f.value);
    else if (f?.attr === 'sub' || f?.attr === 'username') user = await identity.findUserById(f.value);
    return { Users: user ? [toCognitoUser(user)] : [] };
  },
  AdminGetUser: async (i: AnyInput) => {
    const u = await identity.findUserById(i.Username);
    if (!u) throw new UserNotFoundException({ message: 'User does not exist.' });
    return { ...toCognitoUser(u), UserAttributes: toCognitoUser(u).Attributes };
  },
  AdminAddUserToGroup: async (i: AnyInput) => {
    await identity.addToGroup(i.Username, i.GroupName);
    return {};
  },
  AdminRemoveUserFromGroup: async (i: AnyInput) => {
    await identity.removeFromGroup(i.Username, i.GroupName);
    return {};
  },
  AdminListGroupsForUser: async (i: AnyInput) => ({
    Groups: (await identity.listGroups(i.Username)).map((GroupName) => ({ GroupName })),
  }),
  AdminDeleteUser: async (i: AnyInput) => {
    await identity.deleteUser(i.Username);
    return {};
  },
  // パスワード管理は Databricks SSO 側に委ねるため何もしない
  AdminSetUserPassword: async () => ({}),
  AdminUserGlobalSignOut: async () => ({}),
});
