/**
 * Translate Bedrock Converse message format to OpenAI-compatible format.
 */

import type {
  ContentBlock,
  ConversationRole,
  ConverseCommandInput,
  ConverseStreamCommandInput,
} from '@aws-sdk/client-bedrock-runtime';

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAIContentBlock[];
}

export interface OpenAIContentBlock {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: {
    url: string; // data:image/... URL
  };
}

/**
 * Convert Bedrock ContentBlock to OpenAI-compatible content.
 */
function contentBlockToOpenAI(block: ContentBlock): OpenAIContentBlock | null {
  if ('text' in block) {
    return {
      type: 'text',
      text: block.text,
    };
  }

  if ('image' in block && block.image) {
    const image = block.image;
    if (image.source && 'bytes' in image.source && image.source.bytes) {
      const bytes = image.source.bytes instanceof Buffer
        ? image.source.bytes
        : Buffer.from(image.source.bytes);
      const base64 = bytes.toString('base64');
      const mediaType = `image/${image.format}`;
      return {
        type: 'image_url',
        image_url: {
          url: `data:${mediaType};base64,${base64}`,
        },
      };
    }
  }

  if ('document' in block && block.document) {
    // For documents, include a text note
    const doc = block.document;
    return {
      type: 'text',
      text: `[添付ファイル ${doc.name}]`,
    };
  }

  // Other types (video, json, etc.) - not supported on Databricks
  // Include a placeholder note
  return {
    type: 'text',
    text: '[サポートされていない添付タイプ]',
  };
}

/**
 * Convert Bedrock message list to OpenAI format.
 */
export function convertBedrockMessagesToOpenAI(
  messages: Array<{ role: ConversationRole; content: ContentBlock[] }>,
): OpenAIMessage[] {
  return messages.map((msg) => {
    const roleMap: Record<string, 'user' | 'assistant'> = {
      'user': 'user',
      'assistant': 'assistant',
    };

    const contentBlocks: OpenAIContentBlock[] = [];
    for (const block of msg.content) {
      const aiBlock = contentBlockToOpenAI(block);
      if (aiBlock) {
        contentBlocks.push(aiBlock);
      }
    }

    // If multiple blocks, return as array; if single text, flatten to string
    const content =
      contentBlocks.length === 1 && contentBlocks[0].type === 'text'
        ? contentBlocks[0].text!
        : (contentBlocks as OpenAIContentBlock[]);

    return {
      role: roleMap[msg.role] || 'user',
      content,
    };
  });
}

/**
 * Convert inference config from Bedrock to OpenAI format.
 */
export interface OpenAIInferenceConfig {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
}

export function convertInferenceConfig(
  inferenceConfig: ConverseCommandInput['inferenceConfig'],
): OpenAIInferenceConfig {
  if (!inferenceConfig) return {};

  return {
    ...(inferenceConfig.maxTokens !== undefined && {
      max_tokens: inferenceConfig.maxTokens,
    }),
    ...(inferenceConfig.temperature !== undefined && {
      temperature: inferenceConfig.temperature,
    }),
    ...(inferenceConfig.topP !== undefined && {
      top_p: inferenceConfig.topP,
    }),
    ...(inferenceConfig.stopSequences && inferenceConfig.stopSequences.length > 0 && {
      stop: inferenceConfig.stopSequences,
    }),
  };
}

/**
 * Build OpenAI-compatible request body from Bedrock ConverseCommand input.
 */
export function buildOpenAIRequest(input: ConverseCommandInput | ConverseStreamCommandInput) {
  const messages: OpenAIMessage[] = [];

  // Add system message if present
  if (input.system && input.system.length > 0) {
    const systemBlocks: OpenAIContentBlock[] = [];
    for (const block of input.system) {
      const aiBlock = contentBlockToOpenAI(block);
      if (aiBlock) {
        systemBlocks.push(aiBlock);
      }
    }

    // For system, extract plain text if possible
    let systemText = '';
    for (const block of systemBlocks) {
      if (block.type === 'text' && block.text) {
        systemText += block.text + '\n';
      }
    }
    if (systemText) {
      messages.push({
        role: 'system',
        content: systemText.trim(),
      });
    }
  }

  // Add conversation messages
  if (input.messages && input.messages.length > 0) {
    messages.push(
      ...convertBedrockMessagesToOpenAI(
        input.messages as Array<{ role: ConversationRole; content: ContentBlock[] }>
      )
    );
  }

  const inferenceConfig = convertInferenceConfig(input.inferenceConfig);

  return {
    model: '', // Will be set by caller with mapped endpoint
    messages,
    stream: false, // Will be overridden for streaming
    ...inferenceConfig,
    ...(input.inferenceConfig?.stopSequences && {
      stop: input.inferenceConfig.stopSequences,
    }),
  };
}
