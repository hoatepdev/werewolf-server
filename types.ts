export type Role =
  | 'villager'
  | 'werewolf'
  | 'seer'
  | 'witch'
  | 'hunter'
  | 'guardian'
  | 'clown';

export type Phase = 'waiting' | 'night' | 'day' | 'voting' | 'ended';

export type PlayerStatus = 'pending' | 'approved' | 'rejected';

export interface Player {
  id: string;
  name: string;
  status: PlayerStatus;
  alive: boolean;
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
