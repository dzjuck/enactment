import { existsSync, readdirSync } from 'node:fs';

describe('baseline verifier', () => {
  it('is offline and has no provider auth', () => {
    expect(readdirSync('/sys/class/net').sort()).toEqual(['lo']);
    expect(existsSync('/run/agent-auth')).toBe(false);
    expect(Object.keys(process.env).some((key) => /codex|openai|api_key/i.test(key))).toBe(false);
  });
});
