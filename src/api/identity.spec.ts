import { resolvePrincipals } from './identity';

describe('resolvePrincipals', () => {
  it('parses a comma-separated header, trimming blanks', () => {
    expect(resolvePrincipals('hr, engineering ,public')).toEqual(['hr', 'engineering', 'public']);
  });

  it('returns no principals when the header is absent or empty (fail-closed → public-only downstream)', () => {
    expect(resolvePrincipals(undefined)).toEqual([]);
    expect(resolvePrincipals('')).toEqual([]);
    expect(resolvePrincipals('  ,  ')).toEqual([]);
  });
});
