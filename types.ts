export type Role =
  | 'villager'
  | 'werewolf'
  | 'seer'
  | 'witch'
  | 'hunter'
  | 'bodyguard'
  | 'tanner'
  | 'cupid';

export type Phase = 'night' | 'day' | 'voting' | 'conclude' | 'ended';

export type PlayerStatus = 'pending' | 'approved' | 'rejected' | 'gm';

export interface PushTokenRecord {
  token: string;
  deviceId: string;
  participantKind: 'player' | 'gm';
  persistentId?: string;
  socketId?: string;
  userAgent?: string;
  platform?: string;
  enabledAt: number;
  lastSeenAt: number;
}

export interface Player {
  id: string;
  persistentId?: string;
  avatarKey: number;
  username: string;
  status: PlayerStatus;
  ready?: boolean;
  alive?: boolean;
  role?: Role;
  pushTokens?: PushTokenRecord[];
}

export type PublicPlayer = Omit<Player, 'persistentId' | 'role' | 'pushTokens'>;

export type PlayerSelfView = PublicPlayer & {
  role?: Role;
};

export interface Room {
  roomCode: string;
  hostId: string;
  players: Player[];
  phase: Phase;
  round: number;
  actions: any[];
  gmRoomId?: string;
  gmPersistentId?: string;
  gameStarted?: boolean;
  disconnectedGmId?: string;
  lastActivityAt: number;
}
