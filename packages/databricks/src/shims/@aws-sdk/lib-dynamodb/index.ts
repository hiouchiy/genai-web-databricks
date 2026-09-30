/**
 * AWS SDK lib-dynamodb shim for Postgres backend.
 * Implements DynamoDBDocumentClient and all command classes.
 */

import { DynamoDBStore } from '../../_dynamo/store';
import type { AttributeValue } from '../../_dynamo/evaluator';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '../client-dynamodb/index';

export {
  ConditionalCheckFailedException,
  TransactionCanceledException,
  AttributeValue,
};

// Re-export client types
export { DynamoDBClient } from '../client-dynamodb/index';

/**
 * Put command - insert or replace an item
 */
export class PutCommand {
  constructor(
    public input: {
      TableName: string;
      Item: Record<string, any>;
      ConditionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, any>;
      ReturnValues?: 'NONE' | 'ALL_OLD';
    },
  ) {}
}

/**
 * Get command - retrieve a single item by key
 */
export class GetCommand {
  constructor(
    public input: {
      TableName: string;
      Key: Record<string, any>;
      ProjectionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ConsistentRead?: boolean;
    },
  ) {}
}

/**
 * Query command - query items with a condition
 */
export class QueryCommand {
  constructor(
    public input: {
      TableName: string;
      KeyConditionExpression: string;
      FilterExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, any>;
      IndexName?: string;
      Limit?: number;
      ScanIndexForward?: boolean;
      ExclusiveStartKey?: Record<string, any>;
      ProjectionExpression?: string;
      Select?: string;
    },
  ) {}
}

/**
 * Scan command - retrieve all items (simplified - not recommended for large tables)
 */
export class ScanCommand {
  constructor(
    public input: {
      TableName: string;
      FilterExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, any>;
      Limit?: number;
      ExclusiveStartKey?: Record<string, any>;
      ProjectionExpression?: string;
    },
  ) {}
}

/**
 * Update command - update an item
 */
export class UpdateCommand {
  constructor(
    public input: {
      TableName: string;
      Key: Record<string, any>;
      UpdateExpression: string;
      ConditionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, any>;
      ReturnValues?: 'NONE' | 'ALL_OLD' | 'ALL_NEW' | 'UPDATED_OLD' | 'UPDATED_NEW';
    },
  ) {}
}

/**
 * Delete command - delete an item
 */
export class DeleteCommand {
  constructor(
    public input: {
      TableName: string;
      Key: Record<string, any>;
      ConditionExpression?: string;
      ExpressionAttributeNames?: Record<string, string>;
      ExpressionAttributeValues?: Record<string, any>;
      ReturnValues?: 'NONE' | 'ALL_OLD';
    },
  ) {}
}

/**
 * Batch write command - batch write/delete items
 */
export class BatchWriteCommand {
  constructor(
    public input: {
      RequestItems: Record<
        string,
        Array<{
          PutRequest?: { Item: Record<string, any> };
          DeleteRequest?: { Key: Record<string, any> };
        }>
      >;
    },
  ) {}
}

/**
 * Batch get command - batch get items
 */
export class BatchGetCommand {
  constructor(
    public input: {
      RequestItems: Record<
        string,
        {
          Keys: Record<string, any>[];
          ProjectionExpression?: string;
          ExpressionAttributeNames?: Record<string, string>;
          ConsistentRead?: boolean;
        }
      >;
    },
  ) {}
}

/**
 * Transact write command - atomic multi-item write
 */
export class TransactWriteCommand {
  constructor(
    public input: {
      TransactItems: Array<
        | {
            Put: {
              TableName: string;
              Item: Record<string, any>;
              ConditionExpression?: string;
              ExpressionAttributeNames?: Record<string, string>;
              ExpressionAttributeValues?: Record<string, any>;
            };
          }
        | {
            Update: {
              TableName: string;
              Key: Record<string, any>;
              UpdateExpression: string;
              ConditionExpression?: string;
              ExpressionAttributeNames?: Record<string, string>;
              ExpressionAttributeValues?: Record<string, any>;
            };
          }
        | {
            Delete: {
              TableName: string;
              Key: Record<string, any>;
              ConditionExpression?: string;
              ExpressionAttributeNames?: Record<string, string>;
              ExpressionAttributeValues?: Record<string, any>;
            };
          }
        | {
            ConditionCheck: {
              TableName: string;
              Key: Record<string, any>;
              ConditionExpression: string;
              ExpressionAttributeNames?: Record<string, string>;
              ExpressionAttributeValues?: Record<string, any>;
            };
          }
      >;
    },
  ) {}
}

type NativeAttributeValue = string | number | Uint8Array | boolean | null | NativeAttributeValue[];

export type { NativeAttributeValue };

/**
 * DynamoDBDocumentClient - the main client for document-level operations
 */
export class DynamoDBDocumentClient {
  private store: DynamoDBStore;

  private constructor(store?: DynamoDBStore) {
    this.store = store || new DynamoDBStore();
  }

  static from(baseClient: any): DynamoDBDocumentClient {
    // We ignore the baseClient since we use our own Postgres store
    return new DynamoDBDocumentClient();
  }

  async send(command: any): Promise<any> {
    if (command instanceof PutCommand) {
      return this.handlePut(command);
    } else if (command instanceof GetCommand) {
      return this.handleGet(command);
    } else if (command instanceof QueryCommand) {
      return this.handleQuery(command);
    } else if (command instanceof ScanCommand) {
      return this.handleScan(command);
    } else if (command instanceof UpdateCommand) {
      return this.handleUpdate(command);
    } else if (command instanceof DeleteCommand) {
      return this.handleDelete(command);
    } else if (command instanceof BatchWriteCommand) {
      return this.handleBatchWrite(command);
    } else if (command instanceof BatchGetCommand) {
      return this.handleBatchGet(command);
    } else if (command instanceof TransactWriteCommand) {
      return this.handleTransactWrite(command);
    } else {
      throw new Error(`Unknown command type: ${command.constructor.name}`);
    }
  }

  private async handlePut(command: PutCommand): Promise<{ Attributes?: Record<string, any> }> {
    const { TableName, Item, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues, ReturnValues } = command.input;

    // For put with condition, we need to check the condition first
    if (ConditionExpression) {
      const existing = await this.store.get(TableName, this.extractKey(TableName, Item));
      if (existing) {
        const { ExpressionParser } = await import('../../_dynamo/parser');
        const { ExpressionEvaluator } = await import('../../_dynamo/evaluator');

        const context = {
          item: existing,
          names: ExpressionAttributeNames || {},
          values: ExpressionAttributeValues || {},
        };

        const parser = new ExpressionParser(ConditionExpression);
        const ast = parser.parse();

        if (!ExpressionEvaluator.evaluate(ast, context)) {
          throw new ConditionalCheckFailedException('The conditional request failed');
        }
      }
    }

    await this.store.put(TableName, Item);

    if (ReturnValues === 'ALL_OLD') {
      const existing = await this.store.get(TableName, this.extractKey(TableName, Item));
      return { Attributes: existing || undefined };
    }

    return {};
  }

  private async handleGet(command: GetCommand): Promise<{ Item?: Record<string, any> }> {
    const { TableName, Key } = command.input;

    const item = await this.store.get(TableName, Key);
    return { Item: item };
  }

  private async handleQuery(command: QueryCommand): Promise<{
    Items: Record<string, any>[];
    Count: number;
    ScannedCount: number;
    LastEvaluatedKey?: Record<string, any>;
  }> {
    const { TableName, ...options } = command.input;

    const result = await this.store.query(TableName, options);
    return {
      Items: result.items,
      Count: result.count,
      ScannedCount: result.scannedCount,
      LastEvaluatedKey: result.lastEvaluatedKey,
    };
  }

  private async handleScan(command: ScanCommand): Promise<{
    Items: Record<string, any>[];
    Count: number;
    ScannedCount: number;
    LastEvaluatedKey?: Record<string, any>;
  }> {
    // Not implemented in store yet - for now just return empty
    // This can be implemented later if needed
    return {
      Items: [],
      Count: 0,
      ScannedCount: 0,
    };
  }

  private async handleUpdate(command: UpdateCommand): Promise<{ Attributes?: Record<string, any> }> {
    const { TableName, ...options } = command.input;

    const result = await this.store.update(TableName, options);
    return { Attributes: result || undefined };
  }

  private async handleDelete(command: DeleteCommand): Promise<{ Attributes?: Record<string, any> }> {
    const { TableName, ...options } = command.input;

    const result = await this.store.delete(TableName, options);
    return { Attributes: result || undefined };
  }

  private async handleBatchWrite(command: BatchWriteCommand): Promise<{ UnprocessedItems?: Record<string, any[]> }> {
    const { RequestItems } = command.input;

    for (const [tableName, items] of Object.entries(RequestItems)) {
      await this.store.batchWrite(tableName, items);
    }

    return {};
  }

  private async handleBatchGet(command: BatchGetCommand): Promise<{
    Responses?: Record<string, Record<string, any>[]>;
    UnprocessedKeys?: Record<string, any>;
  }> {
    const { RequestItems } = command.input;

    // Convert request format
    const requests = Object.entries(RequestItems).map(([TableName, config]) => ({
      TableName,
      Keys: config.Keys,
    }));

    const responses = await this.store.batchGet(requests);
    return { Responses: responses };
  }

  private async handleTransactWrite(command: TransactWriteCommand): Promise<{}> {
    const { TransactItems } = command.input;

    // Convert to store format
    const items = TransactItems.map((item) => {
      if ('Put' in item) {
        return { Put: item.Put };
      } else if ('Update' in item) {
        return { Update: item.Update };
      } else if ('Delete' in item) {
        return { Delete: item.Delete };
      } else if ('ConditionCheck' in item) {
        // Convert ConditionCheck to a dummy Put for now
        // In a real implementation, we'd verify the condition
        return {};
      }
      return {};
    });

    try {
      await this.store.transactWrite(items.filter((i) => Object.keys(i).length > 0));
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        throw new TransactionCanceledException('Transaction request cannot include multiple operations on one item', [
          { Code: 'ConditionalCheckFailed', Message: error.message },
        ]);
      }
      throw error;
    }

    return {};
  }

  private extractKey(tableName: string, item: Record<string, any>): Record<string, any> {
    const { getTableSchema } = require('../../_dynamo/tables');
    const schema = getTableSchema(tableName);

    const key: Record<string, any> = {};
    key[schema.pk.name] = item[schema.pk.name];

    if (schema.sk) {
      key[schema.sk.name] = item[schema.sk.name];
    }

    return key;
  }
}

// Type helper for accessing nested types
export type NativeAttributeValueType = NativeAttributeValue;
