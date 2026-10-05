import { describe, expect, it } from 'vitest';
import { isSet, parseFlags, valueOf } from '../../scripts/lib/cli-args';

describe('parseFlags', () => {
  it('reads a boolean flag', () => {
    expect(parseFlags(['--write'], { boolean: ['write'] })).toEqual(new Map([['write', true]]));
  });

  it('reads a value flag', () => {
    expect(parseFlags(['--to', 'a@b.c'], { value: ['to'] })).toEqual(new Map([['to', 'a@b.c']]));
  });

  it('resolves an alias to its long name', () => {
    expect(parseFlags(['-w'], { boolean: ['write'], alias: { w: 'write' } })).toEqual(new Map([['write', true]]));
  });

  it('rejects an undeclared flag by name rather than ignoring it', () => {
    // A mistyped `--write` must not degrade into "ran with no flags", which would
    // report success having changed nothing.
    expect(() => parseFlags(['--wirte'], { boolean: ['write'] })).toThrow(/Unknown argument: --wirte/);
  });

  it('rejects a value flag with no value, naming the flag', () => {
    expect(() => parseFlags(['--to'], { value: ['to'] })).toThrow(/--to requires a value/);
  });

  it('treats a following flag as a missing value rather than capturing it', () => {
    // `--to --dry-run` must report the real problem instead of storing "--dry-run".
    expect(() => parseFlags(['--to', '--dry-run'], { value: ['to'], boolean: ['dry-run'] })).toThrow(/--to requires a value/);
  });

  it('rejects a repeated flag', () => {
    expect(() => parseFlags(['--write', '--write'], { boolean: ['write'] })).toThrow(/--write was given more than once/);
    expect(() => parseFlags(['--to', 'a', '--to', 'b'], { value: ['to'] })).toThrow(/--to was given more than once/);
  });

  it('rejects a bare positional argument', () => {
    expect(() => parseFlags(['stray'], {})).toThrow(/Unexpected argument: stray/);
  });
});

describe('valueOf and isSet', () => {
  const flags = parseFlags(['--to', 'a@b.c', '--dry-run'], { value: ['to'], boolean: ['dry-run'] });

  it('reads a supplied value', () => {
    expect(valueOf(flags, 'to')).toBe('a@b.c');
  });

  it('returns undefined for an absent flag, which is not the empty string', () => {
    expect(valueOf(flags, 'absent')).toBeUndefined();
  });

  it('returns undefined for a boolean flag, which is not its value', () => {
    // `--dry-run` holds `true`, and reading that as a string would be `undefined` at
    // best and `"true"` at worst.
    expect(valueOf(flags, 'dry-run')).toBeUndefined();
  });

  it('reports a set boolean', () => {
    expect(isSet(flags, 'dry-run')).toBe(true);
    expect(isSet(flags, 'to')).toBe(false);
  });

  it('defaults a missing boolean to false', () => {
    expect(isSet(new Map(), 'anything')).toBe(false);
  });
});