import { secrets } from 'genai-dbx-runtime';
import { clientWith, command, exception } from '../../_common/aws';

/** AWS Secrets Manager → Lakebase（AES-GCM 暗号化） */
export const ResourceNotFoundException = exception('ResourceNotFoundException');
export const ResourceExistsException = exception('ResourceExistsException');

export const GetSecretValueCommand = command('GetSecretValue');
export const CreateSecretCommand = command('CreateSecret');
export const PutSecretValueCommand = command('PutSecretValue');
export const DeleteSecretCommand = command('DeleteSecret');

export const SecretsManagerClient = clientWith({
  GetSecretValue: async (i) => {
    const v = await secrets.getSecret(i.SecretId);
    if (v === undefined) throw new ResourceNotFoundException({ message: `${i.SecretId} not found` });
    return { Name: i.SecretId, SecretString: v };
  },
  CreateSecret: async (i) => {
    if ((await secrets.getSecret(i.Name)) !== undefined) {
      throw new ResourceExistsException({ message: `${i.Name} already exists` });
    }
    await secrets.putSecret(i.Name, i.SecretString);
    return { Name: i.Name };
  },
  PutSecretValue: async (i) => {
    if ((await secrets.getSecret(i.SecretId)) === undefined) {
      throw new ResourceNotFoundException({ message: `${i.SecretId} not found` });
    }
    await secrets.putSecret(i.SecretId, i.SecretString);
    return { Name: i.SecretId };
  },
  DeleteSecret: async (i) => {
    if (!(await secrets.deleteSecret(i.SecretId))) {
      throw new ResourceNotFoundException({ message: `${i.SecretId} not found` });
    }
    return { Name: i.SecretId };
  },
});
