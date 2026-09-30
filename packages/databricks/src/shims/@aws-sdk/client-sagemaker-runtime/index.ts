import { clientWith, command } from '../../_common/aws';

export const InvokeEndpointCommand = command('InvokeEndpoint');
export const InvokeEndpointWithResponseStreamCommand = command('InvokeEndpointWithResponseStream');
export const SageMakerRuntimeClient = clientWith({});
