import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppGateway } from './app.gateway';
import { GameGateway } from '../gateway/game.gateway';
import { RoomService } from '../service/room.service';
import { PhaseManager } from '../service/phase-manager.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, AppGateway, GameGateway, RoomService, PhaseManager],
})
export class AppModule {}
