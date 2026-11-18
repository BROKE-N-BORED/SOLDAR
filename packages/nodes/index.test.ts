// Registry tests: node types must be unique, or one definition would
// silently shadow another.

import { describe, expect, it } from 'vitest';
import { allNodes, assertNoDuplicateTypes } from './index.js';

describe('node registry', () => {
  it('has no duplicate types', () => {
    expect(() => assertNoDuplicateTypes(allNodes)).not.toThrow();
    const types = allNodes.map((n) => n.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('refuses a duplicate type', () => {
    expect(() => assertNoDuplicateTypes([allNodes[0], allNodes[0]])).toThrow(
      `Duplicate node type "${allNodes[0].type}"`,
    );
  });
});
