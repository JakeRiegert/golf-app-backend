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
