import { queue } from 'genai-dbx-runtime';
import { clientWith, command } from '../../_common/aws';

/** Amazon SQS → アプリ内キュー（runtime/queue.ts） */
export const SendMessageCommand = command('SendMessage');
export const ChangeMessageVisibilityCommand = command('ChangeMessageVisibility');
export const DeleteMessageCommand = command('DeleteMessage');

export const SQSClient = clientWith({
  SendMessage: async (i) => ({
    MessageId: queue.sendMessage(i.QueueUrl, i.MessageBody, i.DelaySeconds ?? 0),
  }),
  ChangeMessageVisibility: async (i) => {
    queue.changeVisibility(i.ReceiptHandle, i.VisibilityTimeout);
    return {};
  },
  DeleteMessage: async () => ({}),
});
