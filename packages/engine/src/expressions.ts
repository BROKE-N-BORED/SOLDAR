// Expression evaluator for {{ }} templates in node parameters.
//
// The language is deliberately small: $json and $node["Name"].json for data,
// literals, arithmetic, comparison, logic, ternaries, and a whitelist of
// string/number/Math helpers. It is a real parser — expressions are never
// run through eval or Function, so a workflow cannot execute arbitrary code
// through a template.

import type { Item } from './types.js';

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/** What an expression can see. `nodeOutputs` maps node name -> main-output items. */
export interface ExpressionScope {
  item: Item;
  nodeOutputs: Map<string, Item[]>;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType =
  | 'number'
  | 'string'
  | 'name'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'dot'
  | 'comma'
  | 'question'
  | 'colon'
  | 'eof';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const OPERATORS = [
  '===',
  '!==',
  '==',
  '!=',
  '>=',
  '<=',
  '&&',
  '||',
  '>',
  '<',
  '+',
  '-',
  '*',
  '/',
  '%',
  '!',
];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '[') {
      tokens.push({ type: 'lbracket', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ']') {
      tokens.push({ type: 'rbracket', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '.') {
      // A dot starts a number only when followed by a digit.
      if (i + 1 < source.length && /[0-9]/.test(source[i + 1])) {
        // Fall through to the number branch.
      } else {
        tokens.push({ type: 'dot', value: ch, pos: i });
        i++;
        continue;
      }
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '?') {
      tokens.push({ type: 'question', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ':') {
      tokens.push({ type: 'colon', value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\' && j + 1 < source.length) {
          const next = source[j + 1];
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else value += next;
          j += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          break;
        }
        value += c;
        j++;
      }
      if (!closed) {
        throw new ExpressionError(`Unterminated string starting at position ${i}.`);
      }
      tokens.push({ type: 'string', value, pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      let seenDot = false;
      while (j < source.length) {
        const c = source[j];
        if (/[0-9]/.test(c)) {
          j++;
          continue;
        }
        if (c === '.' && !seenDot) {
          seenDot = true;
          j++;
          continue;
        }
        break;
      }
      tokens.push({ type: 'number', value: source.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_$]/.test(source[j])) j++;
      tokens.push({ type: 'name', value: source.slice(i, j), pos: i });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      tokens.push({ type: 'op', value: op, pos: i });
      i += op.length;
      continue;
    }
    throw new ExpressionError(`Unexpected character "${ch}" at position ${i}.`);
  }
  tokens.push({ type: 'eof', value: '', pos: source.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (Pratt / precedence climbing)
// ---------------------------------------------------------------------------

type AstNode =
  | { kind: 'literal'; value: unknown }
  | { kind: 'variable'; name: string }
  | { kind: 'member'; object: AstNode; property: string | AstNode; computed: boolean }
  | { kind: 'call'; callee: AstNode; args: AstNode[] }
  | { kind: 'unary'; op: string; arg: AstNode }
  | { kind: 'binary'; op: string; left: AstNode; right: AstNode }
  | { kind: 'ternary'; cond: AstNode; then: AstNode; otherwise: AstNode };

const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '===': 3,
  '!==': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType, what: string): Token {
    const token = this.next();
    if (token.type !== type) {
      throw new ExpressionError(
        `Expected ${what} but found "${token.value || 'end of expression'}".`,
      );
    }
    return token;
  }

  parse(): AstNode {
    const node = this.parseTernary();
    const rest = this.peek();
    if (rest.type !== 'eof') {
      throw new ExpressionError(
        `Unexpected "${rest.value}" after the end of the expression.`,
      );
    }
    return node;
  }

  private parseTernary(): AstNode {
    const cond = this.parseBinary(1);
    if (this.peek().type !== 'question') return cond;
    this.next();
    const then = this.parseTernary();
    this.expect('colon', "':' in a ternary expression");
    const otherwise = this.parseTernary();
    return { kind: 'ternary', cond, then, otherwise };
  }

  private parseBinary(minPrecedence: number): AstNode {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token.type !== 'op') return left;
      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) return left;
      this.next();
      const right = this.parseBinary(precedence + 1);
      left = { kind: 'binary', op: token.value, left, right };
    }
  }

  private parseUnary(): AstNode {
    const token = this.peek();
    if (token.type === 'op' && (token.value === '!' || token.value === '-')) {
      this.next();
      return { kind: 'unary', op: token.value, arg: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): AstNode {
    let node = this.parsePrimary();
    for (;;) {
      const token = this.peek();
      if (token.type === 'dot') {
        this.next();
        const name = this.expect('name', 'a property name after "."');
        node = { kind: 'member', object: node, property: name.value, computed: false };
        continue;
      }
      if (token.type === 'lbracket') {
        this.next();
        const index = this.parseTernary();
        this.expect('rbracket', "']'");
        node = { kind: 'member', object: node, property: index, computed: true };
        continue;
      }
      if (token.type === 'lparen') {
        this.next();
        const args: AstNode[] = [];
        if (this.peek().type !== 'rparen') {
          for (;;) {
            args.push(this.parseTernary());
            if (this.peek().type === 'comma') {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expect('rparen', "')'");
        node = { kind: 'call', callee: node, args };
        continue;
      }
      return node;
    }
  }

  private parsePrimary(): AstNode {
    const token = this.next();
    switch (token.type) {
      case 'number':
        return { kind: 'literal', value: Number(token.value) };
      case 'string':
        return { kind: 'literal', value: token.value };
      case 'name': {
        if (token.value === 'true') return { kind: 'literal', value: true };
        if (token.value === 'false') return { kind: 'literal', value: false };
        if (token.value === 'null') return { kind: 'literal', value: null };
        if (token.value === 'undefined') return { kind: 'literal', value: undefined };
        return { kind: 'variable', name: token.value };
      }
      case 'lparen': {
        const inner = this.parseTernary();
        this.expect('rparen', "')'");
        return inner;
      }
      default:
        throw new ExpressionError(
          token.type === 'eof'
            ? 'Unexpected end of expression.'
            : `Unexpected "${token.value}".`,
        );
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

const STRING_METHODS = new Set([
  'toUpperCase',
  'toLowerCase',
  'trim',
  'trimStart',
  'trimEnd',
  'slice',
  'split',
  'includes',
  'startsWith',
  'endsWith',
  'replace',
  'replaceAll',
  'charAt',
  'substring',
  'indexOf',
  'toString',
]);

const NUMBER_METHODS = new Set(['toString', 'toFixed']);

const ARRAY_METHODS = new Set([
  'includes',
  'indexOf',
  'join',
  'slice',
  'toString',
]);

const MATH_METHODS = new Set([
  'abs',
  'ceil',
  'floor',
  'round',
  'max',
  'min',
  'pow',
  'sqrt',
  'trunc',
  'sign',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readMember(object: unknown, property: string): unknown {
  if (object === null || object === undefined) return undefined;
  if (typeof object === 'string' || Array.isArray(object)) {
    if (property === 'length') return object.length;
  }
  if (isObject(object)) {
    return (object as Record<string, unknown>)[property];
  }
  return undefined;
}

/** The value behind $node["Name"]: first item's json, plus all items. */
function nodeView(name: string, scope: ExpressionScope): Record<string, unknown> {
  const items = scope.nodeOutputs.get(name);
  if (items === undefined) {
    const known = [...scope.nodeOutputs.keys()];
    throw new ExpressionError(
      `Unknown node "${name}" in $node["${name}"].` +
        (known.length > 0
          ? ` Nodes that have run so far: ${known.join(', ')}.`
          : ' No nodes have run yet.'),
    );
  }
  return {
    json: items.length > 0 ? items[0].json : {},
    items: items.map((item) => item.json),
  };
}

function evalCall(
  callee: AstNode,
  args: AstNode[],
  scope: ExpressionScope,
): unknown {
  // Global helpers: String(x), Number(x), Boolean(x).
  if (callee.kind === 'variable') {
    const evaluated = args.map((a) => evaluate(a, scope));
    if (callee.name === 'String') return String(evaluated[0]);
    if (callee.name === 'Number') return Number(evaluated[0]);
    if (callee.name === 'Boolean') return Boolean(evaluated[0]);
    throw new ExpressionError(`Unknown function "${callee.name}".`);
  }

  if (callee.kind === 'member') {
    // Math.xxx(...) and JSON.xxx(...)
    if (callee.object.kind === 'variable') {
      const root = callee.object.name;
      const method = callee.computed
        ? String(evaluate(callee.property as AstNode, scope))
        : (callee.property as string);
      const evaluated = args.map((a) => evaluate(a, scope));
      if (root === 'Math') {
        if (!MATH_METHODS.has(method)) {
          throw new ExpressionError(`Math.${method} is not available in expressions.`);
        }
        return (Math as unknown as Record<string, (...a: never[]) => unknown>)[
          method
        ](...(evaluated as never[]));
      }
      if (root === 'JSON') {
        if (method === 'stringify') return JSON.stringify(evaluated[0]);
        if (method === 'parse') {
          try {
            return JSON.parse(String(evaluated[0]));
          } catch {
            throw new ExpressionError('JSON.parse failed: the value is not valid JSON.');
          }
        }
        throw new ExpressionError(`JSON.${method} is not available in expressions.`);
      }
    }

    // value.method(...) — whitelisted methods only.
    const target = evaluate(callee.object, scope);
    const method = callee.computed
      ? String(evaluate(callee.property as AstNode, scope))
      : (callee.property as string);
    const evaluated = args.map((a) => evaluate(a, scope));
    if (typeof target === 'string') {
      if (!STRING_METHODS.has(method)) {
        throw new ExpressionError(`.${method}() is not available on strings in expressions.`);
      }
      return (target as unknown as Record<string, (...a: never[]) => unknown>)[
        method
      ](...(evaluated as never[]));
    }
    if (typeof target === 'number') {
      if (!NUMBER_METHODS.has(method)) {
        throw new ExpressionError(`.${method}() is not available on numbers in expressions.`);
      }
      return (target as unknown as Record<string, (...a: never[]) => unknown>)[
        method
      ](...(evaluated as never[]));
    }
    if (Array.isArray(target)) {
      if (!ARRAY_METHODS.has(method)) {
        throw new ExpressionError(`.${method}() is not available on lists in expressions.`);
      }
      return (target as unknown as Record<string, (...a: never[]) => unknown>)[
        method
      ](...(evaluated as never[]));
    }
    throw new ExpressionError(
      `Cannot call .${method}() on ${target === null ? 'null' : typeof target}.`,
    );
  }

  throw new ExpressionError('Only named functions and whitelisted methods can be called.');
}

function evaluate(node: AstNode, scope: ExpressionScope): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'variable': {
      if (node.name === '$json') return scope.item.json;
      if (node.name === '$node') return { __nodeRoot: true };
      if (node.name === 'Math' || node.name === 'JSON') {
        // Only reachable as Math.xxx / JSON.xxx; a bare reference is an error.
        throw new ExpressionError(`"${node.name}" can only be used as ${node.name}.method(...).`);
      }
      throw new ExpressionError(
        `Unknown name "${node.name}". Expressions can use $json, $node["Name"], Math, JSON, String, Number, and Boolean.`,
      );
    }
    case 'member': {
      // $node["Name"] resolves through the node view.
      if (node.object.kind === 'variable' && node.object.name === '$node') {
        const name = node.computed
          ? String(evaluate(node.property as AstNode, scope))
          : (node.property as string);
        return nodeView(name, scope);
      }
      const object = evaluate(node.object, scope);
      const property = node.computed
        ? String(evaluate(node.property as AstNode, scope))
        : (node.property as string);
      return readMember(object, property);
    }
    case 'call':
      return evalCall(node.callee, node.args, scope);
    case 'unary': {
      const value = evaluate(node.arg, scope);
      if (node.op === '!') return !value;
      if (node.op === '-') return -(value as number);
      throw new ExpressionError(`Unknown operator "${node.op}".`);
    }
    case 'binary': {
      if (node.op === '&&') {
        const left = evaluate(node.left, scope);
        return left ? evaluate(node.right, scope) : left;
      }
      if (node.op === '||') {
        const left = evaluate(node.left, scope);
        return left ? left : evaluate(node.right, scope);
      }
      const left = evaluate(node.left, scope) as never;
      const right = evaluate(node.right, scope) as never;
      switch (node.op) {
        case '+':
          return (left as never) + (right as never);
        case '-':
          return (left as number) - (right as number);
        case '*':
          return (left as number) * (right as number);
        case '/':
          return (left as number) / (right as number);
        case '%':
          return (left as number) % (right as number);
        case '==':
          // eslint-disable-next-line eqeqeq
          return left == right;
        case '!=':
          // eslint-disable-next-line eqeqeq
          return left != right;
        case '===':
          return left === right;
        case '!==':
          return left !== right;
        case '<':
          return left < right;
        case '>':
          return left > right;
        case '<=':
          return left <= right;
        case '>=':
          return left >= right;
        default:
          throw new ExpressionError(`Unknown operator "${node.op}".`);
      }
    }
    case 'ternary':
      return evaluate(node.cond, scope)
        ? evaluate(node.then, scope)
        : evaluate(node.otherwise, scope);
  }
}

/** Evaluate one expression (the text inside {{ }}), with a readable error. */
export function evaluateExpression(source: string, scope: ExpressionScope): unknown {
  try {
    const ast = new Parser(tokenize(source)).parse();
    return evaluate(ast, scope);
  } catch (err) {
    if (err instanceof ExpressionError) {
      throw new ExpressionError(`In "{{ ${source.trim()} }}": ${err.message}`);
    }
    throw err;
  }
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Evaluate a template string. If the whole string is one {{ }} expression,
 * the raw value comes back (so numbers stay numbers). Otherwise each
 * {{ }} is replaced with its string form.
 */
export function evaluateTemplate(template: string, scope: ExpressionScope): unknown {
  const matches = [...template.matchAll(/\{\{([\s\S]*?)\}\}/g)];
  if (matches.length === 0) return template;
  if (matches.length === 1 && template.trim() === matches[0][0]) {
    return evaluateExpression(matches[0][1], scope);
  }
  return template.replace(/\{\{([\s\S]*?)\}\}/g, (_whole, expr: string) =>
    stringifyValue(evaluateExpression(expr, scope)),
  );
}

/** Walk a parameters object and evaluate every {{ }} string in it. */
export function evaluateParameters(
  params: Record<string, unknown>,
  scope: ExpressionScope,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return evaluateTemplate(value, scope);
    if (Array.isArray(value)) return value.map(walk);
    if (isObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) out[key] = walk(entry);
      return out;
    }
    return value;
  };
  return walk(params) as Record<string, unknown>;
}
