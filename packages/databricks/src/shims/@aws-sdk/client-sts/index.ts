import { clientWith, command } from '../../_common/aws';

export const AssumeRoleCommand = command('AssumeRole');
export const GetCallerIdentityCommand = command('GetCallerIdentity');
export const STSClient = clientWith({
  GetCallerIdentity: async () => ({ Account: '000000000000', Arn: 'arn:databricks:app' }),
});
