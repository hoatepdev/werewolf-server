import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import 'dotenv/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : '*';
  app.enableCors({
    origin: allowedOrigins,
    credentials: false,
  });
  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
