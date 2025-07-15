import { Injectable } from '@nestjs/common';
import { Room, Player, Role } from '../types';

@Injectable()
export class RoomService {
  private rooms = new Map<string, Room>();

  private static generateRoomCode(length = 12): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  createRoom(id: string, avatarKey: number, username: string): Room {
    let roomCode: string;
    do {
      roomCode = RoomService.generateRoomCode();
    } while (this.rooms.has(roomCode));
    const gm: Player = {
      id,
      avatarKey,
      username,
      status: 'gm',
    };
    const room: Room = {
      roomCode,
      hostId: id,
      players: [gm],
      phase: 'night',
      round: 0,
      actions: [],
    };
    this.rooms.set(roomCode, room);
    return room;
  }

  createGmRoom(roomCode: string, gmId: string): Partial<Room> {
    const room: Partial<Room> = {
      roomCode,
      hostId: gmId,
      players: [],
      phase: 'night',
      round: 0,
      actions: [],
    };
    this.rooms.set(roomCode, room as Room);
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

  getPlayers(roomCode: string): Player[] {
    const room = this.rooms.get(roomCode);
    return room ? room.players : [];
  }

  randomizeRoles(roomCode: string, roles: Role[]): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;
    const approvedPlayers = room.players.filter((p) => p.status === 'approved');
    if (roles.length !== approvedPlayers.length) return false;
    // Shuffle roles for randomness
    const shuffledRoles = [...roles];
    for (let i = shuffledRoles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledRoles[i], shuffledRoles[j]] = [
        shuffledRoles[j],
        shuffledRoles[i],
      ];
    }
    approvedPlayers.forEach((player, idx) => {
      player.role = shuffledRoles[idx];
    });
    room.phase = 'night';
    room.round = 1;
    return true;
  }

  playerReady(roomCode: string, playerId: string): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.status !== 'approved') return false;

    const flag = room.players
      .filter((p) => p.status === 'approved')
      .every((p) => p.alive === true || p.id === playerId);
    player.alive = true;
    return flag;
  }
}
