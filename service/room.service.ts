import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Room, Player, Role } from '../types';

const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class RoomService implements OnModuleDestroy {
  private rooms = new Map<string, Room>();
  private readonly logger = new Logger(RoomService.name);
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(
      () => this.cleanupStaleRooms(),
      CLEANUP_INTERVAL_MS,
    );
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  private onRoomCleanup?: (roomCode: string) => void;

  /** Register a callback to be invoked whenever a room is removed. */
  setOnRoomCleanup(cb: (roomCode: string) => void): void {
    this.onRoomCleanup = cb;
  }

  private cleanupStaleRooms(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivityAt > ROOM_TTL_MS) {
        this.rooms.delete(code);
        this.onRoomCleanup?.(code);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.log(
        `Cleaned up ${cleaned} stale room(s). Active: ${this.rooms.size}`,
      );
    }
  }

  private touchRoom(roomCode: string): void {
    const room = this.rooms.get(roomCode);
    if (room) {
      room.lastActivityAt = Date.now();
    }
  }

  findRoomBySocketId(socketId: string): string | undefined {
    for (const [code, room] of this.rooms) {
      if (
        room.hostId === socketId ||
        room.players.some((p) => p.id === socketId)
      ) {
        return code;
      }
    }
    return undefined;
  }

  setGmDisconnected(roomCode: string, gmSocketId: string): void {
    const room = this.rooms.get(roomCode);
    if (room) {
      room.disconnectedGmId = gmSocketId;
    }
  }

  isGmReconnection(roomCode: string, newSocketId: string): boolean {
    const room = this.rooms.get(roomCode);
    return !!room?.disconnectedGmId && room.hostId !== newSocketId;
  }

  reconnectGm(roomCode: string, newSocketId: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    room.hostId = newSocketId;
    room.disconnectedGmId = undefined;
    this.touchRoom(roomCode);
  }

  private static generateRoomCode(length = 12): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  createRoom(
    id: string,
    avatarKey: number,
    username: string,
    roomCodeParam?: string,
  ): Room {
    let roomCode: string;
    do {
      roomCode = roomCodeParam || RoomService.generateRoomCode();
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
      lastActivityAt: Date.now(),
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
      lastActivityAt: Date.now(),
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
    // If a player with the same persistentId already exists, block a duplicate join
    if (player.persistentId) {
      const existing = room.players.find(
        (p) => p.persistentId === player.persistentId,
      );
      if (existing) return false;
    } else if (room.players.find((p) => p.id === player.id)) {
      return false;
    }
    player.status = 'pending';
    room.players.push(player);
    this.touchRoom(roomCode);
    return true;
  }

  /** Replace a disconnected player's socket ID with the new one. Returns the updated player or null. */
  rejoinPlayer(
    roomCode: string,
    newSocketId: string,
    persistentId: string,
  ): Player | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const player = room.players.find((p) => p.persistentId === persistentId);
    if (!player || player.status === 'rejected') return null;

    player.id = newSocketId;
    this.touchRoom(roomCode);
    return player;
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

  eliminatePlayer(
    roomCode: string,
    playerId: string,
    reason: string = 'GM elimination',
  ): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;

    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.status !== 'approved') return false;

    player.alive = false;

    room.actions.push({
      type: 'gm_elimination',
      playerId,
      reason,
      timestamp: Date.now(),
    });

    return true;
  }

  revivePlayer(roomCode: string, playerId: string): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;

    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.status !== 'approved') return false;

    player.alive = true;

    room.actions.push({
      type: 'gm_revival',
      playerId,
      timestamp: Date.now(),
    });

    return true;
  }

  randomizeRoles(roomCode: string, roles: Role[]): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) return false;
    const approvedPlayers = room.players.filter((p) => p.status === 'approved');
    if (roles.length !== approvedPlayers.length) return false;
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
    this.touchRoom(roomCode);
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
