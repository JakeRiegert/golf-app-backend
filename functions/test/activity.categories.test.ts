import { describe, expect, it } from 'vitest';

import { ACTIVITY_CATEGORIES, ACTIVITY_TYPES, CATEGORY_OF_TYPE } from '../src/activity';

// Pure checks, no emulator: every kind of event has a category, and only a known one, so a new
// event type cannot be added without deciding which group (and which mute switch) it belongs to.
describe('activity categories', () => {
  it('gives every event type a known category', () => {
    for (const type of ACTIVITY_TYPES) {
      expect(ACTIVITY_CATEGORIES, `category of ${type}`).toContain(CATEGORY_OF_TYPE[type]);
    }
  });

  it('has no entry for a type that does not exist', () => {
    expect(Object.keys(CATEGORY_OF_TYPE).sort()).toEqual([...ACTIVITY_TYPES].sort());
  });

  it('keeps the five groups the notification design names', () => {
    expect([...ACTIVITY_CATEGORIES]).toEqual(['essentials', 'changes', 'roster', 'scoring', 'moments']);
  });
});
