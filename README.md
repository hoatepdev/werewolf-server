# Masoi Server

A scalable, real-time backend for the 5Star Wolves (Ma Sói) game, built with [NestJS](https://nestjs.com/) and Socket.IO.

## Features

- Real-time multiplayer game logic for Ma Sói (Werewolf)
- Room management and player approval system
- Game phase and role management (werewolf, seer, witch, bodyguard, hunter, etc.)
- WebSocket gateway for client-server communication
- Written in TypeScript, modular and testable

## Project Structure

- `src/` - Main source code
  - `app.module.ts` - Main NestJS module
  - `main.ts` - Entry point
  - `app.gateway.ts` - WebSocket gateway
  - `service/phase-manager.service.ts` - Game phase and role logic
  - `service/room.service.ts` - Room and player management
  - `types.ts` - Shared types
- `test/` - Test files

## Getting Started

### Install dependencies

```bash
npm install
```

### Run the server

```bash
# Development
yarn start:dev
# or
npm run start:dev

# Production
npm run build
npm run start:prod
```

### Run tests

```bash
npm run test
npm run test:e2e
npm run test:cov
```

## WebSocket API

- The server exposes a WebSocket API for room management, player actions, and game phases.
- See `src/gateway/game.gateway.ts` for event details.

## Technologies

- [NestJS](https://nestjs.com/) (v11)
- [Socket.IO](https://socket.io/)
- TypeScript

## License

This project is UNLICENSED. All rights reserved.
