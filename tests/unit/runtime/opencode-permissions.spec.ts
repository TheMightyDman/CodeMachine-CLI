import { describe, expect, it } from 'vitest';

import { buildOpenCodePermissionUpdate } from '../../../src/runtime/permissions/opencode-policy.js';

describe('buildOpenCodePermissionUpdate', () => {
  it('adds allow entry for standard capability', () => {
    const update = buildOpenCodePermissionUpdate(
      {
        engine: 'opencode',
        capability: 'edit',
      },
      {
        OPENCODE_PERMISSION: '{"webfetch":"deny"}',
      },
    );

    expect(update).toBeTruthy();
    const policy = JSON.parse(update?.envDelta.OPENCODE_PERMISSION ?? '{}');
    expect(policy.edit).toBe('allow');
    expect(policy.webfetch).toBe('deny');
  });

  it('merges bash pattern rules', () => {
    const update = buildOpenCodePermissionUpdate(
      {
        engine: 'opencode',
        capability: 'bash',
        pattern: ['ls -la'],
      },
      {
        OPENCODE_PERMISSION: '{"bash":{"*":"deny"}}',
      },
    );

    expect(update).toBeTruthy();
    const policy = JSON.parse(update?.envDelta.OPENCODE_PERMISSION ?? '{}');
    expect(policy.bash['ls -la']).toBe('allow');
    expect(policy.bash['*']).toBe('deny');
  });
});
