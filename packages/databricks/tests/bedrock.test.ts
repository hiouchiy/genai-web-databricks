import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  ThrottlingException,
  ValidationException,
  AccessDeniedException,
} from '../src/shims/@aws-sdk/client-bedrock-runtime';
import { mapModelIdToEndpoint } from '../src/shims/@aws-sdk/client-bedrock-runtime/bedrock-modelMap';
import { buildOpenAIRequest } from '../src/shims/@aws-sdk/client-bedrock-runtime/bedrock-messages';
import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';

describe('Bedrock Shim', () => {
  describe('Model Mapping', () => {
    it('should map claude-sonnet-4-6 models to databricks-claude-sonnet-4-6', () => {
      expect(mapModelIdToEndpoint('jp.anthropic.claude-sonnet-4-6')).toBe(
        'databricks-claude-sonnet-4-6'
      );
      expect(mapModelIdToEndpoint('anthropic.claude-sonnet-4-6')).toBe(
        'databricks-claude-sonnet-4-6'
      );
    });

    it('should map claude-sonnet-4-5 models to databricks-claude-sonnet-4-5', () => {
      expect(mapModelIdToEndpoint('jp.anthropic.claude-sonnet-4-5')).toBe(
        'databricks-claude-sonnet-4-5'
      );
    });

    it('should map claude-haiku-4-5 models to databricks-claude-haiku-4-5', () => {
      expect(mapModelIdToEndpoint('jp.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
        'databricks-claude-haiku-4-5'
      );
    });

    it('should map claude-opus-4-6 models to databricks-claude-opus-4-6', () => {
      expect(mapModelIdToEndpoint('jp.anthropic.claude-opus-4-6')).toBe(
        'databricks-claude-opus-4-6'
      );
    });

    it('should map nova models to databricks-claude-haiku-4-5', () => {
      expect(mapModelIdToEndpoint('amazon.nova-lite-v1:0')).toBe(
        'databricks-claude-haiku-4-5'
      );
    });

    it('should preserve databricks-prefixed model IDs', () => {
      expect(mapModelIdToEndpoint('databricks-claude-sonnet-4-6')).toBe(
        'databricks-claude-sonnet-4-6'
      );
    });

    it('should use default fallback for unknown models', () => {
      expect(mapModelIdToEndpoint('unknown-model')).toBe('databricks-claude-sonnet-4-6');
    });
  });

  describe('Message Translation', () => {
    it('should convert Bedrock Converse input to OpenAI format', () => {
      const bedrockInput: ConverseCommandInput = {
        modelId: 'jp.anthropic.claude-sonnet-4-6',
        system: [{ text: 'You are a helpful assistant' }],
        messages: [
          {
            role: 'user' as const,
            content: [{ text: 'Hello' }],
          },
          {
            role: 'assistant' as const,
            content: [{ text: 'Hi there!' }],
          },
        ],
        inferenceConfig: {
          maxTokens: 2048,
          temperature: 0.7,
          topP: 0.9,
          stopSequences: ['END'],
        },
      };

      const openaiRequest = buildOpenAIRequest(bedrockInput);

      expect(openaiRequest.messages).toHaveLength(3);
      expect(openaiRequest.messages[0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant',
      });
      expect(openaiRequest.messages[1]).toEqual({
        role: 'user',
        content: 'Hello',
      });
      expect(openaiRequest.messages[2]).toEqual({
        role: 'assistant',
        content: 'Hi there!',
      });
      expect(openaiRequest.max_tokens).toBe(2048);
      expect(openaiRequest.temperature).toBe(0.7);
      expect(openaiRequest.top_p).toBe(0.9);
      expect(openaiRequest.stop).toEqual(['END']);
    });

    it('should handle messages without system prompt', () => {
      const bedrockInput: ConverseCommandInput = {
        modelId: 'jp.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user' as const,
            content: [{ text: 'Hello' }],
          },
        ],
      };

      const openaiRequest = buildOpenAIRequest(bedrockInput);

      expect(openaiRequest.messages).toHaveLength(1);
      expect(openaiRequest.messages[0]).toEqual({
        role: 'user',
        content: 'Hello',
      });
    });

    it('should handle image content blocks', () => {
      const imageBuffer = Buffer.from('fake image data');
      const bedrockInput: ConverseCommandInput = {
        modelId: 'jp.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user' as const,
            content: [
              { text: 'What is this image?' },
              {
                image: {
                  format: 'jpeg',
                  source: { bytes: imageBuffer },
                },
              },
            ],
          },
        ],
      };

      const openaiRequest = buildOpenAIRequest(bedrockInput);

      expect(openaiRequest.messages).toHaveLength(1);
      expect(Array.isArray(openaiRequest.messages[0].content)).toBe(true);
      const content = openaiRequest.messages[0].content as any[];
      expect(content.some((c) => c.type === 'text')).toBe(true);
      expect(content.some((c) => c.type === 'image_url')).toBe(true);
    });

    it('should handle document content blocks with placeholder', () => {
      const docBuffer = Buffer.from('fake pdf data');
      const bedrockInput: ConverseCommandInput = {
        modelId: 'jp.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user' as const,
            content: [
              { text: 'Analyze this document' },
              {
                document: {
                  format: 'pdf',
                  name: 'report.pdf',
                  source: { bytes: docBuffer },
                },
              },
            ],
          },
        ],
      };

      const openaiRequest = buildOpenAIRequest(bedrockInput);

      expect(openaiRequest.messages).toHaveLength(1);
      const content = openaiRequest.messages[0].content as any[];
      expect(content.some((c) => c.text?.includes('添付ファイル'))).toBe(true);
    });
  });

  describe('Error Mapping', () => {
    it('should create proper error instances', () => {
      const throttling = new ThrottlingException('Rate limited');
      expect(throttling.name).toBe('ThrottlingException');
      expect(throttling.message).toBe('Rate limited');

      const validation = new ValidationException('Invalid input');
      expect(validation.name).toBe('ValidationException');

      const accessDenied = new AccessDeniedException('Not authorized');
      expect(accessDenied.name).toBe('AccessDeniedException');
    });
  });

  describe('BedrockRuntimeClient', () => {
    let client: BedrockRuntimeClient;

    beforeEach(() => {
      client = new BedrockRuntimeClient(undefined);
    });

    it('should reject InvokeModelCommand for image generation', async () => {
      const { InvokeModelCommand: ImportedInvokeModelCommand } = await import(
        '../src/shims/@aws-sdk/client-bedrock-runtime'
      );
      const command = new ImportedInvokeModelCommand({
        modelId: 'stability.stable-diffusion-xl-v1',
        body: 'test',
      });

      await expect(client.send(command)).rejects.toThrow(
        'Image generation (InvokeModelCommand) is not supported on Databricks'
      );
    });
  });

  describe('Message streaming format', () => {
    it('should parse OpenAI SSE stream to Bedrock format', async () => {
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"id":"1","object":"text_completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n'
          ));
          controller.enqueue(new TextEncoder().encode(
            'data: {"id":"2","object":"text_completion.chunk","created":2,"model":"test","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n'
          ));
          controller.enqueue(new TextEncoder().encode(
            'data: [DONE]\n'
          ));
          controller.close();
        },
      });

      const response = new Response(mockStream);
      const { parseStreamResponse } = await import(
        '../src/shims/@aws-sdk/client-bedrock-runtime/bedrock-streaming'
      );

      const events: any[] = [];
      for await (const event of parseStreamResponse(response)) {
        events.push(event);
      }

      // Should have: messageStart, contentBlockDelta (Hello), contentBlockDelta (world),
      // messageStop, metadata with usage, messageStop
      expect(events.length).toBeGreaterThan(0);

      // Check for messageStart
      expect(events.some((e) => e.messageStart?.role === 'assistant')).toBe(true);

      // Check for content deltas
      expect(
        events.some(
          (e) => e.contentBlockDelta?.delta?.text && e.contentBlockDelta.delta.text.includes('Hello')
        )
      ).toBe(true);

      // Check for usage metadata
      expect(
        events.some((e) => e.metadata?.usage && e.metadata.usage.inputTokens === 10)
      ).toBe(true);
    });
  });
});
