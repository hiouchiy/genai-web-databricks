/**
 * AWS SDK client-dynamodb shim for Postgres backend.
 */

import type { AttributeValue } from '../../_dynamo/evaluator';

export { AttributeValue };

/**
 * Error class for conditional check failures
 */
export class ConditionalCheckFailedException extends Error {
  public readonly name = 'ConditionalCheckFailedException';

  constructor(message?: string) {
    super(message || 'One of the conditions evaluated to false');
    Object.setPrototypeOf(this, ConditionalCheckFailedException.prototype);
  }
}

/**
 * Error class for transaction cancellation
 */
export class TransactionCanceledException extends Error {
  public readonly name = 'TransactionCanceledException';
  public readonly CancellationReasons?: Array<{ Code?: string; Message?: string }>;

  constructor(message?: string, reasons?: Array<{ Code?: string; Message?: string }>) {
    super(message || 'Transaction request cannot include multiple operations on one item');
    this.CancellationReasons = reasons;
    Object.setPrototypeOf(this, TransactionCanceledException.prototype);
  }
}

/**
 * DynamoDBClient shim - a minimal implementation that just serves as a placeholder
 * since we primarily use DynamoDBDocumentClient
 */
export class DynamoDBClient {
  constructor(_config?: any) {
    // Configuration is ignored
  }

  send(_command: any): Promise<any> {
    throw new Error('DynamoDBClient.send() not implemented - use DynamoDBDocumentClient');
  }

  destroy(): void {
    // No-op
  }
}

/**
 * Stub for ExportTableToPointInTimeCommand
 */
export class ExportTableToPointInTimeCommand {
  constructor(_input: any) {}
}

/**
 * Stub for Query command (low-level)
 */
export class QueryCommand {
  constructor(public input: any) {}
}

/**
 * Stub for other commands not yet used
 */
export class ScanCommand {
  constructor(_input: any) {}
}

export class GetCommand {
  constructor(_input: any) {}
}

export class PutCommand {
  constructor(_input: any) {}
}

export class DeleteCommand {
  constructor(_input: any) {}
}

export class UpdateCommand {
  constructor(_input: any) {}
}

export class BatchGetCommand {
  constructor(_input: any) {}
}

export class BatchWriteCommand {
  constructor(_input: any) {}
}
