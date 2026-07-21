import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomService } from '../service/room.service';
import { Player, PlayerSelfView, PublicPlayer, Role, Room } from '../types';
import { Injectable, Logger } from '@nestjs/common';
import { PhaseManager } from '../service/phase-manager.service';
import type { VotingSubmissionAck } from '../service/phase-manager.service';
import { TimerInfo, VotingChoice } from '../service/game-engine';
import 'dotenv/config';

@WebSocketGateway({
  transports: ['websocket'],
  cors: {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
      : '*',
    credentials: false,
  },
})
@Injectable()
export class GameGateway implements OnGatewayInit, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(GameGateway.name);

  constructor(
    private readonly roomService: RoomService,
    private readonly phaseManager: PhaseManager,
  ) {}

  afterInit() {
    this.phaseManager.setServer(this.server);
    this.roomService.setOnRoomCleanup((roomCode) => {
      this.phaseManager.cleanupRoom(roomCode);
    });
  }

  handleDisconnect(socket: Socket) {
    const roomCode = this.roomService.findRoomBySocketId(socket.id);
    if (!roomCode) return;

    const room = this.roomService.getRoom(roomCode);
    if (!room) return;

    // GM disconnected — store gmSocketId for reconnection
    if (room.hostId === socket.id) {
      this.logger.warn(`GM disconnected from room ${roomCode}`);
      this.roomService.setGmDisconnected(roomCode, socket.id);
    }

    // Notify the rest of the room which player disconnected
    const disconnectedPlayer = room.players.find((p) => p.id === socket.id);
    if (disconnectedPlayer) {
      this.server.to(roomCode).emit('room:playerDisconnected', {
        playerId: socket.id,
        username: disconnectedPlayer.username,
      });
    }
  }

  private isHost(socket: Socket, roomCode: string) {
    const room = this.roomService.getRoom(roomCode);
    return room && room.hostId === socket.id;
  }

  private serializePublicPlayer(player: Player): PublicPlayer {
    const {
      persistentId: _persistentId,
      role: _role,
      pushTokens: _pushTokens,
      ...publicPlayer
    } = player;
    return publicPlayer;
  }

  private serializePlayerForSocket(
    player: Player,
    socketId: string,
  ): PlayerSelfView {
    const publicPlayer = this.serializePublicPlayer(player);
    if (player.id !== socketId || !player.role) return publicPlayer;
    return { ...publicPlayer, role: player.role };
  }

  private serializePlayersForSocket(
    players: Player[],
    socketId: string,
  ): PlayerSelfView[] {
    return players.map((player) =>
      this.serializePlayerForSocket(player, socketId),
    );
  }

  private serializeRoomForSocket(room: Room, socketId: string) {
    return {
      roomCode: room.roomCode,
      phase: room.phase,
      round: room.round,
      gameStarted: room.gameStarted,
      players: this.serializePlayersForSocket(room.players, socketId),
    };
  }

  private getRoomParticipantKind(
    socket: Socket,
    roomCode: string,
  ): 'gm' | 'player' | null {
    const room = this.roomService.getRoom(roomCode);
    if (!room) return null;
    if (room.hostId === socket.id) return 'gm';

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.status === 'rejected') return null;

    return 'player';
  }

  private emitRoomPlayers(roomCode: string) {
    const room = this.roomService.getRoom(roomCode);
    if (!room) return;

    this.server.to(roomCode).emit(
      'room:updatePlayers',
      room.players.map((player) => this.serializePublicPlayer(player)),
    );
    this.server.to(room.hostId).emit('room:updatePlayers', room.players);
    if (room.gmRoomId) {
      this.server.to(room.gmRoomId).emit('room:updatePlayers', room.players);
    }
  }

  private validateString(value: unknown, maxLength = 100): value is string {
    return (
      typeof value === 'string' && value.length > 0 && value.length <= maxLength
    );
  }

  private validateRoomCode(data: {
    roomCode?: unknown;
  }): data is { roomCode: string } {
    return this.validateString(data?.roomCode, 20);
  }

  @SubscribeMessage('rq_gm:createRoom')
  async handleCreateRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      avatarKey: number;
      username: string;
      gmPersistentId?: string;
      roomCode?: string;
    },
  ) {
    if (
      !this.validateString(data?.username, 30) ||
      (data.gmPersistentId !== undefined &&
        !this.validateString(data.gmPersistentId, 64)) ||
      typeof data?.avatarKey !== 'number'
    ) {
      return { success: false, message: 'Invalid data.' };
    }
    if (
      data.roomCode !== undefined &&
      !this.validateString(data.roomCode, 20)
    ) {
      return { success: false, message: 'Invalid room code.' };
    }

    const room = this.roomService.createRoom(
      socket.id,
      data.avatarKey,
      data.username,
      data.roomCode,
      data.gmPersistentId,
    );
    let gmReconnectToken: string | undefined;
    if (data.gmPersistentId) {
      gmReconnectToken = this.roomService.issueGmReconnectToken(
        room.roomCode,
        data.gmPersistentId,
      );
    }
    this.logger.log(`Room created: ${room.roomCode}`);
    await socket.join(room.roomCode);
    this.emitRoomPlayers(room.roomCode);
    return { ...room, gmReconnectToken };
  }

  @SubscribeMessage('rq_gm:connectGmRoom')
  async handleConnectGmRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      gmRoomId: string;
      gmPersistentId?: string;
      gmReconnectToken?: string;
    },
  ) {
    if (
      !this.validateRoomCode(data) ||
      !this.validateString(data?.gmRoomId, 50)
    )
      return;

    const room = this.roomService.getRoom(data.roomCode);
    if (!room) return;

    let authorized = room.hostId === socket.id;
    if (!authorized) {
      if (
        !this.validateString(data?.gmPersistentId, 64) ||
        !this.validateString(data?.gmReconnectToken, 100) ||
        room.gmPersistentId !== data.gmPersistentId
      ) {
        socket.emit('gm:connectRoomError', { message: 'Not authorized.' });
        return;
      }

      const gmPersistentId = data.gmPersistentId;
      const gmReconnectToken = data.gmReconnectToken;
      const validToken = this.roomService.validateGmReconnectToken(
        data.roomCode,
        gmPersistentId,
        gmReconnectToken,
      );
      const reconnected = validToken
        ? this.roomService.reconnectGm(data.roomCode, socket.id, gmPersistentId)
        : null;
      if (!reconnected) {
        socket.emit('gm:connectRoomError', { message: 'Not authorized.' });
        return;
      }

      authorized = true;
      this.logger.log(`GM reconnected to room ${data.roomCode}`);
    }

    if (!authorized) return;

    await socket.join(data.roomCode);
    await socket.join(data.gmRoomId);
    this.roomService.setGmRoomId(data.roomCode, data.gmRoomId);
    this.phaseManager.setGmRoom(data.roomCode, data.gmRoomId);

    const updatedRoom = this.roomService.getRoom(data.roomCode) ?? room;
    socket.emit('gm:connected', {
      roomCode: data.roomCode,
      gmRoomId: data.gmRoomId,
      message: 'GM connected successfully',
    });
    socket.emit('room:updatePlayers', updatedRoom.players);
    socket.emit('game:phaseChanged', {
      phase: this.phaseManager.getPhase(data.roomCode) ?? updatedRoom.phase,
    });

    const timerInfo = this.phaseManager.getTimerInfo(data.roomCode);
    if (timerInfo) {
      socket.emit('game:timerSync', timerInfo);
    }

    const snapshot = this.phaseManager.getGmStateSnapshot?.(data.roomCode);
    if (snapshot) {
      socket.emit('gm:stateSnapshot', snapshot);
    }
  }

  @SubscribeMessage('rq_player:joinRoom')
  async handleJoinRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      avatarKey: number;
      username: string;
      persistentPlayerId?: string;
    },
  ) {
    if (
      !this.validateRoomCode(data) ||
      !this.validateString(data?.username, 30) ||
      typeof data?.avatarKey !== 'number'
    ) {
      return { success: false, playerId: socket.id, message: 'Invalid data.' };
    }

    const player: Player = {
      id: socket.id,
      persistentId: data.persistentPlayerId,
      avatarKey: data.avatarKey,
      username: data.username,
      status: 'pending',
    };
    const success = this.roomService.addPlayer(data.roomCode, player);
    if (success) {
      await socket.join(data.roomCode);
      this.emitRoomPlayers(data.roomCode);
      return {
        success,
        playerId: socket.id,
        reconnectToken: data.persistentPlayerId
          ? this.roomService.issueReconnectToken(
              data.roomCode,
              data.persistentPlayerId,
            )
          : undefined,
        message: 'Successfully joined room',
      };
    } else {
      return { success, playerId: socket.id, message: 'Unable to join room' };
    }
  }

  @SubscribeMessage('rq_player:rejoinRoom')
  async handleRejoinRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      persistentPlayerId: string;
      reconnectToken: string;
    },
  ) {
    if (
      !this.validateRoomCode(data) ||
      !this.validateString(data?.persistentPlayerId, 64) ||
      !this.validateString(data?.reconnectToken, 100)
    ) {
      socket.emit('player:rejoinRoomError', {
        message: 'Thông tin phòng không hợp lệ.',
      });
      return;
    }
    if (
      !this.roomService.validateReconnectToken(
        data.roomCode,
        data.persistentPlayerId,
        data.reconnectToken,
      )
    ) {
      socket.emit('player:rejoinRoomError', {
        message: 'Phiên kết nối lại không hợp lệ hoặc đã hết hạn.',
      });
      return;
    }

    const player: Player | null = this.roomService.rejoinPlayer(
      data.roomCode,
      socket.id,
      data.persistentPlayerId,
    );
    if (!player) {
      socket.emit('player:rejoinRoomError', {
        message: 'Không tìm thấy người chơi trong phòng này.',
      });
      return;
    }

    await socket.join(data.roomCode);
    this.phaseManager.updatePlayerSocketId(
      data.roomCode,
      data.persistentPlayerId,
      socket.id,
    );
    const players = this.roomService.getPlayers(data.roomCode);
    const currentPlayer = players.find((p) => p.id === socket.id);
    socket.emit('player:rejoined', {
      playerId: socket.id,
      roomCode: data.roomCode,
      role: currentPlayer?.role,
      phase: this.phaseManager.getPhase(data.roomCode),
      players: this.serializePlayersForSocket(players, socket.id),
      alive: currentPlayer?.alive ?? null,
    });

    // Sync timer state if a countdown is active
    const timerInfo: TimerInfo | undefined = this.phaseManager.getTimerInfo(
      data.roomCode,
    );
    if (timerInfo) {
      socket.emit('game:timerSync', timerInfo);
    }

    const votingProgress = this.phaseManager.getVotingProgress(data.roomCode);
    if (votingProgress) {
      socket.emit('voting:progress', votingProgress);
    }

    const votingState = this.phaseManager.getPlayerVotingState(
      data.roomCode,
      socket.id,
    );
    if (votingState) {
      socket.emit('voting:state', votingState);
    }

    const snapshot = this.phaseManager.getPlayerStateSnapshot?.(
      data.roomCode,
      socket.id,
    );
    if (snapshot) {
      socket.emit('player:stateSnapshot', snapshot);
    }

    this.emitRoomPlayers(data.roomCode);
    this.logger.log(`Player ${player.username} rejoined room ${data.roomCode}`);
  }

  @SubscribeMessage('rq_player:syncState')
  handlePlayerSyncState(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      persistentPlayerId: string;
      reconnectToken: string;
    },
  ) {
    if (
      !this.validateRoomCode(data) ||
      !this.validateString(data?.persistentPlayerId, 64) ||
      !this.validateString(data?.reconnectToken, 100)
    ) {
      socket.emit('player:stateSnapshotError', {
        message: 'Thông tin đồng bộ không hợp lệ.',
      });
      return;
    }

    const validToken = this.roomService.validateReconnectToken(
      data.roomCode,
      data.persistentPlayerId,
      data.reconnectToken,
    );
    if (!validToken) {
      socket.emit('player:stateSnapshotError', {
        message: 'Phiên kết nối lại không hợp lệ hoặc đã hết hạn.',
      });
      return;
    }

    const room = this.roomService.getRoom(data.roomCode);
    const player = room?.players.find(
      (p) => p.persistentId === data.persistentPlayerId,
    );
    if (!room || !player || player.status === 'rejected') {
      socket.emit('player:stateSnapshotError', {
        message: 'Không tìm thấy người chơi trong phòng này.',
      });
      return;
    }

    const snapshot = this.phaseManager.getPlayerStateSnapshot?.(
      data.roomCode,
      player.id,
    );
    if (!snapshot) {
      socket.emit('player:stateSnapshotError', {
        message: 'Không thể đồng bộ trạng thái phòng.',
      });
      return;
    }

    socket.emit('player:stateSnapshot', snapshot);
    if (snapshot.timer) {
      socket.emit('game:timerSync', snapshot.timer);
    } else {
      socket.emit('game:timerStop', {});
    }
  }

  @SubscribeMessage('rq_gm:syncState')
  handleGmSyncState(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      gmPersistentId: string;
      gmReconnectToken: string;
    },
  ) {
    if (
      !this.validateRoomCode(data) ||
      !this.validateString(data?.gmPersistentId, 64) ||
      !this.validateString(data?.gmReconnectToken, 100)
    ) {
      socket.emit('gm:stateSnapshotError', {
        message: 'Thông tin đồng bộ không hợp lệ.',
      });
      return;
    }

    const room = this.roomService.getRoom(data.roomCode);
    const authorized =
      room?.hostId === socket.id ||
      (room?.gmPersistentId === data.gmPersistentId &&
        this.roomService.validateGmReconnectToken(
          data.roomCode,
          data.gmPersistentId,
          data.gmReconnectToken,
        ));

    if (!room || !authorized) {
      socket.emit('gm:stateSnapshotError', { message: 'Not authorized.' });
      return;
    }

    const snapshot = this.phaseManager.getGmStateSnapshot?.(data.roomCode);
    if (snapshot) {
      socket.emit('gm:stateSnapshot', snapshot);
      if (snapshot.timer) {
        socket.emit('game:timerSync', snapshot.timer);
      } else {
        socket.emit('game:timerStop', {});
      }
    }
  }

  @SubscribeMessage('push:register')
  handlePushRegister(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      token: string;
      deviceId: string;
      participantKind: 'player' | 'gm';
      persistentPlayerId?: string;
      reconnectToken?: string;
      gmPersistentId?: string;
      gmReconnectToken?: string;
      userAgent?: string;
      platform?: string;
    },
  ) {
    if (
      !this.validateRoomCode(data) ||
      !this.validateString(data?.token, 4096) ||
      !this.validateString(data?.deviceId, 128) ||
      (data.participantKind !== 'player' && data.participantKind !== 'gm')
    ) {
      return { success: false, status: 'rejected', message: 'Invalid data.' };
    }

    const room = this.roomService.getRoom(data.roomCode);
    if (!room) {
      return { success: false, status: 'rejected', message: 'Room not found.' };
    }

    let participantId: string | undefined;
    if (data.participantKind === 'gm') {
      const authorizedBySocket = room.hostId === socket.id;
      const authorizedByToken =
        this.validateString(data?.gmPersistentId, 64) &&
        this.validateString(data?.gmReconnectToken, 100) &&
        room.gmPersistentId === data.gmPersistentId &&
        this.roomService.validateGmReconnectToken(
          data.roomCode,
          data.gmPersistentId,
          data.gmReconnectToken,
        );
      if (!authorizedBySocket && !authorizedByToken) {
        return { success: false, status: 'rejected', message: 'Not authorized.' };
      }
      participantId = room.players.find((p) => p.status === 'gm')?.id;
    } else {
      const participantKind = this.getRoomParticipantKind(socket, data.roomCode);
      const authorizedBySocket = participantKind === 'player';
      const authorizedByToken =
        this.validateString(data?.persistentPlayerId, 64) &&
        this.validateString(data?.reconnectToken, 100) &&
        this.roomService.validateReconnectToken(
          data.roomCode,
          data.persistentPlayerId,
          data.reconnectToken,
        );
      if (!authorizedBySocket && !authorizedByToken) {
        return { success: false, status: 'rejected', message: 'Not authorized.' };
      }
      participantId = authorizedBySocket ? socket.id : data.persistentPlayerId;
    }

    if (!participantId) {
      return { success: false, status: 'rejected', message: 'Participant not found.' };
    }

    const status = this.roomService.registerPushToken(data.roomCode, participantId, {
      token: data.token,
      deviceId: data.deviceId,
      participantKind: data.participantKind,
      persistentId:
        data.participantKind === 'gm'
          ? data.gmPersistentId ?? room.gmPersistentId
          : data.persistentPlayerId,
      socketId: socket.id,
      userAgent: data.userAgent,
      platform: data.platform,
    });

    if (status === 'not_found') {
      return { success: false, status: 'rejected', message: 'Participant not found.' };
    }

    return {
      success: true,
      status,
      message: 'Đã bật thông báo cho phòng này.',
    };
  }

  @SubscribeMessage('push:unregister')
  handlePushUnregister(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      token?: string;
      deviceId?: string;
      participantKind: 'player' | 'gm';
      persistentPlayerId?: string;
      gmPersistentId?: string;
    },
  ) {
    if (
      !this.validateRoomCode(data) ||
      (data.token !== undefined && !this.validateString(data.token, 4096)) ||
      (data.deviceId !== undefined && !this.validateString(data.deviceId, 128)) ||
      (data.participantKind !== 'player' && data.participantKind !== 'gm')
    ) {
      return { success: false, status: 'rejected', message: 'Invalid data.' };
    }

    const room = this.roomService.getRoom(data.roomCode);
    if (!room) {
      return { success: false, status: 'not_found', message: 'Room not found.' };
    }

    let participantId: string | undefined;
    if (data.participantKind === 'gm') {
      if (room.hostId !== socket.id) {
        return { success: false, status: 'rejected', message: 'Not authorized.' };
      }
      participantId = room.players.find((p) => p.status === 'gm')?.id;
    } else {
      const participantKind = this.getRoomParticipantKind(socket, data.roomCode);
      if (participantKind !== 'player') {
        return { success: false, status: 'rejected', message: 'Not authorized.' };
      }
      participantId = socket.id;
    }

    if (!participantId) {
      return { success: false, status: 'not_found', message: 'Participant not found.' };
    }

    const status = this.roomService.unregisterPushToken(
      data.roomCode,
      participantId,
      data.token,
      data.deviceId,
    );

    return {
      success: status === 'removed',
      status,
      message: status === 'removed' ? 'Đã tắt thông báo.' : 'Không tìm thấy token.',
    };
  }

  @SubscribeMessage('rq_player:leaveRoom')
  async handleLeaveRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    if (!this.validateRoomCode(data)) {
      return {
        success: false,
        status: 'invalid_data',
        message: 'Mã phòng không hợp lệ.',
      };
    }

    const participantKind = this.getRoomParticipantKind(socket, data.roomCode);
    if (participantKind !== 'player') {
      return {
        success: false,
        status: 'not_in_room',
        message: 'Bạn không thuộc phòng này.',
      };
    }

    const result = this.roomService.leavePlayer(data.roomCode, socket.id);
    if (!result.success || !result.player) {
      return {
        success: false,
        status: result.status,
        message: 'Không thể rời phòng.',
      };
    }

    if (result.status === 'left_active_game') {
      this.phaseManager.handlePlayerLeave(data.roomCode, result.player.id);
    }

    this.server.to(data.roomCode).emit('room:playerLeft', {
      playerId: result.player.id,
      username: result.player.username,
      activeGame: result.activeGame ?? false,
    });
    await socket.leave(data.roomCode);
    this.emitRoomPlayers(data.roomCode);

    return {
      success: true,
      status: result.status,
      message:
        result.status === 'left_active_game'
          ? 'Bạn đã rời ván. Phiên kết nối lại đã bị huỷ.'
          : 'Bạn đã rời phòng.',
    };
  }

  @SubscribeMessage('rq_player:updateInfo')
  handleUpdateInfo(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: { roomCode: string; username: string; avatarKey: number },
  ) {
    if (
      !this.validateRoomCode(data) ||
      !this.validateString(data?.username, 30) ||
      typeof data?.avatarKey !== 'number'
    ) {
      return { success: false, message: 'Thông tin người chơi không hợp lệ.' };
    }

    const participantKind = this.getRoomParticipantKind(socket, data.roomCode);
    if (!participantKind) {
      return { success: false, message: 'Bạn không thuộc phòng này.' };
    }

    const result = this.roomService.updatePlayerInfo(
      data.roomCode,
      socket.id,
      data.username,
      data.avatarKey,
    );
    if (!result.success || !result.player) {
      return { success: false, message: 'Không thể cập nhật thông tin.' };
    }

    this.phaseManager.updatePlayerInfo(
      data.roomCode,
      result.player.id,
      result.player.username,
      result.player.avatarKey,
    );
    socket.emit('player:infoUpdated', {
      playerId: result.player.id,
      username: result.player.username,
      avatarKey: result.player.avatarKey,
    });
    this.server.to(data.roomCode).emit('room:playerInfoUpdated', {
      playerId: result.player.id,
      username: result.player.username,
      avatarKey: result.player.avatarKey,
    });
    this.emitRoomPlayers(data.roomCode);

    return {
      success: true,
      player: this.serializePlayerForSocket(result.player, socket.id),
      message: 'Đã cập nhật thông tin.',
    };
  }

  @SubscribeMessage('rq_gm:resetRoom')
  handleResetRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; force?: boolean },
  ) {
    if (!this.validateRoomCode(data)) {
      return { success: false, message: 'Mã phòng không hợp lệ.' };
    }
    if (!this.isHost(socket, data.roomCode)) {
      socket.emit('room:resetError', { message: 'Not authorized.' });
      return { success: false, message: 'Not authorized.' };
    }

    const room = this.roomService.getRoom(data.roomCode);
    if (!room) return { success: false, message: 'Không tìm thấy phòng.' };

    const phase = this.phaseManager.getPhase(data.roomCode) ?? room.phase;
    if (room.gameStarted && phase !== 'ended' && !data.force) {
      return {
        success: false,
        message: 'Ván đang diễn ra. Cần xác nhận reset cưỡng bức.',
      };
    }

    this.phaseManager.resetRoomState(data.roomCode);
    const resetRoom = this.roomService.resetRoom(data.roomCode);
    if (!resetRoom) return { success: false, message: 'Không thể reset phòng.' };

    const payload = {
      roomCode: data.roomCode,
      phase: 'night' as const,
      round: 0,
      gameStarted: false,
      reason: 'gm_reset' as const,
    };
    this.server.to(data.roomCode).emit('game:timerStop', {});
    this.server.to(data.roomCode).emit('room:reset', payload);
    this.server.to(resetRoom.hostId).emit('room:reset', payload);
    if (resetRoom.gmRoomId) {
      this.server.to(resetRoom.gmRoomId).emit('room:reset', payload);
    }
    this.emitRoomPlayers(data.roomCode);

    return {
      success: true,
      roomCode: data.roomCode,
      phase: 'night',
      players: resetRoom.players,
      message: 'Đã reset phòng. Có thể chơi lại trong cùng phòng.',
    };
  }

  @SubscribeMessage('rq_gm:approvePlayer')
  handleApprovePlayer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; playerId: string },
  ) {
    if (!this.validateRoomCode(data) || !this.validateString(data?.playerId)) {
      return;
    }
    if (!this.isHost(socket, data.roomCode)) {
      socket.emit('room:approvePlayerError', { message: 'Not authorized.' });
      return;
    }
    const success = this.roomService.approvePlayer(
      data.roomCode,
      data.playerId,
    );
    if (success) {
      this.emitRoomPlayers(data.roomCode);
      const room = this.roomService.getRoom(data.roomCode);
      this.server.to(data.playerId).emit('player:approved', {
        ...(room ? this.serializeRoomForSocket(room, data.playerId) : {}),
        roomCode: data.roomCode,
      });
    } else {
      socket.emit('room:approvePlayerError', {
        message: 'Unable to approve player.',
      });
    }
  }

  @SubscribeMessage('rq_gm:rejectPlayer')
  handleRejectPlayer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; playerId: string },
  ) {
    if (!this.validateRoomCode(data) || !this.validateString(data?.playerId)) {
      return;
    }
    if (!this.isHost(socket, data.roomCode)) {
      socket.emit('room:rejectPlayerError', { message: 'Not authorized.' });
      return;
    }
    const success = this.roomService.rejectPlayer(data.roomCode, data.playerId);
    if (success) {
      this.emitRoomPlayers(data.roomCode);
      this.server
        .to(data.playerId)
        .emit('player:rejected', { message: 'You were rejected by the GM.' });
    } else {
      socket.emit('room:rejectPlayerError', {
        message: 'Unable to reject player.',
      });
    }
  }

  @SubscribeMessage('rq_gm:getPlayers')
  handleGmGetPlayers(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    if (!this.validateRoomCode(data)) return;
    if (!this.isHost(socket, data.roomCode)) {
      socket.emit('room:updatePlayersError', { message: 'Not authorized.' });
      return;
    }
    const players = this.roomService.getPlayers(data.roomCode);
    // Emit directly to the requesting socket so UI stays in sync,
    // and also return as ack payload for deterministic test helpers.
    socket.emit('room:updatePlayers', players);
    return players;
  }

  @SubscribeMessage('rq_gm:eliminatePlayer')
  handleGmEliminatePlayer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; playerId: string; reason: string },
  ) {
    if (!this.validateRoomCode(data) || !this.validateString(data?.playerId)) {
      return;
    }
    if (!this.isHost(socket, data.roomCode)) {
      socket.emit('gm:eliminatePlayerError', { message: 'Not authorized.' });
      return;
    }

    const success = this.roomService.eliminatePlayer(
      data.roomCode,
      data.playerId,
      data.reason,
    );

    if (success) {
      this.phaseManager.eliminatePlayer(data.roomCode, data.playerId);
      const players = this.roomService.getPlayers(data.roomCode);

      this.emitRoomPlayers(data.roomCode);

      const eliminatedPlayer = players.find((p) => p.id === data.playerId);
      if (eliminatedPlayer) {
        this.server.to(data.roomCode).emit('gm:nightAction', {
          step: 'gm_elimination',
          action: 'eliminate',
          message: `Game master đã loại bỏ ${eliminatedPlayer.username}: ${data.reason}`,
          timestamp: Date.now(),
        });
      }
    } else {
      socket.emit('gm:eliminatePlayerError', {
        message: 'Failed to eliminate player.',
      });
    }
  }

  @SubscribeMessage('rq_gm:revivePlayer')
  handleGmRevivePlayer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; playerId: string },
  ) {
    if (!this.validateRoomCode(data) || !this.validateString(data?.playerId)) {
      return;
    }
    if (!this.isHost(socket, data.roomCode)) {
      socket.emit('gm:revivePlayerError', { message: 'Not authorized.' });
      return;
    }

    const success = this.roomService.revivePlayer(data.roomCode, data.playerId);

    if (success) {
      this.phaseManager.revivePlayer(data.roomCode, data.playerId);
      const players = this.roomService.getPlayers(data.roomCode);

      this.emitRoomPlayers(data.roomCode);

      const revivedPlayer = players.find((p) => p.id === data.playerId);
      if (revivedPlayer) {
        this.server.to(data.roomCode).emit('gm:nightAction', {
          step: 'gm_revival',
          action: 'revive',
          message: `GM đã hồi sinh ${revivedPlayer.username}`,
          timestamp: Date.now(),
        });
      }
    } else {
      socket.emit('gm:revivePlayerError', {
        message: 'Failed to revive player.',
      });
    }
  }

  @SubscribeMessage('rq_player:getPlayers')
  handlePlayerGetPlayers(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    if (!this.validateRoomCode(data)) return;

    const participantKind = this.getRoomParticipantKind(socket, data.roomCode);
    if (!participantKind) {
      socket.emit('room:updatePlayersError', { message: 'Not authorized.' });
      return;
    }

    const players = this.roomService.getPlayers(data.roomCode);
    socket.emit(
      'room:updatePlayers',
      participantKind === 'gm'
        ? players
        : this.serializePlayersForSocket(players, socket.id),
    );
  }

  @SubscribeMessage('rq_gm:randomizeRoles')
  handleRandomizeRoles(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; roles: Role[] },
  ) {
    if (!this.validateRoomCode(data) || !Array.isArray(data?.roles)) {
      return 'Invalid data.';
    }
    if (!this.isHost(socket, data.roomCode)) {
      socket.emit('room:randomizeRolesError', { message: 'Not authorized.' });
      return 'Not authorized.';
    }
    const validRoles = [
      'villager',
      'werewolf',
      'seer',
      'witch',
      'hunter',
      'bodyguard',
      'tanner',
    ];
    if (!data.roles.every((role) => validRoles.includes(role)))
      return 'Invalid roles provided';
    if (!data.roles.includes('werewolf'))
      return 'Role list must include at least one werewolf';
    const success = this.roomService.randomizeRoles(data.roomCode, data.roles);
    if (success) {
      const updatedRoom = this.roomService.getRoom(data.roomCode);
      if (updatedRoom) {
        updatedRoom.players
          .filter((player) => player.status === 'approved')
          .forEach((player) => {
            this.server
              .to(player.id)
              .emit('player:assignedRole', { role: player.role });
          });
        this.emitRoomPlayers(data.roomCode);
      }
      return '';
    }
    socket.emit('room:randomizeRolesError', {
      message: 'Unable to randomize roles',
    });
    return 'Unable to randomize roles';
  }

  @SubscribeMessage('rq_player:ready')
  handlePlayerReady(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    if (!this.validateRoomCode(data)) return;
    const room = this.roomService.getRoom(data.roomCode);
    const success = this.roomService.playerReady(data.roomCode, socket.id);
    if (room) {
      this.emitRoomPlayers(data.roomCode);
      if (success) {
        socket.emit('player:readySuccess', { roomCode: data.roomCode });
        this.server.to(data.roomCode).emit('room:readySuccess');
        if (!this.roomService.markGameStarted(data.roomCode)) return;
        const approvedPlayers = room.players.filter(
          (player) => player.status === 'approved',
        );
        this.phaseManager.initGameState(
          data.roomCode,
          approvedPlayers,
          this.roomService.getGmRoomId(data.roomCode) ?? data.roomCode,
        );
      }
    }
  }

  @SubscribeMessage('rq_gm:nextPhase')
  handleNextPhase(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    if (!this.validateRoomCode(data)) return;
    if (!this.isHost(socket, data.roomCode)) {
      socket.emit('room:phaseError', { message: 'Not authorized.' });
      return;
    }

    try {
      const currentPhase = this.phaseManager.getPhase(data.roomCode);

      // Semi-auto flow: GM can only trigger specific transitions
      switch (currentPhase) {
        case 'day':
          // GM triggers day → voting
          if (this.phaseManager.canTransition(data.roomCode, 'voting')) {
            this.phaseManager.startVotingPhase(data.roomCode);
          } else {
            socket.emit('room:phaseError', {
              message: 'Không thể chuyển sang bỏ phiếu lúc này.',
            });
          }
          break;
        case 'conclude':
        case null:
          // GM triggers conclude/start → night
          if (this.phaseManager.canTransition(data.roomCode, 'night')) {
            void this.phaseManager.startNightPhase(data.roomCode);
          } else {
            socket.emit('room:phaseError', {
              message: 'Không thể bắt đầu đêm lúc này.',
            });
          }
          break;
        case 'night':
        case 'voting':
          // Night → day and voting → conclude are automatic
          socket.emit('room:phaseError', {
            message: `Giai đoạn ${currentPhase} đang tự động xử lý.`,
          });
          break;
        case 'ended':
          socket.emit('room:phaseError', {
            message: 'Trò chơi đã kết thúc.',
          });
          break;
        default:
          socket.emit('room:phaseError', {
            message: 'Game state not found.',
          });
          break;
      }
    } catch (error) {
      this.logger.error(`Error in nextPhase for room ${data.roomCode}`, error);
      socket.emit('room:phaseError', {
        message: 'Lỗi hệ thống. Vui lòng thử lại.',
      });
    }
  }

  private handleRoleAction(
    vote: string,
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    this.phaseManager.handleRoleResponse(data.roomCode, socket.id, {
      ...data,
      vote,
    });
  }

  @SubscribeMessage('night:werewolf-action:done')
  handleWerewolfActionDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; targetId: string },
  ) {
    if (!this.validateRoomCode(data)) return;
    this.handleRoleAction('werewolf', socket, data);
  }

  @SubscribeMessage('night:seer-action:done')
  handleSeerActionDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; targetId: string },
  ) {
    if (!this.validateRoomCode(data)) return;
    this.handleRoleAction('seer', socket, data);
  }

  @SubscribeMessage('night:witch-action:done')
  handleWitchActionDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: { roomCode: string; heal: boolean; poisonTargetId?: string },
  ) {
    if (!this.validateRoomCode(data)) return;
    this.handleRoleAction('witch', socket, data);
  }

  @SubscribeMessage('night:bodyguard-action:done')
  handleBodyguardActionDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; targetId: string },
  ) {
    if (!this.validateRoomCode(data)) return;
    this.handleRoleAction('bodyguard', socket, data);
  }

  @SubscribeMessage('night:hunter-action:done')
  handleHunterActionDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; targetId?: string },
  ) {
    if (!this.validateRoomCode(data)) return;
    this.handleRoleAction('hunter', socket, data);
  }

  @SubscribeMessage('voting:done')
  handleVotingDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      targetId?: string | null;
      choice?: VotingChoice;
    },
  ): VotingSubmissionAck {
    if (!this.validateRoomCode(data)) {
      return {
        success: false,
        status: 'rejected',
        reason: 'invalid_room',
        message: 'Mã phòng không hợp lệ.',
      };
    }

    if (data.choice && data.choice !== 'target' && data.choice !== 'abstain') {
      return {
        success: false,
        status: 'rejected',
        reason: 'invalid_choice',
        message: 'Lựa chọn bỏ phiếu không hợp lệ.',
      };
    }

    if (data.targetId != null && !this.validateString(data.targetId)) {
      return {
        success: false,
        status: 'rejected',
        reason: 'invalid_target',
        message: 'Mục tiêu bỏ phiếu không hợp lệ.',
      };
    }

    return this.phaseManager.handleVotingResponse(data.roomCode, socket.id, {
      choice: data.choice,
      targetId: data.targetId ?? null,
    });
  }

  @SubscribeMessage('game:hunterShoot:done')
  handleHunterShootDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: { roomCode: string; targetId?: string; winCondition?: string },
  ) {
    if (!this.validateRoomCode(data)) return;
    this.phaseManager.handleHunterDeathShoot(
      data.roomCode,
      socket.id,
      data.targetId,
    );
  }
}
