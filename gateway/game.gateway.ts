import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomService } from '../service/room.service';
import { Player, Role } from '../types';
import { Injectable } from '@nestjs/common';
import { PhaseManager } from '../service/phase-manager.service';

@WebSocketGateway({
  cors: {
    origin: [`http://localhost:${process.env.PORT ?? 4000}`],
    credentials: true,
  },
})
@Injectable()
export class GameGateway implements OnGatewayInit {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly roomService: RoomService,
    private readonly phaseManager: PhaseManager,
  ) {}

  afterInit() {
    this.phaseManager.setServer(this.server);
  }

  @SubscribeMessage('rq_gm:createRoom')
  async handleCreateRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { avatarKey: number; username: string },
  ) {
    const room = this.roomService.createRoom(
      socket.id,
      data.avatarKey,
      data.username,
    );
    await socket.join(room.roomCode);

    this.server.to(room.roomCode).emit('room:updatePlayers', room.players);
    return room;
  }

  @SubscribeMessage('rq_gm:connectGmRoom')
  async handleConnectGmRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; gmRoomId: string },
  ) {
    const room = this.roomService.getRoom(data.roomCode);
    if (!room) {
      return;
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
    const player: Player = {
      id: socket.id,
      avatarKey: data.avatarKey,
      username: data.username,
      status: 'pending',
    };
    const success = this.roomService.addPlayer(data.roomCode, player);

    const response = {
      success,
      playerId: socket.id,
      message: '',
    };

    if (success) {
      await socket.join(data.roomCode);
      this.server
        .to(data.roomCode)
        .emit(
          'room:updatePlayers',
          this.roomService.getRoom(data.roomCode)?.players || [],
        );
      response.message = 'Successfully joined room';
    } else {
      response.message = 'Unable to join room';
    }
    return response;
  }

  @SubscribeMessage('rq_gm:approvePlayer')
  handleApprovePlayer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; playerId: string },
  ) {
    const room = this.roomService.getRoom(data.roomCode);
    if (!room || room.hostId !== socket.id) {
      socket.emit('room:approvePlayerError', { message: 'Not authorized.' });
      return;
    }
    const success = this.roomService.approvePlayer(
      data.roomCode,
      data.playerId,
    );
    if (success) {
      this.server.to(data.roomCode).emit('room:updatePlayers', room.players);
      this.server.to(data.playerId).emit('player:approved', room);
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
    const room = this.roomService.getRoom(data.roomCode);
    if (!room || room.hostId !== socket.id) {
      socket.emit('room:rejectPlayerError', { message: 'Not authorized.' });
      return;
    }
    const success = this.roomService.rejectPlayer(data.roomCode, data.playerId);
    if (success) {
      this.server.to(data.roomCode).emit('room:updatePlayers', room.players);

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
    const room = this.roomService.getRoom(data.roomCode);
    if (!room || room.hostId !== socket.id) {
      socket.emit('room:updatePlayersError', { message: 'Not authorized.' });
      return;
    }
    const players = this.roomService.getPlayers(data.roomCode);
    socket.emit('room:updatePlayers', players);
  }

  @SubscribeMessage('rq_player:getPlayers')
  handlePlayerGetPlayers(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    const players = this.roomService.getPlayers(data.roomCode);
    socket.emit('room:updatePlayers', players);
  }

  @SubscribeMessage('rq_gm:randomizeRoles')
  handleRandomizeRoles(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; roles: Role[] },
  ) {
    const room = this.roomService.getRoom(data.roomCode);

    if (!room || room.hostId !== socket.id) {
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
    ];
    if (!data.roles.every((role) => validRoles.includes(role))) {
      return 'Invalid roles provided';
    }
    const success = this.roomService.randomizeRoles(
      data.roomCode,
      data.roles as any as import('../types').Role[],
    );

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
    } else {
      socket.emit('room:randomizeRolesError', {
        message: 'Unable to randomize roles',
      });
      return 'Unable to randomize roles';
    }
  }

  @SubscribeMessage('rq_player:ready')
  handlePlayerReady(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    const room = this.roomService.getRoom(data.roomCode);
    const success = this.roomService.playerReady(data.roomCode, socket.id);

    if (room) {
      this.server.to(data.roomCode).emit('room:updatePlayers', room.players);
      if (success) {
        socket.emit('player:readySuccess', { roomCode: data.roomCode });
        this.server.to(data.roomCode).emit('room:readySuccess');
        const approvedPlayers = room.players.filter(
          (player) => player.status === 'approved',
        );

        // Get GM room ID if exists
        const gmRoomId = `gm_${data.roomCode}`;

        this.phaseManager.initGameState(
          data.roomCode,
          approvedPlayers,
          gmRoomId,
        );
      }
    }
  }

  @SubscribeMessage('rq_gm:nextPhase')
  handleNextPhase(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    const state = this.phaseManager['gameStates'].get(data.roomCode);
    if (!state) {
      socket.emit('room:phaseError', { message: 'Game state not found.' });
      return;
    }
    switch (state.phase) {
      case 'night':
        state.phase = 'day';
        this.phaseManager.startDayPhase(data.roomCode);
        break;
      case 'day':
        state.phase = 'voting';
        this.phaseManager.startVotingPhase(data.roomCode);
        break;
      case 'voting':
        this.phaseManager.checkWinCondition(data.roomCode);
        break;
      case 'conclude':
      case null:
        state.phase = 'night';
        this.phaseManager.startNightPhase(data.roomCode);
        break;
      default:
        break;
    }
  }

  @SubscribeMessage('night:werewolf-action:done')
  handleWerewolfActionDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; targetId: string },
  ) {
    this.phaseManager.handleRoleResponse(data.roomCode, socket.id, {
      targetId: data.targetId,
      vote: 'werewolf',
    });
  }

  @SubscribeMessage('night:seer-action:done')
  handleSeerActionDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; targetId: string },
  ) {
    this.phaseManager.handleRoleResponse(data.roomCode, socket.id, {
      targetId: data.targetId,
      vote: 'seer',
    });
  }

  @SubscribeMessage('night:witch-action:done')
  handleWitchActionDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      heal: boolean;
      poisonTargetId?: string;
    },
  ) {
    this.phaseManager.handleRoleResponse(data.roomCode, socket.id, {
      heal: data.heal,
      poisonTargetId: data?.poisonTargetId,
      vote: 'witch',
    });
  }

  @SubscribeMessage('night:bodyguard-action:done')
  handleBodyguardActionDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; targetId: string },
  ) {
    this.phaseManager.handleRoleResponse(data.roomCode, socket.id, {
      targetId: data.targetId,
      vote: 'bodyguard',
    });
  }

  @SubscribeMessage('night:hunter-action:done')
  handleHunterActionDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; targetId?: string },
  ) {
    this.phaseManager.handleRoleResponse(data.roomCode, socket.id, {
      targetId: data.targetId,
      vote: 'hunter',
    });
  }

  @SubscribeMessage('voting:done')
  handleVotingDone(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; targetId: string },
  ) {
    this.phaseManager.handleVotingResponse(
      data.roomCode,
      socket.id,
      data.targetId,
    );
  }
}
