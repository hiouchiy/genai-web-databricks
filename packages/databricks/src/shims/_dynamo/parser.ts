/**
 * DynamoDB expression parser for KeyConditionExpression, FilterExpression, etc.
 */

export interface Token {
  type:
    | 'IDENTIFIER'
    | 'PLACEHOLDER'
    | 'STRING'
    | 'NUMBER'
    | 'OPERATOR'
    | 'FUNCTION'
    | 'LPAREN'
    | 'RPAREN'
    | 'COMMA'
    | 'EOF';
  value: string;
  raw?: string;
}

export interface ParseNode {
  type: 'comparison' | 'function' | 'and' | 'or' | 'not' | 'exists' | 'attribute';
  operator?: string;
  left?: ParseNode;
  right?: ParseNode;
  name?: string;
  args?: ParseNode[];
}

export class Tokenizer {
  private input: string;
  private pos: number = 0;

  constructor(input: string) {
    this.input = input;
  }

  private current(): string | undefined {
    return this.input[this.pos];
  }

  private peek(offset: number = 1): string | undefined {
    return this.input[this.pos + offset];
  }

  private advance(): void {
    this.pos++;
  }

  private skipWhitespace(): void {
    while (this.current() && /\s/.test(this.current()!)) {
      this.advance();
    }
  }

  private readIdentifier(): string {
    let result = '';
    while (this.current() && /[a-zA-Z0-9_#.]/.test(this.current()!)) {
      result += this.current();
      this.advance();
    }
    return result;
  }

  private readNumber(): string {
    let result = '';
    while (this.current() && /[0-9.\-+eE]/.test(this.current()!)) {
      result += this.current();
      this.advance();
    }
    return result;
  }

  private readString(): string {
    const quote = this.current();
    this.advance(); // skip opening quote
    let result = '';
    while (this.current() && this.current() !== quote) {
      if (this.current() === '\\') {
        this.advance();
        result += this.current();
        this.advance();
      } else {
        result += this.current();
        this.advance();
      }
    }
    this.advance(); // skip closing quote
    return result;
  }

  nextToken(): Token {
    this.skipWhitespace();

    if (this.pos >= this.input.length) {
      return { type: 'EOF', value: '' };
    }

    const c = this.current()!;

    if (c === '(') {
      this.advance();
      return { type: 'LPAREN', value: '(' };
    }

    if (c === ')') {
      this.advance();
      return { type: 'RPAREN', value: ')' };
    }

    if (c === ',') {
      this.advance();
      return { type: 'COMMA', value: ',' };
    }

    if (c === ':') {
      this.advance();
      const name = this.readIdentifier();
      return { type: 'PLACEHOLDER', value: ':' + name, raw: name };
    }

    if (c === '#') {
      this.advance();
      const name = this.readIdentifier();
      return { type: 'IDENTIFIER', value: '#' + name, raw: name };
    }

    if (/[a-zA-Z_]/.test(c)) {
      const ident = this.readIdentifier();
      const upper = ident.toUpperCase();

      // Check for functions
      if (this.current() === '(') {
        return { type: 'FUNCTION', value: ident };
      }

      // Check for operators
      if (['AND', 'OR', 'NOT', 'BETWEEN', 'IN', 'ATTRIBUTE_EXISTS', 'ATTRIBUTE_NOT_EXISTS'].includes(upper)) {
        return { type: 'OPERATOR', value: upper };
      }

      // Otherwise it's an identifier
      return { type: 'IDENTIFIER', value: ident };
    }

    if (/[0-9\-+.]/.test(c)) {
      const num = this.readNumber();
      return { type: 'NUMBER', value: num };
    }

    if (c === '"' || c === "'") {
      const str = this.readString();
      return { type: 'STRING', value: str };
    }

    // Operators: =, <>, <=, >=, <, >
    if (c === '=' || c === '<' || c === '>') {
      let op = c;
      if ((c === '<' || c === '>') && this.peek() === '=') {
        op += this.peek();
        this.advance();
      } else if (c === '<' && this.peek() === '>') {
        op = '<>';
        this.advance();
      }
      this.advance();
      return { type: 'OPERATOR', value: op };
    }

    throw new Error(`Unexpected character: ${c}`);
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    let token = this.nextToken();
    while (token.type !== 'EOF') {
      tokens.push(token);
      token = this.nextToken();
    }
    tokens.push(token);
    return tokens;
  }
}

export class ExpressionParser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(expression: string) {
    const tokenizer = new Tokenizer(expression);
    this.tokens = tokenizer.tokenize();
  }

  private current(): Token {
    return this.tokens[this.pos] || { type: 'EOF', value: '' };
  }

  private peek(offset: number = 1): Token {
    return this.tokens[this.pos + offset] || { type: 'EOF', value: '' };
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: string, value?: string): Token {
    const token = this.current();
    if (token.type !== type || (value && token.value !== value)) {
      throw new Error(`Expected ${type} ${value || ''}, got ${token.type} ${token.value}`);
    }
    this.advance();
    return token;
  }

  parse(): ParseNode {
    const result = this.parseOr();
    if (this.current().type !== 'EOF') {
      throw new Error(`Unexpected token: ${this.current().value}`);
    }
    return result;
  }

  private parseOr(): ParseNode {
    let left = this.parseAnd();

    while (this.current().type === 'OPERATOR' && this.current().value === 'OR') {
      this.advance();
      const right = this.parseAnd();
      left = {
        type: 'or',
        left,
        right,
      };
    }

    return left;
  }

  private parseAnd(): ParseNode {
    let left = this.parseNot();

    while (this.current().type === 'OPERATOR' && this.current().value === 'AND') {
      this.advance();
      const right = this.parseNot();
      left = {
        type: 'and',
        left,
        right,
      };
    }

    return left;
  }

  private parseNot(): ParseNode {
    if (this.current().type === 'OPERATOR' && this.current().value === 'NOT') {
      this.advance();
      const operand = this.parsePrimary();
      return {
        type: 'not',
        args: [operand],
      };
    }

    return this.parsePrimary();
  }

  private parsePrimary(): ParseNode {
    // Handle parentheses
    if (this.current().type === 'LPAREN') {
      this.advance();
      const expr = this.parseOr();
      this.expect('RPAREN');
      return expr;
    }

    // Handle functions
    if (this.current().type === 'FUNCTION') {
      const funcName = this.advance().value.toLowerCase();
      this.expect('LPAREN');

      const args: ParseNode[] = [];
      if (this.current().type !== 'RPAREN') {
        args.push(this.parseArgument());
        while (this.current().type === 'COMMA') {
          this.advance();
          args.push(this.parseArgument());
        }
      }

      this.expect('RPAREN');

      return {
        type: 'function',
        operator: funcName,
        args,
      };
    }

    // Handle attribute_exists / attribute_not_exists
    if (this.current().type === 'OPERATOR') {
      const op = this.current().value.toUpperCase();
      if (op === 'ATTRIBUTE_EXISTS' || op === 'ATTRIBUTE_NOT_EXISTS') {
        this.advance();
        this.expect('LPAREN');
        const attr = this.parseArgument();
        this.expect('RPAREN');
        return {
          type: 'exists',
          operator: op === 'ATTRIBUTE_EXISTS' ? 'exists' : 'not_exists',
          args: [attr],
        };
      }
    }

    // Handle comparison
    return this.parseComparison();
  }

  private parseComparison(): ParseNode {
    const left = this.parseArgument();

    const op = this.current().value.toUpperCase();
    if (!['=', '<', '>', '<=', '>=', '<>', 'BETWEEN'].includes(op)) {
      return left;
    }

    if (op === 'BETWEEN') {
      this.advance(); // consume BETWEEN
      const lower = this.parseArgument();
      this.expect('OPERATOR', 'AND');
      const upper = this.parseArgument();

      return {
        type: 'function',
        operator: 'between',
        args: [left, lower, upper],
      };
    }

    this.advance();
    const right = this.parseArgument();

    return {
      type: 'comparison',
      operator: op,
      left,
      right,
    };
  }

  private parseArgument(): ParseNode {
    const token = this.current();

    if (token.type === 'IDENTIFIER') {
      this.advance();
      return {
        type: 'attribute',
        name: token.value,
      };
    }

    if (token.type === 'PLACEHOLDER') {
      this.advance();
      return {
        type: 'attribute',
        name: token.value,
      };
    }

    if (token.type === 'STRING' || token.type === 'NUMBER') {
      this.advance();
      return {
        type: 'attribute',
        name: token.value,
      };
    }

    // Handle function calls in argument position
    if (token.type === 'FUNCTION') {
      return this.parsePrimary();
    }

    throw new Error(`Unexpected token in argument: ${token.value}`);
  }
}
