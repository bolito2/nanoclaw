/**
 * Integration test for the minecraft channel's single reach-in: the
 * self-registration import in the `src/channels/index.ts` barrel. Importing the
 * barrel runs minecraft.ts's top-level `registerChannelAdapter('minecraft', …)`;
 * without the import the channel is silently absent. Importing is safe: the
 * WebSocket server only starts in setup(), never at import.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('minecraft channel registration', () => {
  it('registers minecraft via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('minecraft');
  });
});
