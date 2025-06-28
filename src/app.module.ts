import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppGateway } from './app.gateway';
import { GameGateway } from '../gateway/game.gateway';
import { RoomService } from '../service/room.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, AppGateway, GameGateway, RoomService],
})
export class AppModule {}
