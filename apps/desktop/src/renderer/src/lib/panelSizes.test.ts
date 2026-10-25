import { describe, expect, it } from 'vitest';
import { clamp, SIZE_LIMITS } from './panelSizes';

describe('panel sizes', () => {
  it('clamps to the limits and rounds', () => {
    expect(clamp(50, SIZE_LIMITS.chatW.min, SIZE_LIMITS.chatW.max)).toBe(300);
    expect(clamp(5000, SIZE_LIMITS.chatW.min, SIZE_LIMITS.chatW.max)).toBe(900);
    expect(clamp(412.6, SIZE_LIMITS.chatW.min, SIZE_LIMITS.chatW.max)).toBe(413);
  });
});
