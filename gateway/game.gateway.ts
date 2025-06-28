import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomService } from '../service/room.service';
import { Player } from '../types';
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

  @SubscribeMessage('gm:createRoom')
  handleCreateRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { name: string },
  ) {
    console.log('⭐ gm:createRoom', socket.id, data.name);
    const room = this.roomService.createRoom(socket.id, data.name);
    socket.join(room.roomCode);
    socket.emit('room:createRoom', room);

    this.server.to(room.roomCode).emit('room:updatePlayers', room.players);
  }

  @SubscribeMessage('player:joinRoom')
  handleJoinRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; name: string },
  ) {
    console.log('⭐ player:joinRoom', data);
    const player: Player = {
      id: socket.id,
      name: data.name,
      status: 'pending',
      alive: true,
    };
    const success = this.roomService.addPlayer(data.roomCode, player);
    console.log('⭐ player:joinRoom success', success);
    if (success) {
      socket.join(data.roomCode);
      this.server
        .to(data.roomCode)
        .emit(
          'room:updatePlayers',
          this.roomService.getRoom(data.roomCode)?.players || [],
        );
    } else {
      socket.emit('room:joinRoomError', { message: 'Unable to join room.' });
    }
  }

  @SubscribeMessage('gm:startGame')
  handleStartGame(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    const room = this.roomService.getRoom(data.roomCode);
    console.log('⭐ room', room);

    if (!room || room.hostId !== socket.id) {
      socket.emit('room:startRoomError', { message: 'Not authorized.' });
      socket.emit('gm:startGameError', { message: 'Not authorized.' });
      return;
    }
    const success = this.roomService.startGame(data.roomCode);
    console.log('⭐ success', success);

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
      socket.emit('gm:startGameSuccess', { roomCode: data.roomCode });
    } else {
      socket.emit('room:startRoomError', { message: 'Unable to start game.' });
      socket.emit('gm:startGameError', { message: 'Unable to start game.' });
    }
  }

  @SubscribeMessage('gm:nextPhase')
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

  @SubscribeMessage('gm:approvePlayer')
  handleApprovePlayer(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string; playerId: string },
  ) {
    const room = this.roomService.getRoom(data.roomCode);
    console.log('⭐ gm:approvePlayer', room, socket.id, room?.hostId);
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

  @SubscribeMessage('gm:rejectPlayer')
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

  @SubscribeMessage('gm:getPlayers')
  handleGetPlayers(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    console.log('⭐ gm:getPlayers', data);
    const room = this.roomService.getRoom(data.roomCode);
    console.log('⭐ room', room, room?.hostId, socket.id);
    if (!room || room.hostId !== socket.id) {
      socket.emit('room:getPlayersError', { message: 'Not authorized.' });
      return;
    }
    const players = this.roomService.getPlayers(data.roomCode);
    console.log('⭐ players', players);
    socket.emit('room:getPlayers', players);
  }
}
