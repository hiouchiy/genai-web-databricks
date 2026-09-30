import { files } from 'genai-dbx-runtime';
import type { ShimClient, ShimCommand } from '../../_common/aws';

/** S3 署名付き URL → アプリ自身が検証する HMAC 署名付き URL（UC Volume へのプロキシ） */
export const getSignedUrl = async (
  _client: ShimClient,
  cmd: ShimCommand,
  options: { expiresIn?: number } = {},
): Promise<string> => {
  const method = cmd.op === 'PutObject' ? 'PUT' : 'GET';
  return files.presignUrl(
    method,
    cmd.input.Bucket,
    cmd.input.Key,
    options.expiresIn ?? 900,
    cmd.input.ResponseContentType,
  );
};
