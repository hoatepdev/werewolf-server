import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomInt, randomUUID } from 'crypto';
import { Room, Player, Role, PushTokenRecord } from '../types';

export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_PATTERN = /^\d{6}$/;

const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ROOM_CODE_RETRIES = 100; // Prevent infinite loop

export interface LeavePlayerResult {
  success: boolean;
  status:
    | 'removed'
    | 'left_active_game'
    | 'not_in_room'
    | 'room_not_found'
    | 'invalid_participant';
  player?: Player;
  activeGame?: boolean;
}

export interface UpdatePlayerInfoResult {
  success: boolean;
  player?: Player;
  status?: 'updated' | 'not_in_room' | 'room_not_found' | 'invalid_participant';
}

@Injectable()
export class RoomService implements OnModuleDestroy {
  private rooms = new Map<string, Room>();
  private reconnectTokens = new Map<string, string>();
  private gmReconnectTokens = new Map<string, string>();
  private readonly logger = new Logger(RoomService.name);
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(
      () => this.cleanupStaleRooms(),
      CLEANUP_INTERVAL_MS,
    );
    this.cleanupTimer.unref?.();
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
        for (const key of this.reconnectTokens.keys()) {
          if (key.startsWith(`${code}:`)) this.reconnectTokens.delete(key);
        }
        for (const key of this.gmReconnectTokens.keys()) {
          if (key.startsWith(`${code}:`)) this.gmReconnectTokens.delete(key);
        }
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

  reconnectGm(
    roomCode: string,
    newSocketId: string,
    gmPersistentId?: string,
  ): Player | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;
    if (gmPersistentId && room.gmPersistentId !== gmPersistentId) return null;

    const gm = room.players.find((p) => p.status === 'gm');
    if (!gm) return null;
    if (gmPersistentId && gm.persistentId !== gmPersistentId) return null;

    gm.id = newSocketId;
    room.hostId = newSocketId;
    room.disconnectedGmId = undefined;
    this.touchRoom(roomCode);
    return gm;
  }

  setGmRoomId(roomCode: string, gmRoomId: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    room.gmRoomId = gmRoomId;
    this.touchRoom(roomCode);
  }

  getGmRoomId(roomCode: string): string | undefined {
    return this.rooms.get(roomCode)?.gmRoomId;
  }

  markGameStarted(roomCode: string): boolean {
    const room = this.rooms.get(roomCode);
    if (!room || room.gameStarted) return false;
    room.gameStarted = true;
    this.touchRoom(roomCode);
    return true;
  }

  isGameStarted(roomCode: string): boolean {
    return this.rooms.get(roomCode)?.gameStarted === true;
  }

  static isValidRoomCode(roomCode: unknown): roomCode is string {
    return typeof roomCode === 'string' && ROOM_CODE_PATTERN.test(roomCode);
  }

  private static generateRoomCode(length = ROOM_CODE_LENGTH): string {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += randomInt(0, 10).toString();
    }
    return code;
  }

  createRoom(
    id: string,
    avatarKey: number,
    username: string,
    roomCodeParam?: string,
    gmPersistentId?: string,
  ): Room {
    let roomCode: string;
    let retries = 0;
    do {
      roomCode = roomCodeParam || RoomService.generateRoomCode();
      retries++;
      if (retries > MAX_ROOM_CODE_RETRIES) {
        throw new Error('Unable to generate unique room code');
      }
    } while (this.rooms.has(roomCode));
    const gm: Player = {
      id,
      persistentId: gmPersistentId,
      avatarKey,
      username,
      status: 'gm',
    };
    const room: Room = {
      roomCode,
      hostId: id,
      players: [gm],
      gmPersistentId,
      phase: 'night',
      round: 0,
      actions: [],
      lastActivityAt: Date.now(),
    };
    this.rooms.set(roomCode, room);
    return room;
  }

  getRoom(roomCode: string): Room | undefined {
    return this.rooms.get(roomCode);
  }

  private reconnectKey(roomCode: string, persistentId: string): string {
    return `${roomCode}:${persistentId}`;
  }

  issueReconnectToken(roomCode: string, persistentId: string): string {
    const token = randomUUID();
    this.reconnectTokens.set(this.reconnectKey(roomCode, persistentId), token);
    return token;
  }

  validateReconnectToken(
    roomCode: string,
    persistentId: string,
    token: string,
  ): boolean {
    return (
      this.reconnectTokens.get(this.reconnectKey(roomCode, persistentId)) ===
      token
    );
  }

  revokeReconnectToken(roomCode: string, persistentId?: string): void {
    if (!persistentId) return;
    this.reconnectTokens.delete(this.reconnectKey(roomCode, persistentId));
  }

  private gmReconnectKey(roomCode: string, gmPersistentId: string): string {
    return `${roomCode}:${gmPersistentId}`;
  }

  issueGmReconnectToken(roomCode: string, gmPersistentId: string): string {
    const token = randomUUID();
    this.gmReconnectTokens.set(
      this.gmReconnectKey(roomCode, gmPersistentId),
      token,
    );
    return token;
  }

  validateGmReconnectToken(
    roomCode: string,
    gmPersistentId: string,
    token: string,
  ): boolean {
    return (
      this.gmReconnectTokens.get(
        this.gmReconnectKey(roomCode, gmPersistentId),
      ) === token
    );
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
    if (!room) {
      this.logger.warn(`ApprovePlayer: Room ${roomCode} not found`);
      return false;
    }
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.status !== 'pending') {
      this.logger.warn(
        `ApprovePlayer: Invalid player ${playerId} in room ${roomCode}`,
      );
      return false;
    }
    player.status = 'approved';
    player.ready = false;
    this.logger.log(`Player ${player.username} approved in room ${roomCode}`);

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

  registerPushToken(
    roomCode: string,
    participantId: string,
    record: Omit<PushTokenRecord, 'enabledAt' | 'lastSeenAt'>,
  ): 'registered' | 'updated' | 'not_found' {
    const room = this.rooms.get(roomCode);
    if (!room) return 'not_found';

    const player = room.players.find(
      (p) => p.id === participantId || p.persistentId === participantId,
    );
    if (!player || player.status === 'rejected') return 'not_found';
    if (record.participantKind === 'gm' && player.status !== 'gm') {
      return 'not_found';
    }
    if (record.participantKind === 'player' && player.status === 'gm') {
      return 'not_found';
    }

    const now = Date.now();
    player.pushTokens ??= [];
    const existing = player.pushTokens.find(
      (entry) => entry.deviceId === record.deviceId || entry.token === record.token,
    );
    if (existing) {
      Object.assign(existing, record, {
        enabledAt: existing.enabledAt,
        lastSeenAt: now,
      });
      this.touchRoom(roomCode);
      return 'updated';
    }

    player.pushTokens.push({ ...record, enabledAt: now, lastSeenAt: now });
    this.touchRoom(roomCode);
    return 'registered';
  }

  unregisterPushToken(
    roomCode: string,
    participantId: string,
    token?: string,
    deviceId?: string,
  ): 'removed' | 'not_found' {
    const room = this.rooms.get(roomCode);
    if (!room) return 'not_found';
    const player = room.players.find(
      (p) => p.id === participantId || p.persistentId === participantId,
    );
    if (!player?.pushTokens) return 'not_found';

    const before = player.pushTokens.length;
    player.pushTokens = player.pushTokens.filter((entry) => {
      if (token && entry.token === token) return false;
      if (deviceId && entry.deviceId === deviceId) return false;
      return true;
    });
    if (before === player.pushTokens.length) return 'not_found';
    this.touchRoom(roomCode);
    return 'removed';
  }

  getPushTokensForPlayers(roomCode: string, playerIds: string[]): string[] {
    const room = this.rooms.get(roomCode);
    if (!room) return [];
    const targetIds = new Set(playerIds);
    return room.players
      .filter((player) => targetIds.has(player.id))
      .flatMap((player) => player.pushTokens?.map((entry) => entry.token) ?? []);
  }

  getPushTokensForPlayer(
    roomCode: string,
    playerIdOrPersistentId: string,
  ): string[] {
    const room = this.rooms.get(roomCode);
    if (!room) return [];
    const player = room.players.find(
      (p) => p.id === playerIdOrPersistentId || p.persistentId === playerIdOrPersistentId,
    );
    if (!player || player.status === 'gm') return [];
    return player.pushTokens?.map((entry) => entry.token) ?? [];
  }

  getPushTokensForRoomPlayers(
    roomCode: string,
    options: { approvedOnly?: boolean; aliveOnly?: boolean } = {},
  ): string[] {
    const room = this.rooms.get(roomCode);
    if (!room) return [];
    return room.players
      .filter((player) => {
        if (player.status === 'gm') return false;
        if (options.approvedOnly && player.status !== 'approved') return false;
        if (options.aliveOnly && player.alive === false) return false;
        return player.status !== 'rejected';
      })
      .flatMap((player) => player.pushTokens?.map((entry) => entry.token) ?? []);
  }

  getGmPushTokens(roomCode: string): string[] {
    const room = this.rooms.get(roomCode);
    if (!room) return [];
    const gm = room.players.find((player) => player.status === 'gm');
    return gm?.pushTokens?.map((entry) => entry.token) ?? [];
  }

  removeInvalidPushTokens(roomCode: string, tokens: string[]): void {
    const room = this.rooms.get(roomCode);
    if (!room || tokens.length === 0) return;
    const invalid = new Set(tokens);
    room.players.forEach((player) => {
      player.pushTokens = player.pushTokens?.filter(
        (entry) => !invalid.has(entry.token),
      );
    });
    this.touchRoom(roomCode);
  }

  leavePlayer(roomCode: string, socketId: string): LeavePlayerResult {
    const room = this.rooms.get(roomCode);
    if (!room) return { success: false, status: 'room_not_found' };

    if (room.hostId === socketId) {
      return { success: false, status: 'invalid_participant' };
    }

    const playerIndex = room.players.findIndex((p) => p.id === socketId);
    if (playerIndex === -1) {
      return { success: false, status: 'not_in_room' };
    }

    const player = room.players[playerIndex];
    if (player.status === 'gm') {
      return { success: false, status: 'invalid_participant' };
    }

    this.revokeReconnectToken(roomCode, player.persistentId);
    player.pushTokens = [];

    if (room.gameStarted && player.status === 'approved') {
      player.alive = false;
      room.actions.push({
        type: 'player_left',
        playerId: player.id,
        timestamp: Date.now(),
      });
      this.touchRoom(roomCode);
      return {
        success: true,
        status: 'left_active_game',
        player,
        activeGame: true,
      };
    }

    const [removedPlayer] = room.players.splice(playerIndex, 1);
    this.touchRoom(roomCode);
    return {
      success: true,
      status: 'removed',
      player: removedPlayer,
      activeGame: false,
    };
  }

  updatePlayerInfo(
    roomCode: string,
    socketId: string,
    username: string,
    avatarKey: number,
  ): UpdatePlayerInfoResult {
    const room = this.rooms.get(roomCode);
    if (!room) return { success: false, status: 'room_not_found' };

    const player = room.players.find((p) => p.id === socketId);
    if (!player || player.status === 'rejected') {
      return { success: false, status: 'not_in_room' };
    }

    player.username = username;
    player.avatarKey = avatarKey;
    this.touchRoom(roomCode);
    return { success: true, status: 'updated', player };
  }

  resetRoom(roomCode: string): Room | undefined {
    const room = this.rooms.get(roomCode);
    if (!room) return undefined;

    room.gameStarted = false;
    room.phase = 'night';
    room.round = 0;
    room.actions = [];
    room.players = room.players
      .filter((player) => player.status === 'gm' || player.status === 'approved')
      .map((player) => {
        if (player.status === 'gm') {
          return player;
        }
        const resetPlayer: Player = {
          ...player,
          ready: false,
          alive: undefined,
          role: undefined,
        };
        return resetPlayer;
      });
    this.touchRoom(roomCode);
    return room;
  }

  eliminatePlayer(
    roomCode: string,
    playerId: string,
    reason: string = 'GM elimination',
  ): boolean {
    const room = this.rooms.get(roomCode);
    if (!room) {
      this.logger.warn(`EliminatePlayer: Room ${roomCode} not found`);
      return false;
    }

    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.status !== 'approved') {
      this.logger.warn(
        `EliminatePlayer: Invalid player ${playerId} in room ${roomCode}`,
      );
      return false;
    }

    player.alive = false;
    this.logger.log(
      `Player ${player.username} eliminated in room ${roomCode}: ${reason}`,
    );

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
    if (!room) {
      this.logger.warn(`RandomizeRoles: Room ${roomCode} not found`);
      return false;
    }
    const approvedPlayers = room.players.filter((p) => p.status === 'approved');
    if (roles.length !== approvedPlayers.length) {
      this.logger.warn(
        `RandomizeRoles: Role count mismatch. ${roles.length} roles for ${approvedPlayers.length} players`,
      );
      return false;
    }
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
      player.ready = false;
      player.alive = undefined;
    });
    room.phase = 'night';
    room.round = 1;
    this.touchRoom(roomCode);
    this.logger.log(`Roles randomized in room ${roomCode}`);
    return true;
  }

  playerReady(roomCode: string, playerId: string): boolean {
    const room = this.rooms.get(roomCode);
    if (!room || room.gameStarted) return false;
    const player = room.players.find((p) => p.id === playerId);
    if (!player || player.status !== 'approved' || !player.role) return false;

    player.ready = true;
    player.alive = true;
    return room.players
      .filter((p) => p.status === 'approved')
      .every((p) => p.ready === true);
  }
}
