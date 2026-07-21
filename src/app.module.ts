import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GameGateway } from '../gateway/game.gateway';
import { RoomService } from '../service/room.service';
import { PhaseManager } from '../service/phase-manager.service';
import { PushNotificationService } from '../service/push-notification.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, GameGateway, RoomService, PhaseManager, PushNotificationService],
})
export class AppModule {}
