# Project State

## werewolf-server

Last updated: 2026-07-23

## Current State

### Features
- NestJS 11 Socket.IO backend with in-memory room and game state
- Room codes are six-digit numeric values with centralized validation
- Role engine supports villager, werewolf, seer, witch, hunter, bodyguard, tanner, and Cupid
- Phase manager orchestrates first-night Cupid pairing, night role order, voting, hunter shots, and lover death cascades
- Redacted in-progress game logs are serialized for players while hidden night details remain private until game end
- GM eliminate/revive flows return structured acknowledgements and append GM log entries
- Firebase push notifications cover player approval/rejection, room reset, day start, and GM phase prompts when configured
- Reconnect flows sync state, timers, voting progress, push registration, and Cupid lover snapshots
- Jest coverage tracks game-engine, gateway, and room-service behavior

### Recent Changes
- Added Cupid role, lover pairing, `night:cupid-action:done`, `night:cupid-linked`, and lover cascade deaths
- Added redacted player game-log delivery during active game flows
- Added lobby and phase push notifications plus token lookup/pruning helpers
- Replaced alphanumeric room codes with six-digit numeric room codes
- Reset stale readiness on approval/room reset and require assigned roles before readying
- Added structured GM eliminate/revive acknowledgements and GM action logging
- Restored voting progress on reconnect and expanded push registration authorization

### Technical Debt
- All room, lover, game-log, and push-token state remains in memory and is lost on restart
- Six-digit room codes have a smaller collision space, mitigated by retry checks
- Gateway remains a high-coupling integration surface

### Known Issues
- Firebase configuration is optional; push notifications are disabled when not configured
