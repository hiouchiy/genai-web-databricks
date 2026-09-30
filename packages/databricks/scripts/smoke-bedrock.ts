#!/usr/bin/env node
/**
 * Smoke test for Bedrock shim with real Databricks workspace.
 * Tests both Converse (invoke) and ConverseStream (invokeStream).
 *
 * Usage:
 *   npx tsx scripts/smoke-bedrock.ts
 *
 * Environment:
 *   DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
 *   DATABRICKS_TOKEN=your-token
 *   (or DATABRICKS_CONFIG_PROFILE=your-profile)
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandInput,
} from '../src/shims/@aws-sdk/client-bedrock-runtime';

const client = new BedrockRuntimeClient(undefined);

/**
 * Test basic Converse (invoke).
 */
async function testConverse() {
  console.log('\n=== Testing Converse (invoke) ===');

  const input: ConverseCommandInput = {
    modelId: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
    system: [
      {
        text: 'あなたは日本語で回答する親切なアシスタントです。',
      },
    ],
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            text: 'こんにちは。今日は何月何日ですか？',
          },
        ],
      },
    ],
    inferenceConfig: {
      maxTokens: 256,
      temperature: 0.7,
    },
  };

  try {
    const command = new ConverseCommand(input);
    const response = await client.send(command);

    console.log('Response:', JSON.stringify(response, null, 2));
    console.log(
      '✓ Converse test passed. Output:',
      response?.output?.message?.content?.[0]?.text
    );
    return true;
  } catch (error) {
    console.error('✗ Converse test failed:', error);
    return false;
  }
}

/**
 * Test Converse Stream (invokeStream).
 */
async function testConverseStream() {
  console.log('\n=== Testing ConverseStream (invokeStream) ===');

  const input: ConverseCommandInput = {
    modelId: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
    system: [
      {
        text: 'あなたは日本語で回答する親切なアシスタントです。',
      },
    ],
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            text: '「源内」というプロジェクトについて、100字以内で説明してください。',
          },
        ],
      },
    ],
    inferenceConfig: {
      maxTokens: 256,
      temperature: 0.7,
    },
  };

  try {
    const command = new ConverseStreamCommand(input);
    const response = await client.send(command);

    console.log('Streaming response started...');

    let fullText = '';
    let eventCount = 0;
    let usageData: any = null;

    for await (const event of (response as any).stream) {
      eventCount++;

      if (event.messageStart) {
        console.log('  [messageStart] role:', event.messageStart.role);
      }

      if (event.contentBlockDelta?.delta?.text) {
        const text = event.contentBlockDelta.delta.text;
        fullText += text;
        process.stdout.write(text);
      }

      if (event.messageStop) {
        console.log('\n  [messageStop] stopReason:', event.messageStop.stopReason);
      }

      if (event.metadata?.usage) {
        usageData = event.metadata.usage;
        console.log('\n  [metadata] usage:', JSON.stringify(usageData, null, 2));
      }
    }

    console.log(`\n✓ ConverseStream test passed. Total events: ${eventCount}`);
    console.log(`  Generated text: "${fullText.substring(0, 100)}..."`);
    if (usageData) {
      console.log(`  Tokens - input: ${usageData.inputTokens}, output: ${usageData.outputTokens}`);
    }
    return true;
  } catch (error) {
    console.error('✗ ConverseStream test failed:', error);
    return false;
  }
}

/**
 * Run all tests.
 */
async function main() {
  console.log('Starting Bedrock shim smoke tests...');
  console.log('Host:', process.env.DATABRICKS_HOST);
  console.log('Profile:', process.env.DATABRICKS_CONFIG_PROFILE);

  const results = {
    converse: await testConverse(),
    converseStream: await testConverseStream(),
  };

  console.log('\n=== Summary ===');
  console.log(`Converse: ${results.converse ? '✓ PASSED' : '✗ FAILED'}`);
  console.log(`ConverseStream: ${results.converseStream ? '✓ PASSED' : '✗ FAILED'}`);

  const allPassed = Object.values(results).every((r) => r);
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
