import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomService } from '../service/room.service';
import { Player, Role } from '../types';
import { Injectable } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: [`http://localhost:${process.env.PORT ?? 4000}`],
    credentials: true,
  },
})
@Injectable()
export class GameGateway {
  @WebSocketServer()
  server: Server;

  constructor(private readonly roomService: RoomService) {}

  @SubscribeMessage('rq_gm:createRoom')
  handleCreateRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { avatarKey: number; username: string },
  ) {
    const room = this.roomService.createRoom(
      socket.id,
      data.avatarKey,
      data.username,
    );
    socket.join(room.roomCode);
    // socket.emit('room:createRoom', room);

    this.server.to(room.roomCode).emit('room:updatePlayers', room.players);
    return room;
  }

  @SubscribeMessage('rq_player:joinRoom')
  handleJoinRoom(
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
      socket.join(data.roomCode);
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

  @SubscribeMessage('rq_gm:nextPhase')
  handleNextPhase(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    const phase = this.roomService.nextPhase(data.roomCode);
    if (phase) {
      const room = this.roomService.getRoom(data.roomCode);
      if (room) {
        this.server.to(room.roomCode).emit('room:phaseChanged', phase);
      }
    } else {
      socket.emit('room:phaseError', { message: 'Unable to change phase.' });
    }
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

      // Optionally, notify the rejected player
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
      'idiot',
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
      console.log('⭐ updatedRoom', updatedRoom);

      if (updatedRoom) {
        updatedRoom.players
          .filter((player) => player.status === 'approved')
          .forEach((player) => {
            this.server
              .to(player.id)
              .emit('player:assignedRole', { role: player.role });
          });
        this.server
          .to(updatedRoom.roomCode)
          .emit('room:phaseChanged', updatedRoom.phase);
        this.server
          .to(updatedRoom.roomCode)
          .emit('room:updatePlayers', updatedRoom.players);
      }
      // socket.emit('gm:randomizeRolesSuccess', { roomCode: data.roomCode });
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
    console.log('⭐ room', room);
    const success = this.roomService.playerReady(data.roomCode, socket.id);
    if (success) {
      socket.emit('player:readySuccess', { roomCode: data.roomCode });
      this.server.to(data.roomCode).emit('room:readySuccess');
      // this.server.to(data.roomCode).emit('room:phaseChanged', room?.phase);
      // this.server.to(data.roomCode).emit('room:updatePlayers', room?.players);
    }
  }
}
