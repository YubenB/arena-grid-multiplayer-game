# Arena Grid Multiplayer Game (Socket.IO)

Realtime browser multiplayer shooter built with Node.js, Express, Socket.IO, and HTML5 Canvas.

This project now includes room-based scaling, mobile controls, bots, respawn flow, and a lightweight HUD suited for both desktop and mobile play.

## Features

- Realtime multiplayer using Socket.IO
- Room architecture with up to 40 players per room
- Server-authoritative movement and projectile handling
- Combat system with HP, kills/deaths, and respawn
- Bot players with simple hunt/shoot behavior
- Desktop and touch controls (dual joystick on mobile)
- Collapsible leaderboard and death action overlay

## Tech Stack

- Node.js
- Express
- Socket.IO
- Vanilla JavaScript + Canvas API

## Project Structure

- `backend.js`: game server, room logic, combat, bot AI
- `public/index.html`: UI layout and styles
- `public/js/frontend.js`: rendering, inputs, client networking
- `public/js/classes/`: render classes for player/projectiles

## Prerequisites

- Node.js 18+ (recommended)
- npm (bundled with Node.js)

## How To Run

1. Open a terminal in this folder (`multiplayer-game`).
2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
node backend.js
```

4. Open your browser at:

```text
http://localhost:3000
```

5. Open additional tabs/devices to test multiplayer.

## Configuration

Main server configuration is in `backend.js` under `CONFIG`, including:

- `port` (default: 3000)
- `roomMaxPlayers` (default: 40)
- `botsPerRoom`
- `worldWidth` / `worldHeight`
- combat and cooldown tuning values

## Controls

Desktop:

- Move: W A S D
- Aim and shoot: mouse / pointer input

Mobile:

- Left joystick: movement
- Right joystick: aim + auto-fire direction

## Troubleshooting

- If the server fails to start because the port is in use, change `CONFIG.port` in `backend.js`.
- If controls feel stuck after tab switch/loss of focus, refocus the game tab and reconnect.
- If mobile UI looks off after keyboard close, refresh once to reset viewport state.

## Credits

- Original tutorial and base concept: Chris Courses
- Tutorial link: https://www.youtube.com/watch?v=Wcvqnx14cZA
