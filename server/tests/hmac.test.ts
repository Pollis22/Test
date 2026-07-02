import { describe, it, expect } from 'vitest';
import { signToolPayload } from '../src/routes/tools.js';

describe('voice tool HMAC', () => {
  it('signature is deterministic per body+secret', () => {
    const body = JSON.stringify({ shop_slug: 'demo-cuts', phone: '+15551234567' });
    const a = signToolPayload(body, 'secret-1');
    expect(a).toBe(signToolPayload(body, 'secret-1'));
    expect(a).not.toBe(signToolPayload(body, 'secret-2'));
    expect(a).not.toBe(signToolPayload(body + ' ', 'secret-1'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
