import { describe, expect, it } from 'vitest';
import { entryToItem } from './items.js';

describe('entryToItem', () => {
  it('treats a plain object as the item json', () => {
    expect(entryToItem({ name: 'Ada' })).toEqual({ json: { name: 'Ada' } });
  });

  it('unwraps a { json } item', () => {
    expect(entryToItem({ json: { n: 1 } })).toEqual({ json: { n: 1 } });
  });

  it('returns null for non-objects', () => {
    expect(entryToItem(null)).toBeNull();
    expect(entryToItem('x')).toBeNull();
    expect(entryToItem(42)).toBeNull();
    expect(entryToItem([1, 2])).toBeNull();
    expect(entryToItem(undefined)).toBeNull();
  });
});
