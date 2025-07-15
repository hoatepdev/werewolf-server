import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import 'dotenv/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((origin) =>
    origin.trim(),
  );
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });
  await app.listen(process.env.PORT ?? 4001);
}
bootstrap();
