# Masoi Server

A scalable, real-time backend for the 5Star Werewolf (Ma Sói) game, built with [NestJS](https://nestjs.com/) and Socket.IO.

## Features

- Real-time multiplayer game logic for Ma Sói (Werewolf)
- Room management and player approval system
- Game phase and role management (werewolf, seer, witch, bodyguard, hunter, tanner)
- WebSocket gateway for client-server communication
- In-memory state management (no database required)
- Written in TypeScript, modular and testable

## Environment Variables

Create a `.env` file in the root directory:

```env
PORT=4001
# CORS configuration (development)
CLIENT_URL=http://localhost:4000
```

## Architecture

### In-Memory State
- Uses `Map<string, Room>` for room storage
- No database — all game state lives in memory
- Rooms are automatically cleaned up when empty

### Core Services

**`service/room.service.ts`**
- Room CRUD operations
- Player join/leave/approval
- Role randomization and assignment
- Win condition checking

**`service/phase-manager.service.ts`**
- Phase transition logic (night → day → voting → conclude)
- Role action resolution (werewolf kill, witch heal/poison, etc.)
- Death processing and hunter trigger logic

### WebSocket Gateway (`gateway/game.gateway.ts`)

#### GM Events
| Event | Description |
|-------|-------------|
| `rq_gm:createRoom` | Create new game room |
| `rq_gm:joinRoom` | GM joins created room |
| `rq_gm:approvePlayer` | Approve waiting player |
| `rq_gm:removePlayer` | Remove player from room |
| `rq_gm:randomizeRole` | Randomize and assign roles |
| `rq_gm:startGame` | Start the game (after ready check) |
| `rq_gm:resetRoom` | Reset room to lobby state |
| `rq_gm:concludePhase` | Conclude current phase (manual override) |

#### Player Events
| Event | Description |
|-------|-------------|
| `rq_player:joinRoom` | Player joins by room code |
| `rq_player:leaveRoom` | Player leaves room |
| `rq_player:ready` | Toggle ready status |
| `rq_player:updateInfo` | Update name/avatar |
| `game:vote` | Cast vote during voting phase |

#### Night Action Events
| Event | Description |
|-------|-------------|
| `night:werewolf-action:done` | Werewolf target selection |
| `night:seer-action:done` | Seer role check |
| `night:witch-action:done` | Witch heal or poison |
| `night:bodyguard-action:done` | Bodyguard protection |

### Game Flow Diagram
```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Create    │ -> │    Join     │ -> │   Approve   │
│    Room     │    │   Players   │    │   Players   │
└─────────────┘    └─────────────┘    └─────────────┘
                                               │
                                               v
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│    Night    │ <- │ Randomize   │ -> │   Ready     │
│   Actions   │    │    Roles    │    │   Up        │
└─────────────┘    └─────────────┘    └─────────────┘
       │                                     │
       v                                     v
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│    Day      │ -> │   Voting    │ -> │  Conclude   │
│ Discussion  │    │   Phase     │    │   Check     │
└─────────────┘    └─────────────┘    └─────────────┘
       │                                     │
       └─────────────► Loop ◄───────────────┘
                     (until win)
```

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
# Development (with watch mode)
yarn start:dev
# or
npm run start:dev

# Production
npm run build
npm run start:prod
```

The server runs on port 4001 by default.

### Run tests

```bash
npm run test
npm run test:e2e
npm run test:cov
```

## WebSocket API

The server uses Socket.IO with the following namespace: `/game`.

### Broadcast Events (Server → All Clients)
- `game:stateUpdated` — Full room state update
- `game:phaseChanged` — Phase transition event
- `game:playerJoined` — New player joined
- `game:playerLeft` — Player disconnected
- `game:playerApproved` — Player approved by GM
- `game:playerRemoved` — Player removed by GM
- `game:roleAssigned` — Role revealed to player
- `game:dayReport` — Night results (who died)
- `game:playerDied` — Player death event
- `game:voteResult` — Voting results
- `game:concluded` — Game ended with winner

### Private Events (Server → Specific Socket)
- `game:roleRevealed` — Role info (night phase)
- `game:seerResult` — Seer investigation result
- `game:witchInfo` — Witch potion info
- `game:hunterTrigger` — Hunter must shoot

See `src/gateway/game.gateway.ts` for full event details.

## Game Roles

| Role | Team | Ability |
|------|------|---------|
| `villager` | Village | No special ability |
| `werewolf` | Werewolf | Kill one player each night |
| `seer` | Village | Check one player's role each night |
| `witch` | Village | One heal, one poison per game |
| `hunter` | Village | Kill someone when dying |
| `bodyguard` | Village | Protect one player each night |
| `tanner` | Self | Wins if voted out |

## Win Conditions

- **Village wins**: All werewolves eliminated
- **Werewolves win**: Werewolves ≥ Villagers (alive)
- **Tanner wins**: Tanner is voted out

## Technologies

- [NestJS](https://nestjs.com/) (v11) — Framework
- [Socket.IO](https://socket.io/) — WebSocket
- [TypeScript](https://www.typescriptlang.org/) — Type safety
- [Jest](https://jestjs.io/) — Testing framework

## Deployment Notes

### Memory Considerations
- All state is in-memory — server restarts lose all games
- For production, consider Redis for state persistence across multiple instances

### Scaling
- Current design supports single-instance deployment
- For horizontal scaling, implement Redis adapter for Socket.IO

### CORS
- Configure allowed origins in `gateway/game.gateway.ts`
- Set `CLIENT_URL` environment variable appropriately

## License

This project is UNLICENSED. All rights reserved.
