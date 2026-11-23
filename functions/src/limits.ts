// Named caps and allowed values, per the cost-control ladder (plan D9). Roster size is enforced
// by joinTournament. The spectator cap is reserved: it only becomes meaningful once spectating
// is a registered "follow" rather than open reading, so nothing enforces it yet.
// A friendly limit for now (a 100-team member-guest is 200+ players); like the team cap it is meant
// to become a billing tier post-MVP rather than a hard stop.
export const MAX_ROSTER_SIZE = 400;
export const MAX_SPECTATORS = 100;

export const MAX_DISPLAY_NAME_LENGTH = 50;
export const MAX_AVATAR_URL_LENGTH = 500;

export const TOURNAMENT_STATUS = { ACTIVE: 'active', SUSPENDED: 'suspended' } as const;
export type TournamentStatus = (typeof TOURNAMENT_STATUS)[keyof typeof TOURNAMENT_STATUS];

// 'friends' is deliberately absent until the friends feature is designed (plan D7).
export const VISIBILITY = { PRIVATE: 'private', PUBLIC: 'public' } as const;
export type Visibility = (typeof VISIBILITY)[keyof typeof VISIBILITY];

export const MAX_TOURNAMENT_NAME_LENGTH = 100;
// Real outings run 40 teams on one course and around 100 for a member-guest on two. This is a
// safety cap, not the product's final answer: post-MVP, very large tournaments are meant to be
// billed for (see the cost-control ladder, plan D9) rather than turned away. Team counts are
// logged on every team and join call (usage `teamCount`, `rosterSize`) so we can see real sizes.
export const MAX_TEAMS_PER_TOURNAMENT = 100;
export const MAX_TEAM_NAME_LENGTH = 50;

// Handicap index range accepted from an admin (WHS allows up to 54.0; plus handicaps are negative).
export const MIN_HANDICAP = -10;
export const MAX_HANDICAP = 54;

// Rounds (see docs/rounds-data-model.md). Safety caps, like the team and roster caps: they may become
// billing tiers later rather than hard stops.
export const MAX_ROUNDS_PER_TOURNAMENT = 30;
// A group holds at most this many players; the round's own maxGroupSize (default 4) sits under it.
export const MAX_GROUP_SIZE_CAP = 8;
export const DEFAULT_GROUP_SIZE = 4;
export const MAX_GROUPS_PER_ROUND = 100;
export const MAX_COURSE_NAME_LENGTH = 100;
export const MAX_TEES_LENGTH = 50;
// Tee sets on one course (tips, blue, white, gold, red...), and how many players one setRoundPlayers call may change.
export const MAX_TEE_SETS = 8;
export const MAX_ROUND_PLAYER_EDITS = 100;
export const MAX_ROUND_NAME_LENGTH = 40;
// The most strokes one hole can show, as a sanity bound for any score entry (a no-maximum format still needs
// room for a 14 or a 25; the round's own maximum, double par by default, is tighter). Also in firestore.rules.
export const MAX_STROKES = 30;
// Game formats a round may run. Stroke play (gross and net) is the first; others plug in later.
export const FORMAT_IDS = ['strokePlay'] as const;

// Largest team wager pot an admin can record (a sanity bound, not a payments limit).
export const MAX_WAGER_POT_AMOUNT = 100000;
