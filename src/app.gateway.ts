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
    origin: process.env.ALLOWED_ORIGINS?.split(',').map((origin) =>
      origin.trim(),
    ),
    credentials: true,
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
