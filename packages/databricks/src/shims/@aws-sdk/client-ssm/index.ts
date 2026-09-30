import { clientWith, command } from '../../_common/aws';

export const GetParameterCommand = command('GetParameter');
export const SSMClient = clientWith({});
