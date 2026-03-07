# Masoi Server

A scalable, real-time backend for the Lunar Verdict (Ma Sói) game, built with [NestJS](https://nestjs.com/) and Socket.IO.

## Features

- Real-time multiplayer game logic for Ma Sói (Werewolf)
- Room management and player approval system
- Game phase and role management (werewolf, seer, witch, bodyguard, hunter, tanner)
- WebSocket gateway for client-server communication
- In-memory state management (no database required)
- GM and player reconnect support
- Narrative game log (night results, voting results, hunter shots, game end)
- Written in TypeScript, modular and testable

## Environment Variables

Create a `.env` file in the root directory:

```env
PORT=4001
ALLOWED_ORIGINS=http://localhost:4000
# Production: comma-separated list of allowed origins
```

## Architecture

### In-Memory State

- `RoomService`: `Map<string, Room>` — rooms expire after **2 hours** of inactivity (cleanup every 10 minutes)
- `PhaseManager`: `Map<string, GameState>` — one `GameState` per room

### Core Services

**`service/room.service.ts`**

- Room CRUD (create, get, delete)
- Player join/rejoin/approval/rejection
- Role randomization and assignment
- GM reconnect tracking (`disconnectedGmId`)
- Room TTL cleanup via `setInterval`

**`service/phase-manager.service.ts`**

- Phase transition orchestration with **transition lock** (prevents race conditions; auto-releases after 5 minutes as failsafe)
- Night phase role sequence: Bodyguard → Werewolf → Witch → Seer
- Promise-based role action waiting with per-role timeouts
- Dead/absent role simulation (random 5–10s delay to prevent timing attacks)
- Voting resolution with early completion when all alive players have voted
- Hunter death handling (blocks phase transition until hunter acts or skips)
- Game log capture (appended to `GameState.gameLog`, emitted on game end)
- Player socket ID sync on reconnect

**`service/game-engine.ts`**

Pure static utility class — no NestJS dependencies, fully unit-testable.

- `createInitialState()` — initialize `GameState`
- `prepareNightPhase()` — reset night targets, increment round
- `getBodyguardCandidates()`, `getWerewolfCandidates()`, `getSeerCandidates()`, `getWitchActionData()`
- `applyBodyguardAction()`, `applyWerewolfVotes()`, `applySeerAction()`, `applyWitchAction()`
- `resolveNightActions()` — determine deaths (bodyguard/witch save take precedence over werewolf kill; witch poison is independent)
- `recordVote()`, `resolveVoting()` — tally votes, handle tie/no_votes/tanner/hunter edge cases
- `checkWinCondition()` — villagers win (0 werewolves), werewolves win (≥ non-werewolves)
- `applyHunterShoot()` — apply hunter kill target
- `getDefaultRoleResponse()` — timeout fallback (werewolf picks random target; others skip)
- `resetVotingState()`, `resetNightState()` — cleanup between phases
- `canTransition()` — validate phase transitions

### Role Timeouts (Production)

| Role      | Timeout |
| --------- | ------- |
| Bodyguard | 30s     |
| Werewolf  | 60s     |
| Witch     | 30s     |
| Seer      | 30s     |
| Voting    | 60s     |

In test environment all timeouts are reduced to 100ms (voting: 1000ms).

### WebSocket Gateway (`gateway/game.gateway.ts`)

#### GM Events

| Event                   | Description                                |
| ----------------------- | ------------------------------------------ |
| `rq_gm:createRoom`      | Create new game room                       |
| `rq_gm:connectGmRoom`   | GM joins private GM room for notifications |
| `rq_gm:approvePlayer`   | Approve waiting player                     |
| `rq_gm:rejectPlayer`    | Reject waiting player                      |
| `rq_gm:getPlayers`      | Fetch current player list                  |
| `rq_gm:randomizeRole`   | Randomize and assign roles                 |
| `rq_gm:startGame`       | Start the game (after ready check)         |
| `rq_gm:resetRoom`       | Reset room to lobby state                  |
| `rq_gm:concludePhase`   | Conclude current phase (manual override)   |
| `rq_gm:eliminatePlayer` | GM manually eliminates a player            |
| `rq_gm:revivePlayer`    | GM manually revives a player               |

#### Player Events

| Event                  | Description                          |
| ---------------------- | ------------------------------------ |
| `rq_player:joinRoom`   | Player joins by room code            |
| `rq_player:rejoinRoom` | Reconnect using `persistentPlayerId` |
| `rq_player:leaveRoom`  | Player leaves room                   |
| `rq_player:ready`      | Toggle ready status                  |
| `rq_player:updateInfo` | Update name/avatar                   |
| `game:vote`            | Cast vote during voting phase        |

#### Night Action Events

| Event                         | Description               |
| ----------------------------- | ------------------------- |
| `night:werewolf-action:done`  | Werewolf target selection |
| `night:seer-action:done`      | Seer role check           |
| `night:witch-action:done`     | Witch heal or poison      |
| `night:bodyguard-action:done` | Bodyguard protection      |
| `night:hunter-action:done`    | Hunter death shoot        |

#### Server → Client Events

| Event                     | Audience  | Description                      |
| ------------------------- | --------- | -------------------------------- |
| `room:updatePlayers`      | Room      | Player list update               |
| `room:playerDisconnected` | Room      | Player disconnected notification |
| `player:approved`         | Single    | Player approved by GM            |
| `player:rejected`         | Single    | Player rejected by GM            |
| `player:rejoined`         | Single    | Reconnect successful             |
| `game:phaseChanged`       | Room      | Phase transition                 |
| `game:nightResult`        | Room      | Night deaths resolved            |
| `game:hunterShoot`        | Room      | Hunter must choose a target      |
| `game:hunterShot`         | Room      | Hunter fired announcement        |
| `game:gameEnded`          | Room      | Game over with winner + game log |
| `game:timerStart`         | Room/Role | Countdown started                |
| `game:timerStop`          | Room/Role | Countdown stopped                |
| `game:timerSync`          | Single    | Timer sync on reconnect          |
| `night:seer-result`       | Single    | Seer investigation result        |
| `night:action-timeout`    | Single    | Player timed out                 |
| `votingResult`            | Room      | Voting resolved                  |
| `gm:nightAction`          | GM Room   | Night step updates for GM        |
| `gm:votingAction`         | GM Room   | Voting updates for GM            |
| `gm:gameEnded`            | GM Room   | Game ended summary for GM        |
| `gm:hunterAction`         | GM Room   | Hunter triggered/resolved        |
| `gm:connected`            | Single    | GM joined GM room successfully   |

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

```
werewolf-server/
├── src/
│   ├── app.module.ts          # NestJS module (all providers)
│   ├── main.ts                # Entry point
│   └── *.spec.ts              # Unit tests
├── gateway/
│   └── game.gateway.ts        # Main WebSocket gateway (all game events)
├── service/
│   ├── game-engine.ts         # Pure static game logic + types
│   ├── phase-manager.service.ts # Phase orchestration
│   └── room.service.ts        # Room/player management
├── types.ts                   # Shared types: Role, Phase, Player, Room
└── test/
    └── *.e2e-spec.ts          # E2E tests
```

Note: `gateway/` and `service/` live at the server root alongside `src/`, not inside `src/`.

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

# Single test file
npx jest --testPathPattern="phase-manager"
```

## Game Roles

| Role        | Team     | Ability                                                                          |
| ----------- | -------- | -------------------------------------------------------------------------------- |
| `villager`  | Village  | No special ability                                                               |
| `werewolf`  | Werewolf | Kill one player each night                                                       |
| `seer`      | Village  | Check one player's role each night                                               |
| `witch`     | Village  | One heal + one poison per game (can't self-poison, can't use both in same night) |
| `hunter`    | Village  | Kill someone when dying (night or vote)                                          |
| `bodyguard` | Village  | Protect one player each night (can't protect same person twice in a row)         |
| `tanner`    | Self     | Wins if voted out                                                                |

## Win Conditions

- **Village wins**: All werewolves eliminated
- **Werewolves win**: Werewolves ≥ non-werewolves (alive count)
- **Tanner wins**: Tanner is voted out

## Technologies

- [NestJS](https://nestjs.com/) (v11) — Framework
- [Socket.IO](https://socket.io/) — WebSocket
- [TypeScript](https://www.typescriptlang.org/) — Type safety
- [Jest](https://jestjs.io/) — Testing framework

## Deployment Notes

### Docker

```bash
docker-compose up --build   # Build and run server container (exposes port 4001)
```

The server `Dockerfile` is a multi-stage build; production entry point is `node dist/src/main.js`.

### Memory Considerations

- All state is in-memory — server restarts lose all games
- Rooms are automatically cleaned up after 2 hours of inactivity
- For production persistence, consider Redis for state across multiple instances

### Scaling

- Current design supports single-instance deployment
- For horizontal scaling, implement Redis adapter for Socket.IO

### CORS

- Configure allowed origins via `ALLOWED_ORIGINS` environment variable (comma-separated)
- Defaults to `*` if not set

## License

This project is UNLICENSED. All rights reserved.
