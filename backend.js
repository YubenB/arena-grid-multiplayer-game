const express = require('express')
const app = express()

const http = require('http')
const server = http.createServer(app)
const { Server } = require('socket.io')
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 30000
})

const CONFIG = {
  port: 3000,
  tickRateMs: 30,
  stateBroadcastMs: 60,
  botTickMs: 50,
  roomMaxPlayers: 40,
  botsPerRoom: 3,
  visibilityRadius: 1400,
  worldWidth: 4096,
  worldHeight: 2304,
  playerSpeed: 6,
  botSpeed: 3.2,
  botDetectionRange: 1400,
  playerRadius: 12,
  projectileRadius: 5,
  projectileSpeed: 12,
  projectileDamage: 34,
  shotCooldownMs: 160,
  respawnMs: 2200,
  maxProjectilesPerPlayer: 18,
  collisionRejectPx: 100
}

app.use(express.static('public'))

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html')
})

const rooms = {}
const socketToRoom = {}

function createDefaultInput() {
  return {
    up: false,
    down: false,
    left: false,
    right: false
  }
}

function sanitizeInput(input) {
  return {
    up: Boolean(input?.up),
    down: Boolean(input?.down),
    left: Boolean(input?.left),
    right: Boolean(input?.right)
  }
}

function sanitizeSequence(sequence) {
  const value = Number(sequence)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

function randomSpawn(radius) {
  return {
    x: radius + Math.random() * (CONFIG.worldWidth - radius * 2),
    y: radius + Math.random() * (CONFIG.worldHeight - radius * 2)
  }
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
    score: 0,
    kills: 0,
    deaths: 0,
    hp: 100,
    maxHp: 100,
    isAlive: true,
    respawnAt: 0,
    lastShotAt: 0,
    activeProjectiles: 0,
    latestInputSequence: 0,
    lastProcessedInputSequence: 0,
    username: buildUsername(rawUsername),
    isBot,
    input: createDefaultInput(),
    lastAiStepAt: 0,
    aiMoveAngle: Math.random() * Math.PI * 2,
    aiNextTurnAt: 0
  }
}

function createRoom(roomId) {
  const room = {
    id: roomId,
    sockets: new Set(),
    players: {},
    projectiles: {},
    projectileId: 0
  }

  for (let index = 1; index <= CONFIG.botsPerRoom; index++) {
    const botId = `bot-${roomId}-${index}`
    room.players[botId] = createPlayer(`BOT-${index}`, { isBot: true })
  }

  return room
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

function respawnPlayer(player) {
  const spawn = randomSpawn(player.radius)
  player.x = spawn.x
  player.y = spawn.y
  player.hp = player.maxHp
  player.isAlive = true
  player.respawnAt = 0
  player.input = createDefaultInput()
  player.latestInputSequence = player.lastProcessedInputSequence
  player.lastAiStepAt = 0
}

function destroyProjectile(room, projectileId) {
  const projectile = room.projectiles[projectileId]
  if (!projectile) return

  const owner = room.players[projectile.playerId]
  if (owner) {
    owner.activeProjectiles = Math.max(0, owner.activeProjectiles - 1)
  }

  delete room.projectiles[projectileId]
}

function spawnProjectile(room, shooterId, angle, now) {
  const shooter = room.players[shooterId]
  if (!shooter || !shooter.isAlive) return false
  if (now - shooter.lastShotAt < CONFIG.shotCooldownMs) return false
  if (shooter.activeProjectiles >= CONFIG.maxProjectilesPerPlayer) return false

  shooter.lastShotAt = now
  shooter.activeProjectiles++

  room.projectileId++
  const projectileId = room.projectileId

  room.projectiles[projectileId] = {
    x: shooter.x,
    y: shooter.y,
    radius: CONFIG.projectileRadius,
    velocity: {
      x: Math.cos(angle) * CONFIG.projectileSpeed,
      y: Math.sin(angle) * CONFIG.projectileSpeed
    },
    playerId: shooterId
  }

  return true
}

function removeProjectilesByPlayer(room, playerId) {
  for (const projectileId in room.projectiles) {
    if (room.projectiles[projectileId].playerId === playerId) {
      destroyProjectile(room, projectileId)
    }
  }
}

function removePlayerFromRoom(room, playerId) {
  if (!room.players[playerId]) return
  removeProjectilesByPlayer(room, playerId)
  delete room.players[playerId]
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
  }
}

function applyBufferedMovement(player) {
  if (!player.isAlive) return

  let moveX = 0
  let moveY = 0

  if (player.input.up) moveY -= 1
  if (player.input.down) moveY += 1
  if (player.input.left) moveX -= 1
  if (player.input.right) moveX += 1

  if (moveX === 0 && moveY === 0) {
    player.lastProcessedInputSequence = player.latestInputSequence
    return
  }

  const length = Math.hypot(moveX, moveY) || 1
  player.x += (moveX / length) * CONFIG.playerSpeed
  player.y += (moveY / length) * CONFIG.playerSpeed
  clampPlayerWithinWorld(player)
  player.lastProcessedInputSequence = player.latestInputSequence
}

function processHumanMovement(room) {
  for (const playerId in room.players) {
    const player = room.players[playerId]
    if (player.isBot || !player.isAlive) continue
    applyBufferedMovement(player)
  }
}

function processRespawns(room, now) {
  for (const playerId in room.players) {
    const player = room.players[playerId]

    if (!player.isAlive && player.respawnAt > 0 && now >= player.respawnAt) {
      respawnPlayer(player)

      if (player.isBot) {
        player.aiMoveAngle = Math.random() * Math.PI * 2
        player.aiNextTurnAt = now + 250 + Math.floor(Math.random() * 800)
      }
    }
  }
}

function getClosestHumanTarget(bot, players) {
  let closestTarget = null
  let closestDistanceSquared = Infinity
  const maxRangeSquared = CONFIG.botDetectionRange * CONFIG.botDetectionRange

  for (const playerId in players) {
    const player = players[playerId]
    if (!player.isAlive || player.isBot) continue

    const dx = player.x - bot.x
    const dy = player.y - bot.y

    if (Math.abs(dx) > CONFIG.botDetectionRange) continue
    if (Math.abs(dy) > CONFIG.botDetectionRange) continue

    const distanceSquared = dx * dx + dy * dy
    if (
      distanceSquared <= maxRangeSquared &&
      distanceSquared < closestDistanceSquared
    ) {
      closestDistanceSquared = distanceSquared
      closestTarget = player
    }
  }

  return closestTarget
}

function runBotAI(room, now) {
  for (const playerId in room.players) {
    const bot = room.players[playerId]
    if (!bot.isBot || !bot.isAlive) continue

    const elapsedMs = bot.lastAiStepAt
      ? Math.max(10, Math.min(150, now - bot.lastAiStepAt))
      : CONFIG.botTickMs
    bot.lastAiStepAt = now
    const stepScale = elapsedMs / CONFIG.tickRateMs
    const moveSpeed = CONFIG.botSpeed * stepScale

    const target = getClosestHumanTarget(bot, room.players)

    if (target) {
      const dx = target.x - bot.x
      const dy = target.y - bot.y
      const distance = Math.hypot(dx, dy)

      if (distance > 36) {
        const chaseAngle = Math.atan2(dy, dx)
        const strafeDrift = Math.sin(now / 500 + playerId.length) * 0.35
        bot.x += Math.cos(chaseAngle + strafeDrift) * moveSpeed
        bot.y += Math.sin(chaseAngle + strafeDrift) * moveSpeed
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

    bot.x += Math.cos(bot.aiMoveAngle) * moveSpeed * 0.6
    bot.y += Math.sin(bot.aiMoveAngle) * moveSpeed * 0.6
    clampPlayerWithinWorld(bot)
  }
}

function processProjectiles(room, now) {
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
      destroyProjectile(room, projectileId)
      continue
    }

    for (const playerId in room.players) {
      if (projectile.playerId === playerId) continue

      const target = room.players[playerId]
      if (!target.isAlive) continue

      const dx = projectile.x - target.x
      const dy = projectile.y - target.y

      if (Math.abs(dx) > CONFIG.collisionRejectPx) continue
      if (Math.abs(dy) > CONFIG.collisionRejectPx) continue

      const radiusSum = projectile.radius + target.radius
      const distanceSquared = dx * dx + dy * dy
      if (distanceSquared >= radiusSum * radiusSum) continue

      destroyProjectile(room, projectileId)

      target.hp -= CONFIG.projectileDamage
      if (target.hp <= 0) {
        target.hp = 0
        target.isAlive = false
        target.deaths++
        target.respawnAt = target.isBot ? now + CONFIG.respawnMs : 0
        target.input = createDefaultInput()

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

function serializeStateForPlayer(room, playerId, roomStats, serverTime) {
  const self = room.players[playerId]
  if (!self) return null

  const visibleRadiusSquared = CONFIG.visibilityRadius * CONFIG.visibilityRadius
  const players = []
  const projectiles = []

  for (const id in room.players) {
    const player = room.players[id]
    const dx = player.x - self.x
    const dy = player.y - self.y

    if (dx * dx + dy * dy <= visibleRadiusSquared) {
      players.push({
        id,
        x: player.x,
        y: player.y,
        radius: player.radius,
        color: player.color,
        username: player.username,
        score: player.score,
        kills: player.kills,
        deaths: player.deaths,
        hp: player.hp,
        maxHp: player.maxHp,
        isAlive: player.isAlive,
        alive: player.isAlive,
        isBot: player.isBot
      })
    }
  }

  for (const id in room.projectiles) {
    const projectile = room.projectiles[id]
    const dx = projectile.x - self.x
    const dy = projectile.y - self.y

    if (dx * dx + dy * dy <= visibleRadiusSquared) {
      projectiles.push({
        id,
        x: projectile.x,
        y: projectile.y,
        radius: projectile.radius,
        velocity: projectile.velocity,
        playerId: projectile.playerId
      })
    }
  }

  return {
    players,
    projectiles,
    roomStats,
    inputAck: self.lastProcessedInputSequence,
    serverTime
  }
}

function gameTick() {
  const now = Date.now()

  for (const roomId in rooms) {
    const room = rooms[roomId]
    processRespawns(room, now)
    processHumanMovement(room)
    processProjectiles(room, now)
  }
}

function broadcastTick() {
  const now = Date.now()

  for (const roomId in rooms) {
    const room = rooms[roomId]
    const roomStats = buildRoomStats(room)

    for (const socketId of room.sockets) {
      const state = serializeStateForPlayer(room, socketId, roomStats, now)
      if (!state) continue
      io.to(socketId).emit('state', state)
    }
  }
}

function botTick() {
  const now = Date.now()
  for (const roomId in rooms) {
    runBotAI(rooms[roomId], now)
  }
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

  socket.on('initGame', ({ username }) => {
    const activeRoom = getRoomBySocket(socket.id)
    if (!activeRoom) return

    removePlayerFromRoom(activeRoom, socket.id)
    activeRoom.players[socket.id] = createPlayer(username)
  })

  socket.on('quitToMenu', () => {
    const activeRoom = getRoomBySocket(socket.id)
    if (!activeRoom) return

    removePlayerFromRoom(activeRoom, socket.id)
  })

  socket.on('requestRespawn', () => {
    const activeRoom = getRoomBySocket(socket.id)
    if (!activeRoom) return

    const player = activeRoom.players[socket.id]
    if (!player || player.isBot || player.isAlive) return

    respawnPlayer(player)
  })

  socket.on('input', (payload) => {
    const activeRoom = getRoomBySocket(socket.id)
    if (!activeRoom) return

    const player = activeRoom.players[socket.id]
    if (!player || !player.isAlive) return

    const inputData =
      payload && typeof payload === 'object' && payload.input
        ? payload.input
        : payload

    player.input = sanitizeInput(inputData)

    const sequence =
      payload && typeof payload === 'object'
        ? sanitizeSequence(payload.sequence)
        : null

    if (sequence !== null) {
      player.latestInputSequence = Math.max(
        player.latestInputSequence,
        sequence
      )
    } else {
      player.latestInputSequence++
    }
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
})

setInterval(() => {
  try {
    gameTick()
  } catch (error) {
    console.error('gameTick failed:', error)
  }
}, CONFIG.tickRateMs)

setInterval(() => {
  try {
    broadcastTick()
  } catch (error) {
    console.error('broadcastTick failed:', error)
  }
}, CONFIG.stateBroadcastMs)

setInterval(() => {
  try {
    botTick()
  } catch (error) {
    console.error('botTick failed:', error)
  }
}, CONFIG.botTickMs)

server.listen(CONFIG.port, () => {
  console.log(`Example app listening on port ${CONFIG.port}`)
})

console.log('server did load')
