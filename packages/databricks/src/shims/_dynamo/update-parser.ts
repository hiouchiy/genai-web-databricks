/**
 * DynamoDB UpdateExpression parser and evaluator.
 * Handles: SET, ADD, REMOVE, DELETE (for sets), list_append, if_not_exists
 */

import type { AttributeValue } from './evaluator';

export interface UpdateAction {
  type: 'SET' | 'ADD' | 'REMOVE' | 'DELETE';
  path: string; // attribute path (can contain . for nested)
  value?: any; // for SET, ADD, DELETE
}

export class UpdateExpressionParser {
  private expression: string;
  private names: Record<string, string>;
  private values: Record<string, any>;

  constructor(expression: string, names: Record<string, string>, values: Record<string, any>) {
    this.expression = expression;
    this.names = names;
    this.values = values;
  }

  parse(): UpdateAction[] {
    const actions: UpdateAction[] = [];
    const clauses = this.parseClause(this.expression);

    for (const clause of clauses) {
      actions.push(...this.parseUpdateClause(clause));
    }

    return actions;
  }

  private parseClause(expr: string): { type: string; body: string }[] {
    const clauses: { type: string; body: string }[] = [];
    const keywords = ['SET', 'ADD', 'REMOVE', 'DELETE'];
    let remaining = expr;

    while (remaining.length > 0) {
      remaining = remaining.trim();
      let found = false;

      for (const keyword of keywords) {
        if (remaining.toUpperCase().startsWith(keyword)) {
          const nextKeywordPos = this.findNextKeyword(remaining, keyword.length);
          const clauseBody = remaining.substring(keyword.length, nextKeywordPos).trim();
          clauses.push({ type: keyword, body: clauseBody });
          remaining = remaining.substring(nextKeywordPos);
          found = true;
          break;
        }
      }

      if (!found) {
        throw new Error(`Invalid UpdateExpression: ${remaining}`);
      }
    }

    return clauses;
  }

  private findNextKeyword(str: string, startPos: number): number {
    const keywords = ['SET', 'ADD', 'REMOVE', 'DELETE'];
    let minPos = str.length;

    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      const match = str.substring(startPos).match(regex);
      if (match) {
        const pos = startPos + match.index!;
        if (pos < minPos) {
          minPos = pos;
        }
      }
    }

    return minPos;
  }

  private parseUpdateClause(clause: { type: string; body: string }): UpdateAction[] {
    const actions: UpdateAction[] = [];
    const assignments = this.smartSplit(clause.body, ',');

    for (const assignment of assignments) {
      if (!assignment) continue;

      switch (clause.type) {
        case 'SET':
          actions.push(...this.parseSetAction(assignment));
          break;
        case 'ADD':
          actions.push(this.parseAddAction(assignment));
          break;
        case 'REMOVE':
          actions.push(this.parseRemoveAction(assignment));
          break;
        case 'DELETE':
          actions.push(this.parseDeleteAction(assignment));
          break;
      }
    }

    return actions;
  }

  private smartSplit(str: string, delimiter: string): string[] {
    const result: string[] = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
      } else if (char === delimiter && depth === 0) {
        result.push(current.trim());
        current = '';
        continue;
      }

      current += char;
    }

    if (current) {
      result.push(current.trim());
    }

    return result;
  }

  private parseSetAction(assignment: string): UpdateAction[] {
    const actions: UpdateAction[] = [];

    // Find the first = at depth 0
    let eqPos = -1;
    let depth = 0;
    for (let i = 0; i < assignment.length; i++) {
      if (assignment[i] === '(') depth++;
      else if (assignment[i] === ')') depth--;
      else if (assignment[i] === '=' && depth === 0) {
        eqPos = i;
        break;
      }
    }

    if (eqPos === -1) {
      throw new Error(`Invalid SET action: ${assignment}`);
    }

    const path = assignment.substring(0, eqPos).trim();
    const valueExpr = assignment.substring(eqPos + 1).trim();

    if (!path || !valueExpr) {
      throw new Error(`Invalid SET action: ${assignment}`);
    }

    const actualPath = this.resolvePath(path);

    // Handle functions in SET
    if (valueExpr.includes('if_not_exists')) {
      // if_not_exists(#attr, :val)
      const match = valueExpr.match(/if_not_exists\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/i);
      if (match) {
        const ifAttr = this.resolvePath(match[1].trim());
        const ifVal = this.resolveValue(match[2].trim());
        actions.push({
          type: 'SET',
          path: actualPath,
          value: { type: 'if_not_exists', attr: ifAttr, defaultValue: ifVal },
        });
        return actions;
      }
    }

    if (valueExpr.includes('list_append')) {
      // list_append(#attr, :val)
      const match = valueExpr.match(/list_append\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/i);
      if (match) {
        const listAttr = this.resolvePath(match[1].trim());
        const listVal = this.resolveValue(match[2].trim());
        actions.push({
          type: 'SET',
          path: actualPath,
          value: { type: 'list_append', attr: listAttr, values: listVal },
        });
        return actions;
      }
    }

    // Handle addition in SET (e.g., #attr + :val)
    if (valueExpr.includes('+')) {
      const parts = this.smartSplit(valueExpr, '+');
      const values = parts.map((p) => this.resolveValue(p));
      actions.push({
        type: 'SET',
        path: actualPath,
        value: { type: 'add', values },
      });
      return actions;
    }

    const value = this.resolveValue(valueExpr);
    actions.push({
      type: 'SET',
      path: actualPath,
      value,
    });

    return actions;
  }

  private parseAddAction(assignment: string): UpdateAction {
    const [path, valueExpr] = assignment.split(' ').slice(0, 2);

    if (!path || !valueExpr) {
      throw new Error(`Invalid ADD action: ${assignment}`);
    }

    const actualPath = this.resolvePath(path);
    const value = this.resolveValue(valueExpr);

    return {
      type: 'ADD',
      path: actualPath,
      value,
    };
  }

  private parseRemoveAction(assignment: string): UpdateAction {
    const path = assignment.trim();
    if (!path) {
      throw new Error(`Invalid REMOVE action: ${assignment}`);
    }

    return {
      type: 'REMOVE',
      path: this.resolvePath(path),
    };
  }

  private parseDeleteAction(assignment: string): UpdateAction {
    const [path, valueExpr] = assignment.split(' ').slice(0, 2);

    if (!path || !valueExpr) {
      throw new Error(`Invalid DELETE action: ${assignment}`);
    }

    return {
      type: 'DELETE',
      path: this.resolvePath(path),
      value: this.resolveValue(valueExpr),
    };
  }

  private resolvePath(path: string): string {
    path = path.trim();
    // Replace #name placeholders with actual names
    return path.replace(/#\w+/g, (match) => {
      const resolved = this.names[match];
      if (!resolved) throw new Error(`Attribute name ${match} not found`);
      return resolved;
    });
  }

  private resolveValue(valueExpr: string): any {
    valueExpr = valueExpr.trim();

    // If it's a placeholder, resolve it
    if (valueExpr.startsWith(':')) {
      const value = this.values[valueExpr];
      if (value === undefined) throw new Error(`Value ${valueExpr} not found`);
      return value;
    }

    // Otherwise return as string/literal
    return valueExpr;
  }
}

export class UpdateExpressionEvaluator {
  static apply(item: Record<string, any>, actions: UpdateAction[]): Record<string, any> {
    const result = { ...item };

    for (const action of actions) {
      switch (action.type) {
        case 'SET':
          this.applySet(result, action);
          break;
        case 'ADD':
          this.applyAdd(result, action);
          break;
        case 'REMOVE':
          this.applyRemove(result, action);
          break;
        case 'DELETE':
          this.applyDelete(result, action);
          break;
      }
    }

    return result;
  }

  private static applySet(item: Record<string, any>, action: UpdateAction): void {
    const path = action.path;
    let value = action.value;

    // Handle special value types
    if (value && typeof value === 'object') {
      if (value.type === 'if_not_exists') {
        // Only set if attribute doesn't exist
        if (!(value.attr in item)) {
          this.setPath(item, path, value.defaultValue);
        }
        return;
      }

      if (value.type === 'list_append') {
        // Append to list
        const existingList = this.getPath(item, value.attr) || [];
        const newItems = Array.isArray(value.values) ? value.values : [value.values];
        this.setPath(item, path, [...existingList, ...newItems]);
        return;
      }

      if (value.type === 'add') {
        // Add values together
        const sum = value.values.reduce((acc: any, v: any) => {
          const a = typeof acc === 'number' ? acc : Number(acc) || 0;
          const b = typeof v === 'number' ? v : Number(v) || 0;
          return a + b;
        }, 0);
        this.setPath(item, path, sum);
        return;
      }
    }

    this.setPath(item, path, value);
  }

  private static applyAdd(item: Record<string, any>, action: UpdateAction): void {
    const path = action.path;
    const value = action.value;

    const existing = this.getPath(item, path);

    if (typeof existing === 'number' || typeof value === 'number') {
      // Numeric add
      const existingNum = typeof existing === 'number' ? existing : Number(existing) || 0;
      const valueNum = typeof value === 'number' ? value : Number(value) || 0;
      this.setPath(item, path, existingNum + valueNum);
    } else if (Array.isArray(existing) && Array.isArray(value)) {
      // Set add - union of sets (arrays)
      const combined = [...new Set([...existing, ...value])];
      this.setPath(item, path, combined);
    } else {
      throw new Error(`Cannot ADD to non-numeric/non-set value`);
    }
  }

  private static applyRemove(item: Record<string, any>, action: UpdateAction): void {
    const path = action.path;
    const parts = path.split('.');

    if (parts.length === 1) {
      delete item[path];
      return;
    }

    // Navigate to parent and delete
    let current = item;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) {
        return;
      }
      current = current[parts[i]];
    }

    delete current[parts[parts.length - 1]];
  }

  private static applyDelete(item: Record<string, any>, action: UpdateAction): void {
    const path = action.path;
    const existing = this.getPath(item, path);

    if (!Array.isArray(existing)) {
      throw new Error(`DELETE requires a set (array)`);
    }

    const toDelete = Array.isArray(action.value) ? action.value : [action.value];
    const result = existing.filter((v) => !toDelete.includes(v));
    this.setPath(item, path, result);
  }

  private static getPath(item: Record<string, any>, path: string): any {
    const parts = path.split('.');
    let current = item;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  private static setPath(item: Record<string, any>, path: string, value: any): void {
    const parts = path.split('.');

    if (parts.length === 1) {
      item[path] = value;
      return;
    }

    let current = item;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }

    current[parts[parts.length - 1]] = value;
  }
}
