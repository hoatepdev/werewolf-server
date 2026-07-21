# Project State

## werewolf-server

Last updated: 2025-01-21

## Current State

### Features
- NestJS 11 WebSocket backend with Socket.IO
- In-memory room management (no database)
- Game phase orchestration with transition locks
- Role-based action resolution (werewolf, seer, witch, hunter, bodyguard, tanner)
- Win condition checking after each phase
- Timer management for phase transitions
- Firebase Admin SDK integration for push notifications
- GM reconnection support with persistent IDs and tokens
- Player serialization for security (role privacy)
- Room cleanup after 2 hours of inactivity
- Unit and integration tests with Jest

### Recent Changes
- Added Firebase Admin SDK (^14.2.0) for push notifications
- Created PushNotificationService for token-based notifications
- Added player serialization functions for security
- Implemented GM reconnection with persistent IDs and tokens
- Enhanced room serialization for socket-specific data
- Updated tests for new serialization and notification features
- Added comprehensive error handling for Firebase initialization

### Technical Debt
- In-memory state management (data lost on server restart)
- No persistent storage for game history or analytics
- Room cleanup could benefit from configurable timeframes
- Some service methods could be extracted into smaller utilities

### Architecture
- `gateway/game.gateway.ts` - Main WebSocket gateway with event handlers
- `service/room.service.ts` - Room CRUD and player management
- `service/phase-manager.service.ts` - Phase transition orchestration
- `service/game-engine.ts` - Pure utilities for game logic
- `service/push-notification.service.ts` - Firebase push notifications
- `types.ts` - Shared TypeScript types

### Dependencies
- NestJS 11.1.3
- Socket.IO 4.8.1
- Firebase Admin ^14.2.0
- Jest for testing
- dotenv for environment configuration

### Known Issues
- Room state lost on server restart (by design for party game)
- Firebase configuration optional; push disabled when not configured

### Next Steps
- Consider adding optional persistent storage for analytics
- Add more comprehensive integration tests
- Consider adding rate limiting for socket events
- Monitor and optimize room cleanup intervals
