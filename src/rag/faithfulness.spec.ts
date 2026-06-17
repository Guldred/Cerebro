import { verifyCitations } from './faithfulness';

describe('verifyCitations', () => {
  it('keeps grounded markers and reports none hallucinated', () => {
    const r = verifyCitations('Re-run the last good job [1] and notify the team [2].', 2);
    expect(r.grounded).toEqual([1, 2]);
    expect(r.hallucinated).toEqual([]);
    expect(r.cleanedAnswer).toBe('Re-run the last good job [1] and notify the team [2].');
  });

  it('flags + strips a fabricated marker (out of evidence range)', () => {
    const r = verifyCitations('The cap is 10 [1], per the appendix [9].', 2);
    expect(r.grounded).toEqual([1]);
    expect(r.hallucinated).toEqual([9]);
    // [9] removed, including the space before it, punctuation tidied
    expect(r.cleanedAnswer).toBe('The cap is 10 [1], per the appendix.');
  });

  it('all markers fabricated → none grounded (answer will abstain upstream)', () => {
    const r = verifyCitations('See [5] and [6].', 2);
    expect(r.grounded).toEqual([]);
    expect(r.hallucinated).toEqual([5, 6]);
    expect(r.cleanedAnswer).toBe('See and.');
  });

  it('an uncited answer is vacuously grounded', () => {
    const r = verifyCitations('No citations here.', 3);
    expect(r.grounded).toEqual([]);
    expect(r.hallucinated).toEqual([]);
  });
});
