export type Role =
  | 'villager'
  | 'werewolf'
  | 'seer'
  | 'witch'
  | 'hunter'
  | 'bodyguard';

export type Phase = 'night' | 'day' | 'voting' | 'conclude' | 'ended';

export type PlayerStatus = 'pending' | 'approved' | 'rejected' | 'gm';

export interface Player {
  id: string;
  avatarKey: number;
  username: string;
  status: PlayerStatus;
  alive?: boolean;
  role?: Role;
}

export interface Room {
  roomCode: string;
  hostId: string;
  players: Player[];
  phase: Phase;
  round: number;
  actions: any[];
}
