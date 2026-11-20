import { describe, expect, it } from 'vitest';
import { toCsv } from '../csv';

describe('toCsv', () => {
  it('writes header + rows and escapes commas and quotes', () => {
    const csv = toCsv(
      [
        { model: 'tokens/gpt-6-luna', tokens: 1200 },
        { model: 'a,"b"', tokens: 3 },
      ],
      [
        { key: 'model', header: 'Model' },
        { key: 'tokens', header: 'Tokens' },
      ],
    );
    expect(csv).toBe('Model,Tokens\ntokens/gpt-6-luna,1200\n"a,""b""",3');
  });
  it('returns only the header for no rows', () => {
    expect(toCsv([], [{ key: 'model', header: 'Model' }])).toBe('Model');
  });
});
