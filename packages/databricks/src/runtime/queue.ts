import crypto from 'node:crypto';

/**
 * Amazon SQS + Lambda イベントソースマッピングの代替（プロセス内キュー）。
 * - SendMessage で投入 → 登録済みコンシューマ（元の pollExAppStatus ハンドラ）を SQSEvent 形式で呼ぶ
 * - ハンドラが例外を投げたら可視性タイムアウト後に再配信（ChangeMessageVisibility で延長可能）
 * - maxReceiveCount を超えたら破棄（DLQ 相当はログのみ）
 * 検証用途のためメモリ上で保持する（アプリ再起動で未完了メッセージは失われる）。
 */
type Message = {
  messageId: string;
  receiptHandle: string;
  body: string;
  queueUrl: string;
  receiveCount: number;
  visibleAt: number;
  visibilityTimeoutSec: number;
};

type Consumer = (event: unknown) => Promise<unknown>;

const messages = new Map<string, Message>();
const consumers = new Map<string, Consumer>();
const DEFAULT_VISIBILITY_SEC = Number(process.env.GENAI_QUEUE_VISIBILITY_SEC ?? 10);
const MAX_RECEIVE = Number(process.env.GENAI_QUEUE_MAX_RECEIVE ?? 60);

export const queueArn = (queueUrl: string) => {
  const name = queueUrl.split('/').pop() ?? 'queue';
  return `arn:aws:sqs:${process.env.AWS_REGION ?? 'ap-northeast-1'}:000000000000:${name}`;
};

export const registerConsumer = (queueUrl: string, consumer: Consumer) => {
  consumers.set(queueUrl, consumer);
};

export const sendMessage = (queueUrl: string, body: string, delaySeconds = 0): string => {
  const messageId = crypto.randomUUID();
  messages.set(messageId, {
    messageId,
    receiptHandle: messageId,
    body,
    queueUrl,
    receiveCount: 0,
    visibleAt: Date.now() + delaySeconds * 1000,
    visibilityTimeoutSec: DEFAULT_VISIBILITY_SEC,
  });
  return messageId;
};

export const changeVisibility = (receiptHandle: string, timeoutSec: number) => {
  const m = messages.get(receiptHandle);
  if (m) m.visibilityTimeoutSec = timeoutSec;
};

const deliver = async (m: Message, consumer: Consumer) => {
  m.receiveCount += 1;
  m.visibleAt = Date.now() + m.visibilityTimeoutSec * 1000;
  const event = {
    Records: [
      {
        messageId: m.messageId,
        receiptHandle: m.receiptHandle,
        body: m.body,
        attributes: { ApproximateReceiveCount: String(m.receiveCount) },
        messageAttributes: {},
        eventSource: 'aws:sqs',
        eventSourceARN: queueArn(m.queueUrl),
        awsRegion: process.env.AWS_REGION ?? 'ap-northeast-1',
      },
    ],
  };
  try {
    await consumer(event);
    messages.delete(m.messageId);
  } catch (e) {
    if (m.receiveCount >= MAX_RECEIVE) {
      console.error(`queue: message ${m.messageId} exceeded max receive count, dropped`, e);
      messages.delete(m.messageId);
    } else {
      // 再試行（visibleAt は受信時点 + 可視性タイムアウト。ハンドラ内で ChangeMessageVisibility されていれば反映）
      m.visibleAt = Date.now() + m.visibilityTimeoutSec * 1000;
    }
  }
};

let timer: NodeJS.Timeout | undefined;
export const startQueueWorker = (intervalMs = 1000) => {
  if (timer) return;
  const busy = new Set<string>();
  timer = setInterval(() => {
    const now = Date.now();
    for (const m of messages.values()) {
      const consumer = consumers.get(m.queueUrl);
      if (!consumer || busy.has(m.messageId) || m.visibleAt > now) continue;
      busy.add(m.messageId);
      void deliver(m, consumer).finally(() => busy.delete(m.messageId));
    }
  }, intervalMs);
  timer.unref();
};
