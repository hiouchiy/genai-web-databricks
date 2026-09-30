/**
 * Postgres-backed DynamoDB store.
 * Provides operations: put, get, query, update, delete, batchWrite, batchGet, transactWrite.
 */

import type { Pool, PoolClient } from 'pg';
import type { AttributeValue } from './evaluator';
import { ExpressionEvaluator } from './evaluator';
import { ExpressionParser } from './parser';
import {
  UpdateExpressionEvaluator,
  UpdateExpressionParser,
} from './update-parser';
import { getTableRegistry, getTableSchema, getGSISchema } from './tables';
import { getPool, DB_SCHEMA } from 'genai-dbx-runtime';

/**
 * Sanitize a name for use as a Postgres table/schema name.
 */
function sanitizeName(name: string): string {
  // Replace non-alphanumeric chars with underscore, keep lowercase
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/**
 * Escape a string for use in a Postgres string literal.
 */
function escapeLiteral(value: any): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    // Escape single quotes by doubling them
    return "'" + value.replace(/'/g, "''") + "'";
  }
  // For objects/arrays, convert to JSON
  return "'" + JSON.stringify(value).replace(/'/g, "''") + "'";
}

export interface QueryOptions {
  KeyConditionExpression?: string;
  FilterExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  IndexName?: string;
  Limit?: number;
  ScanIndexForward?: boolean;
  ExclusiveStartKey?: Record<string, string>;
  ProjectionExpression?: string;
  Select?: string;
}

export interface UpdateOptions {
  Key: Record<string, AttributeValue>;
  UpdateExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ConditionExpression?: string;
  ReturnValues?: 'NONE' | 'ALL_OLD' | 'ALL_NEW' | 'UPDATED_OLD' | 'UPDATED_NEW';
}

export interface DeleteOptions {
  Key: Record<string, AttributeValue>;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ReturnValues?: 'NONE' | 'ALL_OLD';
}

export interface TransactWriteItem {
  Put?: { TableName: string; Item: Record<string, AttributeValue> };
  Update?: { TableName: string } & UpdateOptions;
  Delete?: { TableName: string } & DeleteOptions;
}

export class DynamoDBStore {
  private pool: Pool | null = null;

  async ensurePool(): Promise<Pool> {
    if (!this.pool) {
      this.pool = await getPool();
    }
    return this.pool;
  }

  async ensureTable(client: PoolClient, tableName: string): Promise<void> {
    const sanitized = sanitizeName(tableName);

    // Create schema
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
    } catch {
      // Schema might already exist
    }

    // Create table - use simpler DDL for pg-mem compatibility
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${DB_SCHEMA}."${sanitized}" (
          pk_val TEXT,
          sk_val TEXT,
          item JSONB,
          PRIMARY KEY (pk_val, sk_val)
        )
      `);
    } catch {
      // Table might already exist
    }
  }

  async put(tableName: string, item: Record<string, AttributeValue>): Promise<void> {
    const pool = await this.ensurePool();
    const client = await pool.connect();

    try {
      await this.ensureTable(client, tableName);

      const schema = getTableSchema(tableName);
      const pkVal = String(item[schema.pk.name] ?? '');
      const skVal = schema.sk ? String(item[schema.sk.name] ?? '') : '';

      const query = `
        INSERT INTO ${DB_SCHEMA}."${sanitizeName(tableName)}" (pk_val, sk_val, item)
        VALUES ($1, $2, $3)
        ON CONFLICT (pk_val, sk_val) DO UPDATE
        SET item = $3;
      `;

      await client.query(query, [pkVal, skVal, JSON.stringify(item)]);
    } finally {
      client.release();
    }
  }

  async get(tableName: string, key: Record<string, AttributeValue>): Promise<Record<string, AttributeValue> | undefined> {
    const pool = await this.ensurePool();
    const client = await pool.connect();

    try {
      await this.ensureTable(client, tableName);

      const schema = getTableSchema(tableName);
      const pkVal = String(key[schema.pk.name] ?? '');
      const skVal = schema.sk ? String(key[schema.sk.name] ?? '') : '';

      const query = `
        SELECT item FROM ${DB_SCHEMA}."${sanitizeName(tableName)}"
        WHERE pk_val = $1 AND sk_val = $2;
      `;

      const result = await client.query(query, [pkVal, skVal]);
      return result.rows.length > 0 ? result.rows[0].item : undefined;
    } finally {
      client.release();
    }
  }

  async query(tableName: string, options: QueryOptions): Promise<{ items: Record<string, any>[]; lastEvaluatedKey?: Record<string, string>; count: number; scannedCount: number }> {
    const pool = await this.ensurePool();
    const client = await pool.connect();

    try {
      await this.ensureTable(client, tableName);

      const schema = getTableSchema(tableName);
      const names = options.ExpressionAttributeNames || {};
      const values = options.ExpressionAttributeValues || {};

      let useGSI = false;
      let gsiPk: string = '';
      let gsiSk: string | null = null;

      if (options.IndexName) {
        const gsi = getGSISchema(tableName, options.IndexName);
        gsiPk = gsi.pk.name;
        gsiSk = gsi.sk?.name || null;
        useGSI = true;
      }

      // Parse key condition
      const basePkName = useGSI ? gsiPk : schema.pk.name;
      const baseSkName = useGSI ? gsiSk : schema.sk?.name;

      // Extract the partition key value from KeyConditionExpression
      const pkRegex = new RegExp(`(${basePkName}|#\\w+)\\s*=\\s*:[^\\s,)]+`, 'i');
      const pkMatch = options.KeyConditionExpression?.match(pkRegex);
      if (!pkMatch) {
        throw new Error('KeyConditionExpression must include partition key = value');
      }

      const pkAttrMatch = pkMatch[1];
      let actualPkName = basePkName;
      if (pkAttrMatch.startsWith('#')) {
        actualPkName = names[pkAttrMatch] || basePkName;
      }

      // Extract pk value
      const pkValueMatch = options.KeyConditionExpression?.match(/:\w+/)?.[0];
      const pkValue = pkValueMatch ? values[pkValueMatch] : null;

      if (pkValue === null || pkValue === undefined) {
        throw new Error('Partition key value not found');
      }

      let items = await this.queryItems(client, tableName, actualPkName, String(pkValue));

      // Apply key condition filter (for sort key conditions)
      if (options.KeyConditionExpression) {
        items = items.filter((item) => {
          const context = { item, names, values };
          const parser = new ExpressionParser(options.KeyConditionExpression!);
          const ast = parser.parse();
          try {
            return ExpressionEvaluator.evaluate(ast, context);
          } catch (e) {
            // If evaluation fails, don't filter out the item
            return true;
          }
        });
      }

      // Apply filter expression
      if (options.FilterExpression) {
        items = items.filter((item) => {
          const context = { item, names, values };
          const parser = new ExpressionParser(options.FilterExpression!);
          const ast = parser.parse();
          try {
            return ExpressionEvaluator.evaluate(ast, context);
          } catch {
            return true;
          }
        });
      }

      // Sort by sort key
      const sortKeyName = baseSkName ? schema.sk?.name || baseSkName : null;
      if (sortKeyName && items.length > 0) {
        items.sort((a, b) => {
          const aVal = a[sortKeyName];
          const bVal = b[sortKeyName];
          const isNumeric = !isNaN(Number(aVal)) && !isNaN(Number(bVal));
          if (isNumeric) {
            return Number(aVal) - Number(bVal);
          }
          return String(aVal).localeCompare(String(bVal));
        });
      }

      // Handle scan direction
      if (options.ScanIndexForward === false) {
        items.reverse();
      }

      // Handle exclusive start key (cursor pagination)
      let startIndex = 0;
      if (options.ExclusiveStartKey) {
        const startKey = options.ExclusiveStartKey;
        startIndex = items.findIndex(
          (item) =>
            item[schema.pk.name] === startKey.pk &&
            (schema.sk ? item[schema.sk.name] === startKey.sk : true),
        );
        if (startIndex >= 0) {
          startIndex++;
        }
      }

      const scannedCount = items.length;
      const limit = options.Limit || 1000000;
      const result = items.slice(startIndex, startIndex + limit);

      const lastEvaluatedKey =
        startIndex + limit < items.length
          ? {
              pk: String(result[result.length - 1][schema.pk.name]),
              sk: schema.sk ? String(result[result.length - 1][schema.sk.name]) : '',
            }
          : undefined;

      return {
        items: result,
        lastEvaluatedKey,
        count: result.length,
        scannedCount,
      };
    } finally {
      client.release();
    }
  }

  private async queryItems(client: PoolClient, tableName: string, attrName: string, value: string): Promise<Record<string, any>[]> {
    const query = `
      SELECT item FROM ${DB_SCHEMA}."${sanitizeName(tableName)}"
      WHERE item->>'${attrName.replace(/'/g, "''")}' = $1;
    `;

    const result = await client.query(query, [value]);
    return result.rows.map((row) => row.item);
  }

  async update(tableName: string, options: UpdateOptions): Promise<Record<string, AttributeValue> | undefined> {
    const pool = await this.ensurePool();
    const client = await pool.connect();

    try {
      await this.ensureTable(client, tableName);

      const schema = getTableSchema(tableName);
      const pkVal = String(options.Key[schema.pk.name] ?? '');
      const skVal = schema.sk ? String(options.Key[schema.sk.name] ?? '') : '';

      // Get current item
      const currentQuery = `
        SELECT item FROM ${DB_SCHEMA}."${sanitizeName(tableName)}"
        WHERE pk_val = $1 AND sk_val = $2;
      `;

      const currentResult = await client.query(currentQuery, [pkVal, skVal]);
      const currentItem = currentResult.rows.length > 0 ? currentResult.rows[0].item : {};

      // Check condition if present
      if (options.ConditionExpression) {
        const names = options.ExpressionAttributeNames || {};
        const values = options.ExpressionAttributeValues || {};
        const context = { item: currentItem, names, values };
        const parser = new ExpressionParser(options.ConditionExpression);
        const ast = parser.parse();

        if (!ExpressionEvaluator.evaluate(ast, context)) {
          const error: any = new Error('The conditional request failed');
          error.name = 'ConditionalCheckFailedException';
          throw error;
        }
      }

      // Apply updates
      const updateParser = new UpdateExpressionParser(
        options.UpdateExpression,
        options.ExpressionAttributeNames || {},
        options.ExpressionAttributeValues || {},
      );
      const actions = updateParser.parse();
      const updatedItem = UpdateExpressionEvaluator.apply(currentItem, actions);

      // Save updated item
      const updateItemQuery = `
        INSERT INTO ${DB_SCHEMA}."${sanitizeName(tableName)}" (pk_val, sk_val, item)
        VALUES ($1, $2, $3)
        ON CONFLICT (pk_val, sk_val) DO UPDATE
        SET item = $3;
      `;

      await client.query(updateItemQuery, [pkVal, skVal, JSON.stringify(updatedItem)]);

      // Return based on ReturnValues
      if (options.ReturnValues === 'ALL_NEW') {
        return updatedItem;
      } else if (options.ReturnValues === 'ALL_OLD') {
        return currentItem;
      }

      return undefined;
    } finally {
      client.release();
    }
  }

  async delete(tableName: string, options: DeleteOptions): Promise<Record<string, AttributeValue> | undefined> {
    const pool = await this.ensurePool();
    const client = await pool.connect();

    try {
      await this.ensureTable(client, tableName);

      const schema = getTableSchema(tableName);
      const pkVal = String(options.Key[schema.pk.name] ?? '');
      const skVal = schema.sk ? String(options.Key[schema.sk.name] ?? '') : '';

      // Get current item
      const selectQuery = `
        SELECT item FROM ${DB_SCHEMA}."${sanitizeName(tableName)}"
        WHERE pk_val = $1 AND sk_val = $2;
      `;

      const selectResult = await client.query(selectQuery, [pkVal, skVal]);
      const item = selectResult.rows.length > 0 ? selectResult.rows[0].item : undefined;

      if (!item) {
        return undefined;
      }

      // Check condition if present
      if (options.ConditionExpression) {
        const names = options.ExpressionAttributeNames || {};
        const values = options.ExpressionAttributeValues || {};
        const context = { item, names, values };
        const parser = new ExpressionParser(options.ConditionExpression);
        const ast = parser.parse();

        if (!ExpressionEvaluator.evaluate(ast, context)) {
          const error: any = new Error('The conditional request failed');
          error.name = 'ConditionalCheckFailedException';
          throw error;
        }
      }

      // Delete
      const deleteQuery = `
        DELETE FROM ${DB_SCHEMA}."${sanitizeName(tableName)}"
        WHERE pk_val = $1 AND sk_val = $2;
      `;

      await client.query(deleteQuery, [pkVal, skVal]);

      return options.ReturnValues === 'ALL_OLD' ? item : undefined;
    } finally {
      client.release();
    }
  }

  async batchWrite(
    tableName: string,
    requestItems: Array<{ DeleteRequest?: { Key: Record<string, AttributeValue> }; PutRequest?: { Item: Record<string, AttributeValue> } }>,
  ): Promise<void> {
    for (const item of requestItems) {
      if (item.PutRequest) {
        await this.put(tableName, item.PutRequest.Item);
      } else if (item.DeleteRequest) {
        const schema = getTableSchema(tableName);
        const pkVal = String(item.DeleteRequest.Key[schema.pk.name] ?? '');
        const skVal = schema.sk ? String(item.DeleteRequest.Key[schema.sk.name] ?? '') : '';

        const pool = await this.ensurePool();
        const client = await pool.connect();

        try {
          await this.ensureTable(client, tableName);
          const deleteQuery = `
            DELETE FROM ${DB_SCHEMA}."${sanitizeName(tableName)}"
            WHERE pk_val = $1 AND sk_val = $2;
          `;
          await client.query(deleteQuery, [pkVal, skVal]);
        } finally {
          client.release();
        }
      }
    }
  }

  async batchGet(
    requests: Array<{ TableName: string; Keys: Record<string, AttributeValue>[] }>,
  ): Promise<Record<string, Record<string, any>[]>> {
    const responses: Record<string, Record<string, any>[]> = {};

    for (const request of requests) {
      const tableName = request.TableName;
      responses[tableName] = [];

      for (const key of request.Keys) {
        const item = await this.get(tableName, key);
        if (item) {
          responses[tableName].push(item);
        }
      }
    }

    return responses;
  }

  async transactWrite(items: TransactWriteItem[]): Promise<void> {
    const pool = await this.ensurePool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const item of items) {
        try {
          if (item.Put) {
            await this.ensureTable(client, item.Put.TableName);
            const schema = getTableSchema(item.Put.TableName);
            const pkVal = String(item.Put.Item[schema.pk.name] ?? '');
            const skVal = schema.sk ? String(item.Put.Item[schema.sk.name] ?? '') : '';

            const query = `
              INSERT INTO ${DB_SCHEMA}."${sanitizeName(item.Put.TableName)}" (pk_val, sk_val, item)
              VALUES ($1, $2, $3)
              ON CONFLICT (pk_val, sk_val) DO UPDATE
              SET item = $3;
            `;

            await client.query(query, [pkVal, skVal, JSON.stringify(item.Put.Item)]);
          } else if (item.Update) {
            // Handle update in transaction
            const tableName = item.Update.TableName;
            const options = {
              Key: item.Update.Key,
              UpdateExpression: item.Update.UpdateExpression,
              ExpressionAttributeNames: item.Update.ExpressionAttributeNames,
              ExpressionAttributeValues: item.Update.ExpressionAttributeValues,
              ConditionExpression: item.Update.ConditionExpression,
              ReturnValues: item.Update.ReturnValues,
            };

            await this.ensureTable(client, tableName);
            const schema = getTableSchema(tableName);
            const pkVal = String(options.Key[schema.pk.name] ?? '');
            const skVal = schema.sk ? String(options.Key[schema.sk.name] ?? '') : '';

            // Get current
            const selectQuery = `
              SELECT item FROM ${DB_SCHEMA}."${sanitizeName(tableName)}"
              WHERE pk_val = $1 AND sk_val = $2 FOR UPDATE;
            `;

            const selectResult = await client.query(selectQuery, [pkVal, skVal]);
            const currentItem = selectResult.rows.length > 0 ? selectResult.rows[0].item : {};

            // Check condition
            if (options.ConditionExpression) {
              const names = options.ExpressionAttributeNames || {};
              const values = options.ExpressionAttributeValues || {};
              const context = { item: currentItem, names, values };
              const parser = new ExpressionParser(options.ConditionExpression);
              const ast = parser.parse();

              if (!ExpressionEvaluator.evaluate(ast, context)) {
                throw new (class extends Error {
                  name = 'ConditionalCheckFailedException';
                })('The conditional request failed');
              }
            }

            // Apply updates
            const updateParser = new UpdateExpressionParser(
              options.UpdateExpression,
              options.ExpressionAttributeNames || {},
              options.ExpressionAttributeValues || {},
            );
            const actions = updateParser.parse();
            const updatedItem = UpdateExpressionEvaluator.apply(currentItem, actions);

            // Save
            const updateQuery = `
              INSERT INTO ${DB_SCHEMA}."${sanitizeName(tableName)}" (pk_val, sk_val, item)
              VALUES ($1, $2, $3)
              ON CONFLICT (pk_val, sk_val) DO UPDATE
              SET item = $3;
            `;

            await client.query(updateQuery, [pkVal, skVal, JSON.stringify(updatedItem)]);
          } else if (item.Delete) {
            const tableName = item.Delete.TableName;
            const schema = getTableSchema(tableName);
            const pkVal = String(item.Delete.Key[schema.pk.name] ?? '');
            const skVal = schema.sk ? String(item.Delete.Key[schema.sk.name] ?? '') : '';

            await this.ensureTable(client, tableName);

            // Get current for condition check
            const selectQuery = `
              SELECT item FROM ${DB_SCHEMA}."${sanitizeName(tableName)}"
              WHERE pk_val = $1 AND sk_val = $2 FOR UPDATE;
            `;

            const selectResult = await client.query(selectQuery, [pkVal, skVal]);
            const currentItem = selectResult.rows.length > 0 ? selectResult.rows[0].item : null;

            if (currentItem && item.Delete.ConditionExpression) {
              const names = item.Delete.ExpressionAttributeNames || {};
              const values = item.Delete.ExpressionAttributeValues || {};
              const context = { item: currentItem, names, values };
              const parser = new ExpressionParser(item.Delete.ConditionExpression);
              const ast = parser.parse();

              if (!ExpressionEvaluator.evaluate(ast, context)) {
                throw new (class extends Error {
                  name = 'ConditionalCheckFailedException';
                })('The conditional request failed');
              }
            }

            const deleteQuery = `
              DELETE FROM ${DB_SCHEMA}."${sanitizeName(tableName)}"
              WHERE pk_val = $1 AND sk_val = $2;
            `;

            await client.query(deleteQuery, [pkVal, skVal]);
          }
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }

      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }
}
