import crypto from 'node:crypto';
import { clientWith, command } from '../../_common/aws';

/** AWS KMS GenerateMac → HMAC-SHA256（鍵は GENAI_USER_ID_HMAC_KEY、Databricks シークレットから注入） */
export const GenerateMacCommand = command('GenerateMac');

export const KMSClient = clientWith({
  GenerateMac: async (i) => {
    const key = process.env.GENAI_USER_ID_HMAC_KEY ?? process.env.DATABRICKS_CLIENT_SECRET ?? 'local-dev';
    const mac = crypto.createHmac('sha256', `${i.KeyId}:${key}`).update(Buffer.from(i.Message)).digest();
    return { Mac: new Uint8Array(mac), KeyId: i.KeyId, MacAlgorithm: i.MacAlgorithm };
  },
});
