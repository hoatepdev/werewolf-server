import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import 'dotenv/config';

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: false,
  },
})
export class AppGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  handleConnection() {
    // handle new client connection
  }

  handleDisconnect() {
    // handle client disconnect
  }
}
