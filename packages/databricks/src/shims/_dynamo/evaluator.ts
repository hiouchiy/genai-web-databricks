/**
 * DynamoDB expression evaluator.
 * Evaluates parsed expressions against items and attribute values.
 */

import type { ParseNode } from './parser';

export type AttributeValue =
  | string
  | number
  | boolean
  | null
  | AttributeValue[]
  | { [key: string]: AttributeValue };

export interface EvaluationContext {
  item: Record<string, any>;
  names: Record<string, string>;
  values: Record<string, AttributeValue>;
}

export class ExpressionEvaluator {
  static evaluate(node: ParseNode, context: EvaluationContext): boolean {
    switch (node.type) {
      case 'comparison':
        return this.evaluateComparison(node, context);
      case 'function':
        return this.evaluateFunction(node, context);
      case 'and':
        return (
          this.evaluate(node.left!, context) &&
          this.evaluate(node.right!, context)
        );
      case 'or':
        return (
          this.evaluate(node.left!, context) ||
          this.evaluate(node.right!, context)
        );
      case 'not':
        return !this.evaluate(node.args![0], context);
      case 'exists':
        return this.evaluateExists(node, context);
      case 'attribute':
        throw new Error('Cannot evaluate attribute node directly');
      default:
        throw new Error(`Unknown node type: ${(node as any).type}`);
    }
  }

  private static evaluateComparison(node: ParseNode, context: EvaluationContext): boolean {
    const left = this.getValue(node.left!, context);
    const right = this.getValue(node.right!, context);
    const op = node.operator!.toUpperCase();

    switch (op) {
      case '=':
        return this.equals(left, right);
      case '<>':
        return !this.equals(left, right);
      case '<':
        return this.compare(left, right) < 0;
      case '>':
        return this.compare(left, right) > 0;
      case '<=':
        return this.compare(left, right) <= 0;
      case '>=':
        return this.compare(left, right) >= 0;
      default:
        throw new Error(`Unknown operator: ${op}`);
    }
  }

  private static evaluateFunction(node: ParseNode, context: EvaluationContext): boolean {
    const func = node.operator!.toLowerCase();
    const args = node.args || [];

    switch (func) {
      case 'begins_with':
        if (args.length !== 2) throw new Error('begins_with requires 2 arguments');
        const str = this.getValue(args[0], context);
        const prefix = this.getValue(args[1], context);
        return String(str).startsWith(String(prefix));

      case 'contains':
        if (args.length !== 2) throw new Error('contains requires 2 arguments');
        const container = this.getValue(args[0], context);
        const value = this.getValue(args[1], context);
        return String(container).includes(String(value));

      case 'between':
        if (args.length !== 3) throw new Error('between requires 3 arguments');
        const val = this.getValue(args[0], context);
        const lower = this.getValue(args[1], context);
        const upper = this.getValue(args[2], context);
        return this.compare(val, lower) >= 0 && this.compare(val, upper) <= 0;

      case 'attribute_exists':
        if (args.length !== 1) throw new Error('attribute_exists requires 1 argument');
        const attrName = this.getAttributeName(args[0], context);
        return attrName in context.item;

      case 'attribute_not_exists':
        if (args.length !== 1) throw new Error('attribute_not_exists requires 1 argument');
        const attrName2 = this.getAttributeName(args[0], context);
        return !(attrName2 in context.item);

      default:
        throw new Error(`Unknown function: ${func}`);
    }
  }

  private static evaluateExists(node: ParseNode, context: EvaluationContext): boolean {
    const op = node.operator!;
    const arg = node.args![0];
    const attrName = this.getAttributeName(arg, context);

    if (op === 'exists') {
      return attrName in context.item;
    } else if (op === 'not_exists') {
      return !(attrName in context.item);
    }

    throw new Error(`Unknown exists operator: ${op}`);
  }

  private static getValue(node: ParseNode, context: EvaluationContext): any {
    if (node.type === 'attribute') {
      return this.resolveAttribute(node.name!, context);
    }
    throw new Error(`Cannot get value from node type: ${node.type}`);
  }

  private static getAttributeName(node: ParseNode, context: EvaluationContext): string {
    if (node.type === 'attribute') {
      const name = node.name!;
      // If it starts with #, it's an attribute name placeholder
      if (name.startsWith('#')) {
        const resolved = context.names[name];
        if (!resolved) throw new Error(`Attribute name ${name} not found`);
        return resolved;
      }
      return name;
    }
    throw new Error(`Expected attribute node`);
  }

  private static resolveAttribute(name: string, context: EvaluationContext): any {
    // If it starts with #, it's an attribute name placeholder
    if (name.startsWith('#')) {
      const actualName = context.names[name];
      if (!actualName) throw new Error(`Attribute name ${name} not found`);
      return context.item[actualName];
    }

    // If it starts with :, it's a value placeholder
    if (name.startsWith(':')) {
      const value = context.values[name];
      if (value === undefined) throw new Error(`Value ${name} not found`);
      return value;
    }

    // Otherwise it's a literal attribute name
    return context.item[name];
  }

  private static equals(a: any, b: any): boolean {
    // Handle null/undefined
    if (a === null || a === undefined) {
      return b === null || b === undefined;
    }
    if (b === null || b === undefined) {
      return false;
    }

    // For arrays and objects, do deep comparison
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((v, i) => this.equals(v, b[i]));
    }

    if (typeof a === 'object' && typeof b === 'object') {
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return false;
      return aKeys.every((k) => this.equals(a[k], b[k]));
    }

    // String comparison
    return String(a) === String(b);
  }

  private static compare(a: any, b: any): number {
    // Convert to strings for comparison if they're numbers stored as strings
    const aStr = String(a);
    const bStr = String(b);

    // Try numeric comparison first
    const aNum = Number(aStr);
    const bNum = Number(bStr);

    if (!isNaN(aNum) && !isNaN(bNum)) {
      return aNum - bNum;
    }

    // Fall back to string comparison
    return aStr.localeCompare(bStr);
  }
}
