import { Injectable } from '@nestjs/common';
import { Room, Player, Role, Phase } from '../types';

function generateRoomCode(length = 12): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

@Injectable()
export class RoomService {
  private rooms = new Map<string, Room>();

  createRoom(gmId: string, gmName: string): Room {
    let roomCode: string;
    do {
      roomCode = generateRoomCode();
    } while (this.rooms.has(roomCode));
    const gm: Player = {
      id: gmId,
      name: gmName,
      status: 'approved',
      alive: true,
    };
    const room: Room = {
      roomCode,
      hostId: gmId,
      players: [gm],
      phase: 'waiting',
      round: 0,
      actions: [],
    };
    this.rooms.set(roomCode, room);
    return room;
  }

  getRoom(roomCode: string): Room | undefined {
    return this.rooms.get(roomCode);
  }

  addPlayer(roomCode: string, player: Player): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;
    if (room.players.find((p) => p.id === player.id)) return false;
    player.status = 'pending';
    room.players.push(player);
    return true;
  }

  approvePlayer(roomCode: string, playerId: string): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.status !== 'pending') return false;
    player.status = 'approved';
    return true;
  }

  rejectPlayer(roomCode: string, playerId: string): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.status !== 'pending') return false;
    player.status = 'rejected';
    return true;
  }

  startGame(roomCode: string): boolean {
    const room = this.rooms.get(roomCode);
    console.log('⭐ startGame - room', room);

    if (!room) return false;
    if (room.phase !== 'waiting') return false;
    // Only approved players participate
    const approvedPlayers = room.players.filter((p) => p.status === 'approved');
    // TODO: Un-comment below line
    // if (approvedPlayers.length < 3) return false;
    const roles = this.assignRoles(approvedPlayers.length);
    approvedPlayers.forEach((player, idx) => {
      player.role = roles[idx];
      player.alive = true;
    });
    room.phase = 'night';
    room.round = 1;
    return true;
  }

  nextPhase(roomCode: string): Phase | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;
    const phaseOrder: Phase[] = ['waiting', 'night', 'day', 'voting', 'ended'];
    const idx = phaseOrder.indexOf(room.phase);
    if (idx === -1 || idx === phaseOrder.length - 1) return null;
    room.phase = phaseOrder[idx + 1];
    return room.phase;
  }

  private assignRoles(playerCount: number): Role[] {
    // Example: 7 players: 2 werewolf, 1 seer, 1 witch, 1 hunter, 1 guardian, 1 clown
    const roles: Role[] = [];
    if (playerCount >= 7) {
      roles.push(
        'werewolf',
        'werewolf',
        'seer',
        'witch',
        'hunter',
        'guardian',
        'clown',
      );
      for (let i = 7; i < playerCount; i++) roles.push('villager');
    } else {
      // Fallback: 1 werewolf, rest villagers
      roles.push('werewolf');
      for (let i = 1; i < playerCount; i++) roles.push('villager');
    }
    // Shuffle roles
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    return roles;
  }

  getPendingPlayers(roomCode: string): Player[] {
    const room = this.rooms.get(roomCode);
    if (!room) return [];
    return room.players.filter((p) => p.status === 'pending');
  }

  getPlayers(roomCode: string): Player[] {
    const room = this.rooms.get(roomCode);
    if (!room) return [];
    return room.players;
  }
}
