// Named caps and allowed values, per the cost-control ladder (plan D9). Roster size is enforced
// by joinTournament. The spectator cap is reserved: it only becomes meaningful once spectating
// is a registered "follow" rather than open reading, so nothing enforces it yet.
export const MAX_ROSTER_SIZE = 100;
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

// Largest team wager pot an admin can record (a sanity bound, not a payments limit).
export const MAX_WAGER_POT_AMOUNT = 100000;
