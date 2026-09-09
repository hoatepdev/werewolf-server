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
import { PushNotificationService } from '../service/push-notification.service';
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
    private readonly pushNotificationService: PushNotificationService,
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

  private sendPush(
    roomCode: string,
    tokens: string[],
    title: string,
    body: string,
    data: Record<string, string | undefined>,
  ): void {
    if (tokens.length === 0) return;

    void this.pushNotificationService
      .sendToTokens(tokens, { title, body, data })
      .then(({ invalidTokens }) => {
        if (invalidTokens.length > 0) {
          this.roomService.removeInvalidPushTokens(roomCode, invalidTokens);
        }
      })
      .catch((error) => {
        this.logger.warn(`Push notification failed: ${String(error)}`);
      });
  }

  private validateString(value: unknown, maxLength = 100): value is string {
    return (
      typeof value === 'string' && value.length > 0 && value.length <= maxLength
    );
  }

  private validateRoomCode(data: {
    roomCode?: unknown;
  }): data is { roomCode: string } {
    return RoomService.isValidRoomCode(data?.roomCode);
  }

  private validatePositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
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
      return { success: false, message: 'Dữ liệu không hợp lệ.' };
    }
    if (
      data.roomCode !== undefined &&
      !RoomService.isValidRoomCode(data.roomCode)
    ) {
      return { success: false, message: 'Mã phòng không hợp lệ.' };
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
        socket.emit('gm:connectRoomError', {
          message: 'Không có quyền truy cập.',
        });
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
        socket.emit('gm:connectRoomError', {
          message: 'Không có quyền truy cập.',
        });
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
      message: 'GM đã kết nối thành công',
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

    const votingProgress = this.phaseManager.getVotingProgress(data.roomCode);
    if (votingProgress) {
      socket.emit('voting:progress', votingProgress);
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
      return {
        success: false,
        playerId: socket.id,
        message: 'Dữ liệu không hợp lệ.',
      };
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
        message: 'Tham gia phòng thành công',
      };
    } else {
      return {
        success,
        playerId: socket.id,
        message: 'Không thể tham gia phòng',
      };
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

    const rejoinResult = this.roomService.rejoinPlayer(
      data.roomCode,
      socket.id,
      data.persistentPlayerId,
    );
    if (!rejoinResult) {
      socket.emit('player:rejoinRoomError', {
        message: 'Không tìm thấy người chơi trong phòng này.',
      });
      return;
    }

    const { player, oldSocketId } = rejoinResult;

    await socket.join(data.roomCode);
    this.phaseManager.updatePlayerSocketId(
      data.roomCode,
      data.persistentPlayerId,
      socket.id,
      oldSocketId,
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

    // Sync timer state if a countdown is active, otherwise clear stale client timers.
    const timerInfo: TimerInfo | undefined = this.phaseManager.getTimerInfo(
      data.roomCode,
    );
    if (timerInfo) {
      socket.emit('game:timerSync', timerInfo);
    } else {
      socket.emit('game:timerStop', {});
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
      socket.emit('gm:stateSnapshotError', {
        message: 'Không có quyền truy cập.',
      });
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

    const votingProgress = this.phaseManager.getVotingProgress(data.roomCode);
    if (votingProgress) {
      socket.emit('voting:progress', votingProgress);
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
      return {
        success: false,
        status: 'rejected',
        message: 'Dữ liệu không hợp lệ.',
      };
    }

    const room = this.roomService.getRoom(data.roomCode);
    if (!room) {
      return {
        success: false,
        status: 'rejected',
        message: 'Không tìm thấy phòng.',
      };
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
        return {
          success: false,
          status: 'rejected',
          message: 'Không có quyền truy cập.',
        };
      }
      participantId = room.players.find((p) => p.status === 'gm')?.id;
    } else {
      const participantKind = this.getRoomParticipantKind(
        socket,
        data.roomCode,
      );
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
        return {
          success: false,
          status: 'rejected',
          message: 'Không có quyền truy cập.',
        };
      }
      participantId = authorizedBySocket ? socket.id : data.persistentPlayerId;
    }

    if (!participantId) {
      return {
        success: false,
        status: 'rejected',
        message: 'Không tìm thấy người tham gia.',
      };
    }

    const status = this.roomService.registerPushToken(
      data.roomCode,
      participantId,
      {
        token: data.token,
        deviceId: data.deviceId,
        participantKind: data.participantKind,
        persistentId:
          data.participantKind === 'gm'
            ? (data.gmPersistentId ?? room.gmPersistentId)
            : data.persistentPlayerId,
        socketId: socket.id,
        userAgent: data.userAgent,
        platform: data.platform,
      },
    );

    if (status === 'not_found') {
      return {
        success: false,
        status: 'rejected',
        message: 'Không tìm thấy người tham gia.',
      };
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
      reconnectToken?: string;
      gmPersistentId?: string;
      gmReconnectToken?: string;
    },
  ) {
    if (
      !this.validateRoomCode(data) ||
      (!data.token && !data.deviceId) ||
      (data.token !== undefined && !this.validateString(data.token, 4096)) ||
      (data.deviceId !== undefined &&
        !this.validateString(data.deviceId, 128)) ||
      (data.participantKind !== 'player' && data.participantKind !== 'gm')
    ) {
      return {
        success: false,
        status: 'rejected',
        message: 'Dữ liệu không hợp lệ.',
      };
    }

    const room = this.roomService.getRoom(data.roomCode);
    if (!room) {
      return {
        success: false,
        status: 'not_found',
        message: 'Không tìm thấy phòng.',
      };
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
        return {
          success: false,
          status: 'rejected',
          message: 'Không có quyền truy cập.',
        };
      }
      participantId = room.players.find((p) => p.status === 'gm')?.id;
    } else {
      const participantKind = this.getRoomParticipantKind(
        socket,
        data.roomCode,
      );
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
        return {
          success: false,
          status: 'rejected',
          message: 'Không có quyền truy cập.',
        };
      }
      participantId = authorizedBySocket ? socket.id : data.persistentPlayerId;
    }

    if (!participantId) {
      return {
        success: false,
        status: 'not_found',
        message: 'Không tìm thấy người tham gia.',
      };
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
      message:
        status === 'removed' ? 'Đã tắt thông báo.' : 'Không tìm thấy token.',
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
      socket.emit('room:resetError', { message: 'Không có quyền truy cập.' });
      return { success: false, message: 'Không có quyền truy cập.' };
    }

    const room = this.roomService.getRoom(data.roomCode);
    if (!room) return { success: false, message: 'Không tìm thấy phòng.' };

    const phase = this.phaseManager.getPhase(data.roomCode) ?? room.phase;
    if (room.gameStarted && phase !== 'ended' && !data.force) {
      return {
        success: false,
        status: 'requires_force',
        message: 'Ván đang diễn ra. Cần xác nhận reset cưỡng bức.',
      };
    }

    this.phaseManager.resetRoomState(data.roomCode);
    const resetRoom = this.roomService.resetRoom(data.roomCode);
    if (!resetRoom)
      return { success: false, message: 'Không thể reset phòng.' };
    const resetPlayerPushTokens = this.roomService.getPushTokensForRoomPlayers(
      data.roomCode,
      { approvedOnly: true },
    );

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
    this.sendPush(
      data.roomCode,
      resetPlayerPushTokens,
      'Phòng đã được reset',
      'Quản trò đã đưa mọi người về sảnh chờ. Có thể chơi lại trong cùng phòng.',
      {
        type: 'room-reset',
        roomCode: data.roomCode,
        participantKind: 'player',
        url: `/lobby/${data.roomCode}`,
        snapshotHint: 'request-on-open',
      },
    );

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
      socket.emit('room:approvePlayerError', {
        message: 'Không có quyền truy cập.',
      });
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
      this.sendPush(
        data.roomCode,
        this.roomService.getPushTokensForPlayer(data.roomCode, data.playerId),
        'Bạn đã được duyệt vào phòng',
        'Mở Ma Sói để xem vai và sẵn sàng chơi.',
        {
          type: 'room-approved',
          roomCode: data.roomCode,
          participantKind: 'player',
          url: `/lobby/${data.roomCode}`,
          snapshotHint: 'request-on-open',
        },
      );
    } else {
      socket.emit('room:approvePlayerError', {
        message: 'Không thể duyệt người chơi.',
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
      socket.emit('room:rejectPlayerError', {
        message: 'Không có quyền truy cập.',
      });
      return;
    }
    const pushTokens = this.roomService.getPushTokensForPlayer(
      data.roomCode,
      data.playerId,
    );
    const success = this.roomService.rejectPlayer(data.roomCode, data.playerId);
    if (success) {
      this.emitRoomPlayers(data.roomCode);
      this.server.to(data.playerId).emit('player:rejected', {
        message: 'Bạn đã bị quản trò từ chối.',
      });
      this.sendPush(
        data.roomCode,
        pushTokens,
        'Yêu cầu vào phòng bị từ chối',
        'Quản trò đã từ chối yêu cầu tham gia phòng.',
        {
          type: 'room-rejected',
          roomCode: data.roomCode,
          participantKind: 'player',
          url: '/',
          snapshotHint: 'request-on-open',
        },
      );
    } else {
      socket.emit('room:rejectPlayerError', {
        message: 'Không thể từ chối người chơi.',
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
      socket.emit('room:updatePlayersError', {
        message: 'Không có quyền truy cập.',
      });
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
    @MessageBody()
    data: { roomCode: string; playerId: string; reason?: string },
  ) {
    if (
      !this.validateRoomCode(data) ||
      !this.validateString(data?.playerId) ||
      !this.validateString(data?.reason, 120)
    ) {
      return {
        success: false,
        status: 'invalid_data',
        message: 'Thông tin loại bỏ không hợp lệ.',
      };
    }
    if (!this.isHost(socket, data.roomCode)) {
      const ack = {
        success: false,
        status: 'not_authorized',
        message: 'Không có quyền truy cập.',
      };
      socket.emit('gm:eliminatePlayerError', { message: ack.message });
      return ack;
    }

    const room = this.roomService.getRoom(data.roomCode);
    if (!room) {
      return {
        success: false,
        status: 'room_not_found',
        message: 'Không tìm thấy phòng.',
      };
    }

    const player = room.players.find((p) => p.id === data.playerId);
    if (!player || player.status !== 'approved') {
      return {
        success: false,
        status: 'player_not_found',
        message: 'Không tìm thấy người chơi hợp lệ.',
      };
    }
    if (player.alive === false) {
      return {
        success: false,
        status: 'invalid_state',
        message: `${player.username} đã bị loại trước đó.`,
      };
    }

    const reason = data.reason.trim();
    const success = this.roomService.eliminatePlayer(
      data.roomCode,
      data.playerId,
      reason,
    );

    if (!success) {
      const ack = {
        success: false,
        status: 'invalid_state',
        message: 'Không thể loại bỏ người chơi.',
      };
      socket.emit('gm:eliminatePlayerError', { message: ack.message });
      return ack;
    }

    this.phaseManager.eliminatePlayer(data.roomCode, data.playerId);
    const players = this.roomService.getPlayers(data.roomCode);
    this.emitRoomPlayers(data.roomCode);

    this.phaseManager.emitGmLog(data.roomCode, 'gm:nightAction', {
      step: 'gm_elimination',
      action: 'eliminate',
      message: `GM đã loại bỏ ${player.username}: ${reason}`,
      timestamp: Date.now(),
    });

    return {
      success: true,
      status: 'ok',
      message: `Đã loại bỏ ${player.username}.`,
      playerId: data.playerId,
      players,
    };
  }

  @SubscribeMessage('rq_gm:revivePlayer')
  handleGmRevivePlayer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; playerId: string },
  ) {
    if (!this.validateRoomCode(data) || !this.validateString(data?.playerId)) {
      return {
        success: false,
        status: 'invalid_data',
        message: 'Thông tin hồi sinh không hợp lệ.',
      };
    }
    if (!this.isHost(socket, data.roomCode)) {
      const ack = {
        success: false,
        status: 'not_authorized',
        message: 'Không có quyền truy cập.',
      };
      socket.emit('gm:revivePlayerError', { message: ack.message });
      return ack;
    }

    const room = this.roomService.getRoom(data.roomCode);
    if (!room) {
      return {
        success: false,
        status: 'room_not_found',
        message: 'Không tìm thấy phòng.',
      };
    }

    const player = room.players.find((p) => p.id === data.playerId);
    if (!player || player.status !== 'approved') {
      return {
        success: false,
        status: 'player_not_found',
        message: 'Không tìm thấy người chơi hợp lệ.',
      };
    }
    if (player.alive !== false) {
      return {
        success: false,
        status: 'invalid_state',
        message: `${player.username} hiện không ở trạng thái đã bị loại.`,
      };
    }

    const success = this.roomService.revivePlayer(data.roomCode, data.playerId);

    if (!success) {
      const ack = {
        success: false,
        status: 'invalid_state',
        message: 'Không thể hồi sinh người chơi.',
      };
      socket.emit('gm:revivePlayerError', { message: ack.message });
      return ack;
    }

    this.phaseManager.revivePlayer(data.roomCode, data.playerId);
    const players = this.roomService.getPlayers(data.roomCode);
    this.emitRoomPlayers(data.roomCode);

    this.phaseManager.emitGmLog(data.roomCode, 'gm:nightAction', {
      step: 'gm_revival',
      action: 'revive',
      message: `GM đã hồi sinh ${player.username}`,
      timestamp: Date.now(),
    });

    return {
      success: true,
      status: 'ok',
      message: `Đã hồi sinh ${player.username}.`,
      playerId: data.playerId,
      players,
    };
  }

  @SubscribeMessage('rq_player:getPlayers')
  handlePlayerGetPlayers(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    if (!this.validateRoomCode(data)) return;

    const participantKind = this.getRoomParticipantKind(socket, data.roomCode);
    if (!participantKind) {
      socket.emit('room:updatePlayersError', {
        message: 'Không có quyền truy cập.',
      });
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
      return 'Dữ liệu không hợp lệ.';
    }
    if (!this.isHost(socket, data.roomCode)) {
      socket.emit('room:randomizeRolesError', {
        message: 'Không có quyền truy cập.',
      });
      return 'Không có quyền truy cập.';
    }
    const validRoles = [
      'villager',
      'werewolf',
      'seer',
      'witch',
      'hunter',
      'bodyguard',
      'tanner',
      'cupid',
    ];
    if (!data.roles.every((role) => validRoles.includes(role)))
      return 'Danh sách vai không hợp lệ';
    if (!data.roles.includes('werewolf'))
      return 'Danh sách vai phải có ít nhất một Sói';
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
      message: 'Không thể phân vai ngẫu nhiên',
    });
    return 'Không thể phân vai ngẫu nhiên';
  }

  @SubscribeMessage('rq_player:ready')
  handlePlayerReady(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    if (!this.validateRoomCode(data)) return;
    const room = this.roomService.getRoom(data.roomCode);
    if (!room) return;

    const allReady = this.roomService.playerReady(data.roomCode, socket.id);
    const updatedRoom = this.roomService.getRoom(data.roomCode);
    if (!updatedRoom) return;

    this.emitRoomPlayers(data.roomCode);

    const currentPlayer = updatedRoom.players.find(
      (player) => player.id === socket.id,
    );
    if (currentPlayer?.status !== 'approved' || currentPlayer.ready !== true) {
      socket.emit('player:readyError', {
        message: 'Không thể đánh dấu sẵn sàng lúc này.',
      });
      return;
    }

    socket.emit('player:readySuccess', { roomCode: data.roomCode });
    if (!allReady) return;

    if (!this.roomService.markGameStarted(data.roomCode)) return;
    const startedRoom = this.roomService.getRoom(data.roomCode) ?? updatedRoom;
    const approvedPlayers = startedRoom.players.filter(
      (player) => player.status === 'approved',
    );
    this.phaseManager.initGameState(
      data.roomCode,
      approvedPlayers,
      this.roomService.getGmRoomId(data.roomCode) ?? data.roomCode,
    );
    this.server.to(data.roomCode).emit('room:readySuccess');
  }

  @SubscribeMessage('rq_gm:dayTimerControl')
  handleDayTimerControl(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      action: 'start' | 'extend' | 'skip';
      durationMs?: number;
      deltaMs?: number;
    },
  ) {
    if (!this.validateRoomCode(data)) {
      return {
        success: false,
        status: 'invalid_data',
        message: 'Mã phòng không hợp lệ.',
      };
    }
    if (!this.isHost(socket, data.roomCode)) {
      const ack = {
        success: false,
        status: 'not_authorized',
        message: 'Không có quyền truy cập.',
      };
      socket.emit('gm:dayTimerControlError', { message: ack.message });
      return ack;
    }

    if (data.action === 'start') {
      if (
        data.durationMs !== undefined &&
        !this.validatePositiveNumber(data.durationMs)
      ) {
        return {
          success: false,
          status: 'invalid_data',
          message: 'Thời lượng thảo luận không hợp lệ.',
        };
      }
      return this.phaseManager.startDayDiscussionTimer(
        data.roomCode,
        data.durationMs,
      );
    }

    if (data.action === 'extend') {
      if (!this.validatePositiveNumber(data.deltaMs)) {
        return {
          success: false,
          status: 'invalid_data',
          message: 'Thời gian gia hạn không hợp lệ.',
        };
      }
      return this.phaseManager.extendDayDiscussionTimer(
        data.roomCode,
        data.deltaMs,
      );
    }

    if (data.action === 'skip') {
      return this.phaseManager.skipDayDiscussionTimer(data.roomCode);
    }

    return {
      success: false,
      status: 'invalid_data',
      message: 'Lệnh timer không hợp lệ.',
    };
  }

  @SubscribeMessage('rq_gm:nextPhase')
  handleNextPhase(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    if (!this.validateRoomCode(data)) return;
    if (!this.isHost(socket, data.roomCode)) {
      socket.emit('room:phaseError', { message: 'Không có quyền truy cập.' });
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
            message: 'Không tìm thấy trạng thái trò chơi.',
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

  @SubscribeMessage('night:cupid-action:done')
  handleCupidActionDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; targetIds: string[] },
  ) {
    if (!this.validateRoomCode(data) || !Array.isArray(data.targetIds)) return;
    this.handleRoleAction('cupid', socket, data);
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
