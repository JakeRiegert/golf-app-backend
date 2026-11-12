import { describe, expect, it } from 'vitest';

import { ACTIVITY_CATEGORIES, ACTIVITY_DESCRIPTIONS, ACTIVITY_TYPES, CATEGORY_OF_TYPE } from '../src/activity';

// Documentation drift check: every kind of event has a plain-language description, so a new event cannot
// ship showing players a raw type name (see the player and organizer guide, "Documentation plan").
describe('activity descriptions', () => {
  it('describes every event type in a short sentence, and nothing else', () => {
    for (const type of ACTIVITY_TYPES) {
      const text = ACTIVITY_DESCRIPTIONS[type];
      expect(text, `description of ${type}`).toBeTruthy();
      expect(text.length, `length of ${type}'s description`).toBeLessThanOrEqual(140);
      expect(text.endsWith('.'), `${type}'s description ends with a full stop`).toBe(true);
      expect(text, `${type}'s description is not just its name`).not.toContain('_');
    }
    expect(Object.keys(ACTIVITY_DESCRIPTIONS).sort()).toEqual([...ACTIVITY_TYPES].sort());
  });
});

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
