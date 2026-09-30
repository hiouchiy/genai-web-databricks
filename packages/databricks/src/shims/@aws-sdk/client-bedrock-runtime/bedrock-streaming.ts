/**
 * Handle streaming responses and convert from OpenAI format to Bedrock format.
 */

import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';

export interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Parse SSE stream from Databricks API and yield Bedrock-compatible events.
 */
export async function* parseStreamResponse(
  response: Response,
): AsyncGenerator<ConverseStreamOutput> {
  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let messageStartEmitted = false;
  let stopReason: string | undefined;
  // FMAPI はチャンクごとに累積 usage を返すことがあるため、最後の値を保持して終了時に 1 回だけ metadata を出す（Bedrock と同じ順序）
  let lastUsage: OpenAIStreamChunk['usage'] | undefined;
  const startedAt = Date.now();
  const contentBlockIndex = 0;

  const startEvent = () => ({ messageStart: { role: 'assistant' as const } }) as ConverseStreamOutput;

  try {
    let finished = false;
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          finished = true;
          break;
        }
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(data) as OpenAIStreamChunk;
        } catch (e) {
          console.warn('Failed to parse stream chunk:', e);
          continue;
        }
        if (chunk.usage) lastUsage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (!messageStartEmitted) {
          messageStartEmitted = true;
          yield startEvent();
        }
        if (choice.delta?.content) {
          yield {
            contentBlockDelta: { delta: { text: choice.delta.content }, contentBlockIndex },
          } as ConverseStreamOutput;
        }
        if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!messageStartEmitted) yield startEvent();
  yield { contentBlockStop: { contentBlockIndex } } as ConverseStreamOutput;
  // biome-ignore lint/suspicious/noExplicitAny: StopReason は SDK の文字列ユニオン
  yield { messageStop: { stopReason: (stopReason ?? 'end_turn') as any } } as ConverseStreamOutput;
  yield {
    metadata: {
      usage: {
        inputTokens: lastUsage?.prompt_tokens ?? 0,
        outputTokens: lastUsage?.completion_tokens ?? 0,
        totalTokens: lastUsage?.total_tokens ?? 0,
      },
      metrics: { latencyMs: Date.now() - startedAt },
    },
  } as ConverseStreamOutput;
}

/**
 * Map OpenAI finish_reason to Bedrock stopReason.
 */
function mapFinishReason(finishReason: string | null): string {
  if (!finishReason) return 'end_turn';

  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'content_filtered';
    default:
      return 'end_turn';
  }
}

/**
 * Extract message text from OpenAI response.
 */
export function extractOpenAIResponseText(response: any): string {
  if (response?.choices?.[0]?.message?.content) {
    return response.choices[0].message.content;
  }
  return '';
}

/**
 * Build OpenAI request with streaming flag.
 */
export function buildOpenAIStreamRequest(baseRequest: any): any {
  return {
    ...baseRequest,
    stream: true,
    stream_options: {
      include_usage: true,
    },
  };
}
