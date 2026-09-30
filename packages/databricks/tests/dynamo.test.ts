import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newDb } from 'pg-mem';
import type { IMemoryDb } from 'pg-mem';
import type { Pool } from 'pg';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
  BatchGetCommand,
  TransactWriteCommand,
  ConditionalCheckFailedException,
} from '../src/shims/@aws-sdk/lib-dynamodb';
import { setPool } from 'genai-dbx-runtime';

let memDb: IMemoryDb;
let pool: Pool;
let client: DynamoDBDocumentClient;

beforeEach(() => {
  // Create in-memory Postgres database
  memDb = newDb();
  const pgModule = memDb.adapters.createPg();
  pool = new pgModule.Pool() as unknown as Pool;
  setPool(pool);

  // Create document client
  client = DynamoDBDocumentClient.from(null);

  // Set environment variables for table names
  process.env.TABLE_NAME = 'genai_chat';
  process.env.EXAPP_TABLE_NAME = 'genai_exapp';
  process.env.INVOKE_HISTORY_TABLE_NAME = 'genai_invoke_history';
  process.env.PASSWORD_RESET_TABLE_NAME = 'genai_password_reset';
});

afterEach(async () => {
  await pool.end();
});

describe('DynamoDB Document Client - Put/Get', () => {
  it('should put and get a simple item', async () => {
    const tableName = 'genai_chat';
    const item = {
      id: 'user#123',
      createdDate: '1234567890',
      chatId: 'chat#456',
      title: 'Test Chat',
    };

    // Put
    await client.send(new PutCommand({ TableName: tableName, Item: item }));

    // Get
    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
      }),
    );

    expect(result.Item).toMatchObject(item);
  });

  it('should put with replace on conflict', async () => {
    const tableName = 'genai_chat';
    const item1 = {
      id: 'user#123',
      createdDate: '1234567890',
      chatId: 'chat#456',
      title: 'Original Title',
    };

    const item2 = {
      id: 'user#123',
      createdDate: '1234567890',
      chatId: 'chat#456',
      title: 'Updated Title',
    };

    await client.send(new PutCommand({ TableName: tableName, Item: item1 }));
    await client.send(new PutCommand({ TableName: tableName, Item: item2 }));

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
      }),
    );

    expect(result.Item?.title).toBe('Updated Title');
  });

  it('should return undefined for non-existent item', async () => {
    const result = await client.send(
      new GetCommand({
        TableName: 'genai_chat',
        Key: {
          id: 'user#999',
          createdDate: '9999999999',
        },
      }),
    );

    expect(result.Item).toBeUndefined();
  });
});

describe('DynamoDB Document Client - Query', () => {
  beforeEach(async () => {
    const tableName = 'genai_chat';

    // Insert test data
    const items = [
      {
        id: 'user#123',
        createdDate: '1000',
        chatId: 'chat#1',
        title: 'Chat 1',
      },
      {
        id: 'user#123',
        createdDate: '2000',
        chatId: 'chat#2',
        title: 'Chat 2',
      },
      {
        id: 'user#123',
        createdDate: '3000',
        chatId: 'chat#3',
        title: 'Chat 3',
      },
      {
        id: 'user#456',
        createdDate: '1000',
        chatId: 'chat#4',
        title: 'Chat 4',
      },
    ];

    for (const item of items) {
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    }
  });

  it('should query items by partition key', async () => {
    const result = await client.send(
      new QueryCommand({
        TableName: 'genai_chat',
        KeyConditionExpression: '#id = :id',
        ExpressionAttributeNames: {
          '#id': 'id',
        },
        ExpressionAttributeValues: {
          ':id': 'user#123',
        },
      }),
    );

    expect(result.Items).toHaveLength(3);
    expect(result.Count).toBe(3);
  });

  it('should query with sort key condition', async () => {
    const result = await client.send(
      new QueryCommand({
        TableName: 'genai_chat',
        KeyConditionExpression: '#id = :id AND #cd = :cd',
        ExpressionAttributeNames: {
          '#id': 'id',
          '#cd': 'createdDate',
        },
        ExpressionAttributeValues: {
          ':id': 'user#123',
          ':cd': '2000',
        },
      }),
    );

    expect(result.Items).toHaveLength(1);
    expect(result.Items[0].chatId).toBe('chat#2');
  });

  it('should apply FilterExpression', async () => {
    const result = await client.send(
      new QueryCommand({
        TableName: 'genai_chat',
        KeyConditionExpression: '#id = :id',
        FilterExpression: 'contains(#title, :title)',
        ExpressionAttributeNames: {
          '#id': 'id',
          '#title': 'title',
        },
        ExpressionAttributeValues: {
          ':id': 'user#123',
          ':title': 'Chat 2',
        },
      }),
    );

    expect(result.Items).toHaveLength(1);
    expect(result.Items[0].chatId).toBe('chat#2');
  });

  it('should handle ScanIndexForward=false', async () => {
    const result = await client.send(
      new QueryCommand({
        TableName: 'genai_chat',
        KeyConditionExpression: '#id = :id',
        ExpressionAttributeNames: {
          '#id': 'id',
        },
        ExpressionAttributeValues: {
          ':id': 'user#123',
        },
        ScanIndexForward: false,
      }),
    );

    const dates = result.Items.map((i: any) => i.createdDate);
    expect(dates).toEqual(['3000', '2000', '1000']);
  });

  it('should handle Limit', async () => {
    const result = await client.send(
      new QueryCommand({
        TableName: 'genai_chat',
        KeyConditionExpression: '#id = :id',
        ExpressionAttributeNames: {
          '#id': 'id',
        },
        ExpressionAttributeValues: {
          ':id': 'user#123',
        },
        Limit: 2,
      }),
    );

    expect(result.Items).toHaveLength(2);
    expect(result.LastEvaluatedKey).toBeDefined();
  });
});

describe('DynamoDB Document Client - Update', () => {
  it('should update an item', async () => {
    const tableName = 'genai_chat';
    const item = {
      id: 'user#123',
      createdDate: '1234567890',
      chatId: 'chat#456',
      title: 'Original Title',
    };

    await client.send(new PutCommand({ TableName: tableName, Item: item }));

    const result = await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
        UpdateExpression: 'set title = :title',
        ExpressionAttributeValues: {
          ':title': 'Updated Title',
        },
        ReturnValues: 'ALL_NEW',
      }),
    );

    expect(result.Attributes?.title).toBe('Updated Title');
  });

  it('should support SET with if_not_exists', async () => {
    const tableName = 'genai_chat';
    const item = {
      id: 'user#123',
      createdDate: '1234567890',
      chatId: 'chat#456',
    };

    await client.send(new PutCommand({ TableName: tableName, Item: item }));

    // Set title only if it doesn't exist
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
        UpdateExpression: 'set title = if_not_exists(title, :val)',
        ExpressionAttributeValues: {
          ':val': 'New Title',
        },
      }),
    );

    let result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
      }),
    );

    expect(result.Item?.title).toBe('New Title');

    // Try again - should not update since title exists
    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
        UpdateExpression: 'set title = if_not_exists(title, :val)',
        ExpressionAttributeValues: {
          ':val': 'Another Title',
        },
      }),
    );

    result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
      }),
    );

    expect(result.Item?.title).toBe('New Title');
  });

  it('should support ADD for numbers', async () => {
    const tableName = 'genai_chat';
    const item = {
      id: 'user#123',
      createdDate: '1234567890',
      count: 5,
    };

    await client.send(new PutCommand({ TableName: tableName, Item: item }));

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
        UpdateExpression: 'ADD #count :inc',
        ExpressionAttributeNames: {
          '#count': 'count',
        },
        ExpressionAttributeValues: {
          ':inc': 3,
        },
      }),
    );

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
      }),
    );

    expect(result.Item?.count).toBe(8);
  });

  it('should support REMOVE', async () => {
    const tableName = 'genai_chat';
    const item = {
      id: 'user#123',
      createdDate: '1234567890',
      title: 'Test',
      tempField: 'temp',
    };

    await client.send(new PutCommand({ TableName: tableName, Item: item }));

    await client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
        UpdateExpression: 'REMOVE tempField',
      }),
    );

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
      }),
    );

    expect(result.Item?.tempField).toBeUndefined();
    expect(result.Item?.title).toBe('Test');
  });

  it('should check ConditionExpression on update', async () => {
    const tableName = 'genai_chat';
    const item = {
      id: 'user#123',
      createdDate: '1234567890',
      title: 'Original',
      version: 1,
    };

    await client.send(new PutCommand({ TableName: tableName, Item: item }));

    // Try to update with wrong version - should fail
    let errorThrown: any;
    try {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: {
            id: 'user#123',
            createdDate: '1234567890',
          },
          UpdateExpression: 'set title = :title',
          ConditionExpression: 'version = :v',
          ExpressionAttributeValues: {
            ':title': 'New Title',
            ':v': 2,
          },
        }),
      );
    } catch (e) {
      errorThrown = e;
    }

    expect(errorThrown).toBeDefined();
    expect(errorThrown.name).toBe('ConditionalCheckFailedException');
  });
});

describe('DynamoDB Document Client - Delete', () => {
  it('should delete an item', async () => {
    const tableName = 'genai_chat';
    const item = {
      id: 'user#123',
      createdDate: '1234567890',
      chatId: 'chat#456',
    };

    await client.send(new PutCommand({ TableName: tableName, Item: item }));

    await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
      }),
    );

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
      }),
    );

    expect(result.Item).toBeUndefined();
  });

  it('should return ALL_OLD on delete', async () => {
    const tableName = 'genai_chat';
    const item = {
      id: 'user#123',
      createdDate: '1234567890',
      chatId: 'chat#456',
      title: 'Test',
    };

    await client.send(new PutCommand({ TableName: tableName, Item: item }));

    const result = await client.send(
      new DeleteCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
        ReturnValues: 'ALL_OLD',
      }),
    );

    expect(result.Attributes?.title).toBe('Test');
  });
});

describe('DynamoDB Document Client - Batch Operations', () => {
  it('should batch write items', async () => {
    const tableName = 'genai_chat';

    await client.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: [
            {
              PutRequest: {
                Item: {
                  id: 'user#1',
                  createdDate: '1000',
                  title: 'Item 1',
                },
              },
            },
            {
              PutRequest: {
                Item: {
                  id: 'user#2',
                  createdDate: '2000',
                  title: 'Item 2',
                },
              },
            },
          ],
        },
      }),
    );

    const result1 = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { id: 'user#1', createdDate: '1000' },
      }),
    );

    const result2 = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { id: 'user#2', createdDate: '2000' },
      }),
    );

    expect(result1.Item?.title).toBe('Item 1');
    expect(result2.Item?.title).toBe('Item 2');
  });

  it('should batch get items', async () => {
    const tableName = 'genai_chat';

    // Put items first
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: { id: 'user#1', createdDate: '1000', title: 'Item 1' },
      }),
    );

    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: { id: 'user#2', createdDate: '2000', title: 'Item 2' },
      }),
    );

    const result = await client.send(
      new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: [
              { id: 'user#1', createdDate: '1000' },
              { id: 'user#2', createdDate: '2000' },
              { id: 'user#3', createdDate: '3000' }, // doesn't exist
            ],
          },
        },
      }),
    );

    expect(result.Responses?.[tableName]).toHaveLength(2);
  });
});

describe('DynamoDB Document Client - TransactWrite', () => {
  it('should perform transact write', async () => {
    const tableName = 'genai_chat';

    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                id: 'user#1',
                createdDate: '1000',
                title: 'Item 1',
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                id: 'user#2',
                createdDate: '2000',
                title: 'Item 2',
              },
            },
          },
        ],
      }),
    );

    const result1 = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { id: 'user#1', createdDate: '1000' },
      }),
    );

    const result2 = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: { id: 'user#2', createdDate: '2000' },
      }),
    );

    expect(result1.Item?.title).toBe('Item 1');
    expect(result2.Item?.title).toBe('Item 2');
  });
});

describe('DynamoDB Document Client - Complex Scenarios', () => {
  it('should handle team table with GSI-1', async () => {
    const tableName = 'genai_exapp';

    // Put team item
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: 'team#abc123',
          sk: 'team',
          teamName: 'Test Team',
          createdDate: Date.now(),
        },
      }),
    );

    // Get by key
    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: 'team#abc123',
          sk: 'team',
        },
      }),
    );

    expect(result.Item?.teamName).toBe('Test Team');
  });

  it('should handle numbers in item storage', async () => {
    const tableName = 'genai_chat';

    const item = {
      id: 'user#123',
      createdDate: '1234567890',
      count: 42,
      price: 19.99,
    };

    await client.send(new PutCommand({ TableName: tableName, Item: item }));

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
      }),
    );

    expect(result.Item?.count).toBe(42);
    expect(result.Item?.price).toBe(19.99);
  });

  it('should handle complex nested objects', async () => {
    const tableName = 'genai_chat';

    const item = {
      id: 'user#123',
      createdDate: '1234567890',
      metadata: {
        nested: {
          value: 'test',
        },
        array: [1, 2, 3],
      },
    };

    await client.send(new PutCommand({ TableName: tableName, Item: item }));

    const result = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          id: 'user#123',
          createdDate: '1234567890',
        },
      }),
    );

    expect(result.Item?.metadata?.nested?.value).toBe('test');
    expect(result.Item?.metadata?.array).toEqual([1, 2, 3]);
  });
});
