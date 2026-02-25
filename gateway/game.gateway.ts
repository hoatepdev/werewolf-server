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
import { Player, Role } from '../types';
import { Injectable, Logger } from '@nestjs/common';
import { PhaseManager } from '../service/phase-manager.service';
import 'dotenv/config';

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: false,
  },
})
@Injectable()
export class GameGateway implements OnGatewayInit, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(GameGateway.name);

  constructor(
    private readonly roomService: RoomService,
    private readonly phaseManager: PhaseManager,
  ) {}

  afterInit() {
    this.phaseManager.setServer(this.server);
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
  }

  private isHost(socket: Socket, roomCode: string) {
    const room = this.roomService.getRoom(roomCode);
    return room && room.hostId === socket.id;
  }

  private emitRoomPlayers(roomCode: string) {
    const room = this.roomService.getRoom(roomCode);
    if (room) {
      this.server.to(roomCode).emit('room:updatePlayers', room.players);
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
    data: { avatarKey: number; username: string; roomCode?: string },
  ) {
    if (
      !this.validateString(data?.username, 30) ||
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
    );
    this.logger.log(`Room created: ${room.roomCode}`);
    await socket.join(room.roomCode);
    this.emitRoomPlayers(room.roomCode);
    return room;
  }

  @SubscribeMessage('rq_gm:connectGmRoom')
  async handleConnectGmRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; gmRoomId: string },
  ) {
    if (
      !this.validateRoomCode(data) ||
      !this.validateString(data?.gmRoomId, 50)
    )
      return;

    const room = this.roomService.getRoom(data.roomCode);
    if (!room) return;

    // GM reconnection: update hostId to new socket
    if (this.roomService.isGmReconnection(data.roomCode, socket.id)) {
      this.roomService.reconnectGm(data.roomCode, socket.id);
      this.logger.log(`GM reconnected to room ${data.roomCode}`);
    }

    await socket.join(data.gmRoomId);
    this.phaseManager.setGmRoom(data.roomCode, data.gmRoomId);
    socket.emit('gm:connected', {
      roomCode: data.roomCode,
      gmRoomId: data.gmRoomId,
      message: 'GM connected successfully',
    });
  }

  @SubscribeMessage('rq_player:joinRoom')
  async handleJoinRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: { roomCode: string; avatarKey: number; username: string },
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
        message: 'Successfully joined room',
      };
    } else {
      return { success, playerId: socket.id, message: 'Unable to join room' };
    }
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
      this.server
        .to(data.playerId)
        .emit('player:approved', this.roomService.getRoom(data.roomCode));
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

    socket.emit('room:updatePlayers', players);
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
      const players = this.roomService.getPlayers(data.roomCode);

      this.emitRoomPlayers(data.roomCode);

      const eliminatedPlayer = players.find((p) => p.id === data.playerId);
      if (eliminatedPlayer) {
        this.server.to(data.roomCode).emit('gm:nightAction', {
          step: 'gm_elimination',
          action: 'eliminate',
          message: `GM đã loại bỏ ${eliminatedPlayer.username}: ${data.reason}`,
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
    socket.emit(
      'room:updatePlayers',
      this.roomService.getPlayers(data.roomCode),
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
        const approvedPlayers = room.players.filter(
          (player) => player.status === 'approved',
        );
        this.phaseManager.initGameState(
          data.roomCode,
          approvedPlayers,
          data.roomCode,
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
    @MessageBody() data: { roomCode: string; targetId: string },
  ) {
    if (!this.validateRoomCode(data) || !this.validateString(data?.targetId)) {
      return;
    }
    this.phaseManager.handleVotingResponse(
      data.roomCode,
      socket.id,
      data.targetId,
    );
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
