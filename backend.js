const express = require('express')
const app = express()

// socket.io setup
const http = require('http')
const server = http.createServer(app)
const { Server } = require('socket.io')
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 20000,
  transports: ['websocket'],
  perMessageDeflate: false
})

const CONFIG = {
  port: 3000,
  tickRateMs: 16,
  stateBroadcastMs: 50,
  roomMaxPlayers: 40,
  botsPerRoom: 3,
  worldWidth: 4096,
  worldHeight: 2304,
  playerSpeed: 5,
  botSpeed: 2.9,
  botDetectionRange: 1400,
  playerRadius: 12,
  projectileRadius: 5,
  projectileSpeed: 8,
  projectileDamage: 34,
  shotCooldownMs: 160,
  respawnMs: 2200,
  maxProjectilesPerPlayer: 18
}

app.use(express.static('public'))

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html')
})

const rooms = {}
const socketToRoom = {}

function createRoom(roomId) {
  const room = {
    id: roomId,
    sockets: new Set(),
    players: {},
    projectiles: {},
    projectileId: 0,
    lastBroadcastAt: 0
  }

  for (let index = 1; index <= CONFIG.botsPerRoom; index++) {
    const botId = `bot-${roomId}-${index}`
    room.players[botId] = createPlayer(`BOT-${index}`, { isBot: true })
  }

  return room
}

function randomSpawn(radius) {
  return {
    x: radius + Math.random() * (CONFIG.worldWidth - radius * 2),
    y: radius + Math.random() * (CONFIG.worldHeight - radius * 2)
  }
}

function respawnPlayer(player) {
  const spawn = randomSpawn(player.radius)
  player.x = spawn.x
  player.y = spawn.y
  player.hp = player.maxHp
  player.isAlive = true
  player.respawnAt = 0
}

function buildUsername(rawUsername = '') {
  const trimmed = String(rawUsername).trim()
  if (!trimmed) return `Player-${Math.floor(Math.random() * 10000)}`
  return trimmed.slice(0, 20)
}

function createPlayer(rawUsername, options = {}) {
  const spawn = randomSpawn(CONFIG.playerRadius)
  const isBot = Boolean(options.isBot)

  return {
    x: spawn.x,
    y: spawn.y,
    color: `hsl(${360 * Math.random()}, 100%, 50%)`,
    radius: CONFIG.playerRadius,
    sequenceNumber: 0,
    score: 0,
    kills: 0,
    deaths: 0,
    hp: 100,
    maxHp: 100,
    isAlive: true,
    respawnAt: 0,
    lastShotAt: 0,
    username: buildUsername(rawUsername),
    isBot,
    inputX: 0,
    inputY: 0,
    aiMoveAngle: Math.random() * Math.PI * 2,
    aiNextTurnAt: 0
  }
}

function normalizeInputVector(inputX, inputY) {
  const x = Number.isFinite(inputX) ? inputX : 0
  const y = Number.isFinite(inputY) ? inputY : 0
  const clampedX = Math.max(-1, Math.min(1, x))
  const clampedY = Math.max(-1, Math.min(1, y))
  const distance = Math.hypot(clampedX, clampedY)

  if (distance <= 1) {
    return {
      x: clampedX,
      y: clampedY
    }
  }

  return {
    x: clampedX / distance,
    y: clampedY / distance
  }
}

function clampPlayerWithinWorld(player) {
  const playerSides = {
    left: player.x - player.radius,
    right: player.x + player.radius,
    top: player.y - player.radius,
    bottom: player.y + player.radius
  }

  if (playerSides.left < 0) player.x = player.radius
  if (playerSides.right > CONFIG.worldWidth)
    player.x = CONFIG.worldWidth - player.radius
  if (playerSides.top < 0) player.y = player.radius
  if (playerSides.bottom > CONFIG.worldHeight)
    player.y = CONFIG.worldHeight - player.radius
}

function countProjectilesByPlayer(room, playerId) {
  let activeProjectileCount = 0
  for (const projectileId in room.projectiles) {
    if (room.projectiles[projectileId].playerId === playerId) {
      activeProjectileCount++
    }
  }

  return activeProjectileCount
}

function spawnProjectile(room, shooterId, angle, now) {
  const shooter = room.players[shooterId]
  if (!shooter || !shooter.isAlive) return false
  if (now - shooter.lastShotAt < CONFIG.shotCooldownMs) return false

  const activeProjectileCount = countProjectilesByPlayer(room, shooterId)
  if (activeProjectileCount >= CONFIG.maxProjectilesPerPlayer) return false

  shooter.lastShotAt = now
  room.projectileId++

  const velocity = {
    x: Math.cos(angle) * CONFIG.projectileSpeed,
    y: Math.sin(angle) * CONFIG.projectileSpeed
  }

  room.projectiles[room.projectileId] = {
    x: shooter.x,
    y: shooter.y,
    radius: CONFIG.projectileRadius,
    velocity,
    playerId: shooterId
  }

  return true
}

function getClosestHumanTarget(bot, players) {
  let closestTarget = null
  let closestDistance = Infinity

  for (const playerId in players) {
    const player = players[playerId]
    if (!player.isAlive || player.isBot) continue

    const distance = Math.hypot(player.x - bot.x, player.y - bot.y)
    if (distance < closestDistance && distance <= CONFIG.botDetectionRange) {
      closestDistance = distance
      closestTarget = player
    }
  }

  return closestTarget
}

function runBotAI(room, now) {
  for (const playerId in room.players) {
    const bot = room.players[playerId]
    if (!bot.isBot || !bot.isAlive) continue

    const target = getClosestHumanTarget(bot, room.players)

    if (target) {
      const dx = target.x - bot.x
      const dy = target.y - bot.y
      const distance = Math.hypot(dx, dy)

      if (distance > 36) {
        const chaseAngle = Math.atan2(dy, dx)
        const strafeDrift = Math.sin(now / 500 + playerId.length) * 0.35
        bot.x += Math.cos(chaseAngle + strafeDrift) * CONFIG.botSpeed
        bot.y += Math.sin(chaseAngle + strafeDrift) * CONFIG.botSpeed
        clampPlayerWithinWorld(bot)
      }

      const aimAngle = Math.atan2(target.y - bot.y, target.x - bot.x)
      spawnProjectile(room, playerId, aimAngle, now)
      continue
    }

    if (now >= bot.aiNextTurnAt) {
      bot.aiMoveAngle = Math.random() * Math.PI * 2
      bot.aiNextTurnAt = now + 450 + Math.floor(Math.random() * 950)
    }

    bot.x += Math.cos(bot.aiMoveAngle) * CONFIG.botSpeed * 0.6
    bot.y += Math.sin(bot.aiMoveAngle) * CONFIG.botSpeed * 0.6
    clampPlayerWithinWorld(bot)
  }
}

function getAvailableRoomId() {
  const roomIds = Object.keys(rooms)

  for (const roomId of roomIds) {
    const room = rooms[roomId]
    if (room.sockets.size < CONFIG.roomMaxPlayers) {
      return roomId
    }
  }

  const nextRoomId = `room-${roomIds.length + 1}`
  rooms[nextRoomId] = createRoom(nextRoomId)
  return nextRoomId
}

function getRoomBySocket(socketId) {
  const roomId = socketToRoom[socketId]
  if (!roomId) return null
  return rooms[roomId] || null
}

function countAlivePlayers(players) {
  let alive = 0
  for (const id in players) {
    if (players[id].isAlive && !players[id].isBot) alive++
  }
  return alive
}

function buildRoomStats(room) {
  return {
    roomId: room.id,
    playersConnected: room.sockets.size,
    playersAlive: countAlivePlayers(room.players),
    maxPlayers: CONFIG.roomMaxPlayers,
    world: {
      width: CONFIG.worldWidth,
      height: CONFIG.worldHeight
    }
  }
}

function emitRoomState(roomId) {
  const room = rooms[roomId]
  if (!room) return

  io.to(roomId).emit('stateUpdate', {
    players: room.players,
    projectiles: room.projectiles,
    stats: buildRoomStats(room)
  })
}

function removeProjectilesByPlayer(room, playerId) {
  for (const projectileId in room.projectiles) {
    if (room.projectiles[projectileId].playerId === playerId) {
      delete room.projectiles[projectileId]
    }
  }
}

function removePlayerFromRoom(room, playerId) {
  if (!room.players[playerId]) return
  delete room.players[playerId]
  removeProjectilesByPlayer(room, playerId)
}

function removeSocketFromRoom(socketId) {
  const roomId = socketToRoom[socketId]
  if (!roomId || !rooms[roomId]) return

  const room = rooms[roomId]
  removePlayerFromRoom(room, socketId)
  room.sockets.delete(socketId)
  delete socketToRoom[socketId]

  if (room.sockets.size === 0) {
    delete rooms[roomId]
    return
  }

  emitRoomState(roomId)
}

io.on('connection', (socket) => {
  const roomId = getAvailableRoomId()
  const room = rooms[roomId]

  room.sockets.add(socket.id)
  socketToRoom[socket.id] = roomId
  socket.join(roomId)

  socket.emit('roomJoined', {
    roomId,
    maxPlayers: CONFIG.roomMaxPlayers,
    world: {
      width: CONFIG.worldWidth,
      height: CONFIG.worldHeight
    }
  })

  emitRoomState(roomId)

  socket.on('initGame', ({ username }) => {
    const activeRoom = getRoomBySocket(socket.id)
    if (!activeRoom) return

    removePlayerFromRoom(activeRoom, socket.id)
    activeRoom.players[socket.id] = createPlayer(username)
    emitRoomState(activeRoom.id)
  })

  socket.on('quitToMenu', () => {
    const activeRoom = getRoomBySocket(socket.id)
    if (!activeRoom) return

    removePlayerFromRoom(activeRoom, socket.id)
    emitRoomState(activeRoom.id)
  })

  socket.on('requestRespawn', () => {
    const activeRoom = getRoomBySocket(socket.id)
    if (!activeRoom) return

    const player = activeRoom.players[socket.id]
    if (!player || player.isBot || player.isAlive) return

    player.inputX = 0
    player.inputY = 0
    respawnPlayer(player)
    emitRoomState(activeRoom.id)
  })

  socket.on('shoot', ({ angle }) => {
    const activeRoom = getRoomBySocket(socket.id)
    if (!activeRoom) return

    spawnProjectile(activeRoom, socket.id, angle, Date.now())
  })

  socket.on('disconnect', (reason) => {
    console.log(`disconnect ${socket.id}: ${reason}`)
    removeSocketFromRoom(socket.id)
  })

  socket.on('playerInput', ({ inputX, inputY, sequenceNumber }) => {
    const activeRoom = getRoomBySocket(socket.id)
    if (!activeRoom) return

    const backEndPlayer = activeRoom.players[socket.id]
    if (!backEndPlayer || !backEndPlayer.isAlive) return

    const normalizedInput = normalizeInputVector(inputX, inputY)
    backEndPlayer.inputX = normalizedInput.x
    backEndPlayer.inputY = normalizedInput.y
    backEndPlayer.sequenceNumber = sequenceNumber
  })

  socket.on('keydown', ({ keycode, sequenceNumber }) => {
    const activeRoom = getRoomBySocket(socket.id)
    if (!activeRoom) return

    const backEndPlayer = activeRoom.players[socket.id]
    if (!backEndPlayer || !backEndPlayer.isAlive) return

    let inputX = 0
    let inputY = 0

    switch (keycode) {
      case 'KeyW':
        inputY = -1
        break

      case 'KeyA':
        inputX = -1
        break

      case 'KeyS':
        inputY = 1
        break

      case 'KeyD':
        inputX = 1
        break

      default:
        return
    }

    const normalizedInput = normalizeInputVector(inputX, inputY)
    backEndPlayer.inputX = normalizedInput.x
    backEndPlayer.inputY = normalizedInput.y
    backEndPlayer.sequenceNumber = sequenceNumber
  })
})

// backend ticker
setInterval(() => {
  const now = Date.now()

  for (const roomId in rooms) {
    const room = rooms[roomId]

    for (const playerId in room.players) {
      const player = room.players[playerId]

      if (!player.isBot && player.isAlive) {
        player.x += player.inputX * CONFIG.playerSpeed
        player.y += player.inputY * CONFIG.playerSpeed
        clampPlayerWithinWorld(player)
      }

      if (
        player.isBot &&
        !player.isAlive &&
        player.respawnAt > 0 &&
        now >= player.respawnAt
      ) {
        respawnPlayer(player)

        if (player.isBot) {
          player.aiMoveAngle = Math.random() * Math.PI * 2
          player.aiNextTurnAt = now + 250 + Math.floor(Math.random() * 800)
        }
      }
    }

    runBotAI(room, now)

    for (const projectileId in room.projectiles) {
      const projectile = room.projectiles[projectileId]

      projectile.x += projectile.velocity.x
      projectile.y += projectile.velocity.y

      if (
        projectile.x - projectile.radius >= CONFIG.worldWidth ||
        projectile.x + projectile.radius <= 0 ||
        projectile.y - projectile.radius >= CONFIG.worldHeight ||
        projectile.y + projectile.radius <= 0
      ) {
        delete room.projectiles[projectileId]
        continue
      }

      for (const playerId in room.players) {
        if (projectile.playerId === playerId) continue

        const backEndPlayer = room.players[playerId]
        if (!backEndPlayer.isAlive) continue

        const distance = Math.hypot(
          projectile.x - backEndPlayer.x,
          projectile.y - backEndPlayer.y
        )

        if (distance < projectile.radius + backEndPlayer.radius) {
          delete room.projectiles[projectileId]

          backEndPlayer.hp -= CONFIG.projectileDamage
          if (backEndPlayer.hp <= 0) {
            backEndPlayer.hp = 0
            backEndPlayer.isAlive = false
            backEndPlayer.inputX = 0
            backEndPlayer.inputY = 0
            backEndPlayer.deaths++
            backEndPlayer.respawnAt = backEndPlayer.isBot
              ? now + CONFIG.respawnMs
              : 0

            const killer = room.players[projectile.playerId]
            if (killer) {
              killer.kills++
              killer.score = killer.kills

              if (killer.isAlive) {
                const healAmount = Math.ceil(killer.maxHp * 0.25)
                killer.hp = Math.min(killer.maxHp, killer.hp + healAmount)
              }
            }
          }

          break
        }
      }
    }

    if (now - room.lastBroadcastAt >= CONFIG.stateBroadcastMs) {
      emitRoomState(roomId)
      room.lastBroadcastAt = now
    }
  }
}, CONFIG.tickRateMs)

server.listen(CONFIG.port, () => {
  console.log(`Example app listening on port ${CONFIG.port}`)
})

console.log('server did load')
