import { describe, expect, it } from 'vitest';
import { Key } from '@nut-tree-fork/shared';
import { modifierKeys, parseKeyCombo } from '../tools/key-combo.js';

describe('parseKeyCombo', () => {
  it('parses modifiers and keys', () => {
    const p = parseKeyCombo('ctrl+shift+t');
    expect(p.modifiers).toEqual([Key.LeftControl, Key.LeftShift]);
    expect(p.keys).toEqual([Key.T]);
  });
  it('parses named keys, digits, function keys and punctuation', () => {
    expect(parseKeyCombo('enter').keys).toEqual([Key.Enter]);
    expect(parseKeyCombo('Esc').keys).toEqual([Key.Escape]);
    expect(parseKeyCombo('alt+F4').keys).toEqual([Key.F4]);
    expect(parseKeyCombo('ctrl+1').keys).toEqual([Key.Num1]);
    expect(parseKeyCombo('ctrl+/').keys).toEqual([Key.Slash]);
    expect(parseKeyCombo('ctrl++').keys).toEqual([Key.Add]);
    expect(parseKeyCombo('pagedown').keys).toEqual([Key.PageDown]);
    expect(parseKeyCombo('f12').keys).toEqual([Key.F12]);
  });
  it('maps win/meta to the platform super key and handles lone modifiers', () => {
    const p = parseKeyCombo('win');
    expect(p.modifiers.length).toBe(1);
    expect(p.keys).toEqual([]);
    expect([Key.LeftSuper, Key.LeftCmd]).toContain(p.modifiers[0]);
  });
  it('throws on unknown tokens', () => {
    expect(() => parseKeyCombo('ctrl+banana')).toThrow(/Unknown key/);
    expect(() => parseKeyCombo('')).toThrow();
  });
  it('maps mouse modifiers', () => {
    expect(modifierKeys(['ctrl', 'shift', 'bogus'])).toEqual([Key.LeftControl, Key.LeftShift]);
    expect(modifierKeys(undefined)).toEqual([]);
  });
});
