import { files } from 'genai-dbx-runtime';
import { type AnyInput, clientWith, command, exception } from '../../_common/aws';

/** Amazon S3 → Unity Catalog Volume（Files API） */
export const NoSuchKey = exception('NoSuchKey');

const toBody = (buf: Buffer) => ({
  transformToByteArray: async () => new Uint8Array(buf),
  transformToString: async (enc: BufferEncoding = 'utf8') => buf.toString(enc),
  transformToWebStream: () => new Blob([new Uint8Array(buf)]).stream(),
});

const bodyToBuffer = async (body: AnyInput): Promise<Buffer | string> => {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer());
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }
  return String(body);
};

export const PutObjectCommand = command('PutObject');
export const GetObjectCommand = command('GetObject');
export const DeleteObjectCommand = command('DeleteObject');
export const ListObjectsV2Command = command('ListObjectsV2');
export const HeadObjectCommand = command('HeadObject');

export const S3Client = clientWith({
  PutObject: async (i) => {
    await files.putFile(i.Bucket, i.Key, await bodyToBuffer(i.Body));
    return { ETag: '"dbx"' };
  },
  GetObject: async (i) => {
    try {
      const buf = await files.getFile(i.Bucket, i.Key);
      return { Body: toBody(buf), ContentLength: buf.length, ContentType: i.ResponseContentType };
    } catch (e) {
      if (e instanceof files.FileNotFoundError) throw new NoSuchKey({ message: e.message });
      throw e;
    }
  },
  HeadObject: async (i) => {
    const buf = await files.getFile(i.Bucket, i.Key);
    return { ContentLength: buf.length };
  },
  DeleteObject: async (i) => {
    await files.deleteFile(i.Bucket, i.Key);
    return {};
  },
  ListObjectsV2: async (i) => {
    const keys = await files.listFiles(i.Bucket, i.Prefix ?? '');
    return { Contents: keys.map((Key) => ({ Key })), KeyCount: keys.length, IsTruncated: false };
  },
});
