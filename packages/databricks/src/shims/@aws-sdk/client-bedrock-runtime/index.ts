/**
 * @aws-sdk/client-bedrock-runtime shim for Databricks Foundation Model API.
 * Translates Bedrock Converse API calls to Databricks OpenAI-compatible chat completions.
 */

import { databricksFetch } from 'genai-dbx-runtime';
import {
  AccessDeniedException,
  ServiceQuotaExceededException,
  ThrottlingException,
  ValidationException,
  mapHttpError,
} from './bedrock-helpers.js';
import { mapModelIdToEndpoint } from './bedrock-modelMap.js';
import { buildOpenAIRequest } from './bedrock-messages.js';
import { extractOpenAIResponseText, parseStreamResponse, buildOpenAIStreamRequest } from './bedrock-streaming.js';

// Re-export error classes
export { AccessDeniedException, ServiceQuotaExceededException, ThrottlingException, ValidationException };

// Re-export types from real AWS SDK (types are erased at runtime, so this is safe)
// ConversationRole は元コードで値（enum）としても参照されるため実体を定義する
export const ConversationRole = { USER: 'user', ASSISTANT: 'assistant' } as const;
export type ConversationRole = (typeof ConversationRole)[keyof typeof ConversationRole];

export type {
  ContentBlock,
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamCommandInput,
  ConverseStreamOutput,
  SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';

/**
 * Bedrock Converse API command implementation.
 */
export class ConverseCommand {
  constructor(private input: any) {}

  getInput() {
    return this.input;
  }
}

/**
 * Bedrock Converse Stream API command implementation.
 */
export class ConverseStreamCommand {
  constructor(private input: any) {}

  getInput() {
    return this.input;
  }
}

/**
 * Image generation command (not supported on Databricks).
 */
export class InvokeModelCommand {
  constructor(_input: any) {}

  getInput() {
    throw new Error('Image generation is not supported');
  }
}

/**
 * Bedrock Runtime Client (Databricks-backed).
 */
export class BedrockRuntimeClient {
  constructor(_config?: any) {
    // Config is accepted for AWS SDK compatibility but not used.
    // Databricks auth is handled via environment variables.
  }

  async send(command: ConverseCommand | ConverseStreamCommand | InvokeModelCommand): Promise<any> {
    if (command instanceof ConverseCommand) {
      return this.handleConverse(command.getInput());
    } else if (command instanceof ConverseStreamCommand) {
      return this.handleConverseStream(command.getInput());
    } else if (command instanceof InvokeModelCommand) {
      throw new Error('Image generation (InvokeModelCommand) is not supported on Databricks');
    }
    throw new Error('Unknown command type');
  }

  private async handleConverse(input: any) {
    // Map Bedrock model ID to Databricks endpoint
    const endpoint = mapModelIdToEndpoint(input.modelId);
    const path = `/serving-endpoints/${endpoint}/invocations`;

    // Build OpenAI-compatible request
    const baseRequest = buildOpenAIRequest(input);
    const requestBody = {
      ...baseRequest,
      model: endpoint,
    };

    const response = await databricksFetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw mapHttpError(response.status, errorBody);
    }

    const data = await response.json() as any;
    const text = extractOpenAIResponseText(data);

    // Convert back to Bedrock format
    return {
      output: {
        message: {
          role: 'assistant' as const,
          content: [{ text }],
        },
      },
      stopReason: 'end_turn' as const,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  }

  private async handleConverseStream(input: any) {
    // Map Bedrock model ID to Databricks endpoint
    const endpoint = mapModelIdToEndpoint(input.modelId);
    const path = `/serving-endpoints/${endpoint}/invocations`;

    // Build OpenAI-compatible streaming request
    const baseRequest = buildOpenAIRequest(input);
    const requestBody = buildOpenAIStreamRequest({
      ...baseRequest,
      model: endpoint,
    });

    const response = await databricksFetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw mapHttpError(response.status, errorBody);
    }

    // Return async iterable stream
    return {
      stream: parseStreamResponse(response),
    };
  }
}

/**
 * Dummy credential provider for compatibility with fromTemporaryCredentials.
 * Databricks uses token-based auth, so we don't need AWS-style credentials.
 */
export async function fromTemporaryCredentials(config: any): Promise<any> {
  return {
    resolveAwsCredentials: async () => ({
      accessKeyId: 'dummy',
      secretAccessKey: 'dummy',
      sessionToken: 'dummy',
    }),
  };
}
