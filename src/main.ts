import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: [`http://localhost:${process.env.PORT ?? 4000}`],
    credentials: true,
  });
  await app.listen(process.env.PORT ?? 4001);
}
bootstrap();
