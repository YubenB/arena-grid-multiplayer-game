const canvas = document.querySelector('canvas')
const c = canvas.getContext('2d')

const socket = io()

const leaderboardPanelEl = document.querySelector('.hud-leaderboard')
const leaderboardToggleEl = document.querySelector('#leaderboardToggle')
const playerLabelsEl = document.querySelector('#playerLabels')
const usernameOverlayEl = document.querySelector('#usernameOverlay')
const usernameInputEl = document.querySelector('#usernameInput')
const deathOverlayEl = document.querySelector('#deathOverlay')
const respawnBtnEl = document.querySelector('#respawnBtn')
const backToMenuBtnEl = document.querySelector('#backToMenuBtn')
const mobileControlsEl = document.querySelector('#mobileControls')
const joystickEl = document.querySelector('#mobileJoystick')
const joystickKnobEl = document.querySelector('#mobileJoystickKnob')
const mobileAimJoystickEl = document.querySelector('#mobileAimJoystick')
const mobileAimJoystickKnobEl = document.querySelector('#mobileAimJoystickKnob')

let VIEWPORT_WIDTH = 1366
let VIEWPORT_HEIGHT = 768
const VIEWPORT = {
  width: VIEWPORT_WIDTH,
  height: VIEWPORT_HEIGHT
}

window.__GAME_VIEWPORT = VIEWPORT

function syncMobileViewportHeightVar() {
  const layoutHeight = window.innerHeight
  const visualHeight = window.visualViewport?.height || layoutHeight
  const visualTop = window.visualViewport?.offsetTop || 0
  const browserBottomInset = Math.max(
    0,
    Math.floor(layoutHeight - visualHeight - visualTop)
  )

  document.documentElement.style.setProperty(
    '--app-vh',
    `${Math.floor(layoutHeight)}px`
  )
  document.documentElement.style.setProperty(
    '--browser-ui-bottom',
    `${browserBottomInset}px`
  )
}

function syncCanvasSize() {
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const width = Math.max(320, Math.floor(rect.width || VIEWPORT_WIDTH))
  const height = Math.max(320, Math.floor(rect.height || VIEWPORT_HEIGHT))

  VIEWPORT_WIDTH = width
  VIEWPORT_HEIGHT = height
  VIEWPORT.width = width
  VIEWPORT.height = height

  canvas.width = Math.floor(width * dpr)
  canvas.height = Math.floor(height * dpr)

  c.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function restoreViewportAfterKeyboard() {
  syncMobileViewportHeightVar()
  syncCanvasSize()
  window.scrollTo(0, 0)
}

syncMobileViewportHeightVar()
syncCanvasSize()

const world = {
  width: 4096,
  height: 2304
}

const roomState = {
  roomId: '--',
  maxPlayers: 40
}

const camera = {
  x: 0,
  y: 0
}

const frontEndPlayers = {}
const frontEndProjectiles = {}
const isTouchDevice =
  window.matchMedia('(hover: none) and (pointer: coarse)').matches ||
  'ontouchstart' in window

if (isTouchDevice) {
  document.body.classList.add('touch-ui')
}

const mobileState = {
  movePointerId: null,
  aimPointerId: null,
  dx: 0,
  dy: 0,
  aimDx: 0,
  aimDy: 0,
  maxDistance: 34,
  lastAimAngle: 0,
  autoFireId: null,
  lastAutoShotAt: 0
}

let lastLeaderboardUpdateAt = 0

const SERVER_TICK_MS = 30
const SERVER_PLAYER_SPEED = 6
const INTERPOLATION_DELAY_MS = 60
const INPUT_SEND_MS = 30

const remoteSnapshotBuffers = {}
const pendingInputs = []
let localInputSequence = 0
let lastInputSignature = ''
let lastInputSentAt = 0
let activeUsername = ''

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function inputSignature(input) {
  return `${Number(input.up)}${Number(input.down)}${Number(input.left)}${Number(
    input.right
  )}`
}

function clampEntityWithinWorld(entity) {
  if (!entity) return

  const radius = entity.radius || 12
  entity.x = clamp(entity.x, radius, world.width - radius)
  entity.y = clamp(entity.y, radius, world.height - radius)
}

function applyInputToEntity(entity, input, deltaMs) {
  if (!entity || !input) return

  let moveX = 0
  let moveY = 0

  if (input.up) moveY -= 1
  if (input.down) moveY += 1
  if (input.left) moveX -= 1
  if (input.right) moveX += 1

  if (moveX === 0 && moveY === 0) return

  const length = Math.hypot(moveX, moveY) || 1
  const distance = (SERVER_PLAYER_SPEED * deltaMs) / SERVER_TICK_MS

  entity.x += (moveX / length) * distance
  entity.y += (moveY / length) * distance
  clampEntityWithinWorld(entity)
}

function pushRemoteSnapshot(playerId, x, y, snapshotTime) {
  if (playerId === socket.id) return

  const buffer =
    remoteSnapshotBuffers[playerId] || (remoteSnapshotBuffers[playerId] = [])
  const lastSnapshot = buffer[buffer.length - 1]

  if (lastSnapshot && snapshotTime <= lastSnapshot.time) {
    if (snapshotTime === lastSnapshot.time) {
      lastSnapshot.x = x
      lastSnapshot.y = y
    }
    return
  }

  buffer.push({
    time: snapshotTime,
    x,
    y
  })

  while (buffer.length > 30) {
    buffer.shift()
  }
}

function sampleRemoteSnapshot(playerId, renderTimestamp) {
  const buffer = remoteSnapshotBuffers[playerId]
  if (!buffer || buffer.length === 0) return null

  while (buffer.length >= 2 && buffer[1].time <= renderTimestamp) {
    buffer.shift()
  }

  if (buffer.length >= 2) {
    const older = buffer[0]
    const newer = buffer[1]
    const span = Math.max(1, newer.time - older.time)
    const alpha = clamp((renderTimestamp - older.time) / span, 0, 1)

    return {
      x: older.x + (newer.x - older.x) * alpha,
      y: older.y + (newer.y - older.y) * alpha
    }
  }

  return {
    x: buffer[0].x,
    y: buffer[0].y
  }
}

function reconcileLocalPlayer(localPlayer, inputAck) {
  if (!localPlayer) return

  if (typeof inputAck === 'number' && Number.isFinite(inputAck)) {
    while (pendingInputs.length > 0 && pendingInputs[0].sequence <= inputAck) {
      pendingInputs.shift()
    }
  }

  for (const pending of pendingInputs) {
    applyInputToEntity(
      localPlayer,
      pending.input,
      pending.deltaMs || SERVER_TICK_MS
    )
  }
}

function setDeathOverlayVisible(visible) {
  if (!deathOverlayEl) return
  deathOverlayEl.style.display = visible ? 'flex' : 'none'
}

function setGameUiState(isInGame) {
  if (!mobileControlsEl) return
  mobileControlsEl.style.display = isTouchDevice && isInGame ? 'flex' : 'none'
}

function syncPlayerUiState() {
  const localPlayer = frontEndPlayers[socket.id]

  if (!localPlayer) {
    setGameUiState(false)
    setDeathOverlayVisible(false)
    return
  }

  if (!localPlayer.isAlive) {
    setGameUiState(false)
    setDeathOverlayVisible(true)
    return
  }

  setDeathOverlayVisible(false)
  setGameUiState(true)
}

function updateLeaderboard(backEndPlayers) {
  const sortedPlayers = Object.entries(backEndPlayers).sort((a, b) => {
    const playerA = a[1]
    const playerB = b[1]

    if (playerB.kills !== playerA.kills) return playerB.kills - playerA.kills
    return playerA.deaths - playerB.deaths
  })

  const maxRows = isTouchDevice
    ? VIEWPORT_WIDTH > VIEWPORT_HEIGHT
      ? 4
      : 3
    : sortedPlayers.length
  const compactHud = VIEWPORT_WIDTH <= 520

  playerLabelsEl.innerHTML = sortedPlayers
    .slice(0, maxRows)
    .map(([id, player], index) => {
      const marker = id === socket.id ? 'You' : player.username
      const stateText = player.isAlive ? `HP${player.hp}` : 'DOWN'
      const rightText = compactHud
        ? `K${player.kills} D${player.deaths} ${stateText}`
        : `K ${player.kills} / D ${player.deaths} • ${stateText}`

      return `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.08)"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${index + 1}. ${marker}</span><span style="white-space:nowrap;font-size:${compactHud ? '11px' : '13px'}">${rightText}</span></div>`
    })
    .join('')
}

function emitShootAtAngle(angle) {
  const localPlayer = frontEndPlayers[socket.id]
  if (!localPlayer || !localPlayer.isAlive) return

  mobileState.lastAimAngle = angle
  socket.emit('shoot', { angle })
}

function emitShootAtClientPoint(clientX, clientY) {
  const localPlayer = frontEndPlayers[socket.id]
  if (!localPlayer || !localPlayer.isAlive) return

  const { top, left } = canvas.getBoundingClientRect()
  const scaleX = VIEWPORT_WIDTH / canvas.clientWidth
  const scaleY = VIEWPORT_HEIGHT / canvas.clientHeight

  const worldMousePosition = {
    x: (clientX - left) * scaleX + camera.x,
    y: (clientY - top) * scaleY + camera.y
  }

  const angle = Math.atan2(
    worldMousePosition.y - localPlayer.y,
    worldMousePosition.x - localPlayer.x
  )

  emitShootAtAngle(angle)
}

function setMovementFromVector(dx, dy) {
  const threshold = 0.3
  keys.w.pressed = dy < -threshold
  keys.s.pressed = dy > threshold
  keys.a.pressed = dx < -threshold
  keys.d.pressed = dx > threshold

  emitBufferedInput(false)
}

function resetJoystickVisual() {
  joystickKnobEl.style.transform = 'translate(-50%, -50%)'
}

function resetAimJoystickVisual() {
  mobileAimJoystickKnobEl.style.transform = 'translate(-50%, -50%)'
}

function resetMobileMovement() {
  mobileState.dx = 0
  mobileState.dy = 0
  setMovementFromVector(0, 0)
  resetJoystickVisual()
}

function resetMobileAim() {
  mobileState.aimDx = 0
  mobileState.aimDy = 0
  resetAimJoystickVisual()
}

function clearPlayerInputs() {
  keys.w.pressed = false
  keys.a.pressed = false
  keys.s.pressed = false
  keys.d.pressed = false
  mobileState.movePointerId = null
  mobileState.aimPointerId = null
  resetMobileMovement()
  resetMobileAim()
  stopAutoFire()

  if (frontEndPlayers[socket.id]) {
    emitBufferedInput(true)
  }
}

function openMainMenuOverlay() {
  usernameOverlayEl.style.display = 'flex'
  setDeathOverlayVisible(false)
  setGameUiState(false)
  pendingInputs.length = 0
  localInputSequence = 0
  lastInputSignature = ''
  lastInputSentAt = 0

  if (usernameInputEl && !isTouchDevice) {
    usernameInputEl.focus()
    usernameInputEl.select()
  }
}

socket.on('disconnect', () => {
  clearPlayerInputs()
})

socket.on('connect', () => {
  if (!activeUsername) return
  if (usernameOverlayEl && usernameOverlayEl.style.display !== 'none') return

  socket.emit('initGame', {
    username: activeUsername
  })
})

function startAutoFire() {
  if (mobileState.autoFireId) return

  const hasAimVector =
    Math.abs(mobileState.aimDx) > 0.15 || Math.abs(mobileState.aimDy) > 0.15

  if (hasAimVector) {
    emitShootAtAngle(Math.atan2(mobileState.aimDy, mobileState.aimDx))
    mobileState.lastAutoShotAt = performance.now()
  }

  mobileState.autoFireId = window.setInterval(() => {
    const hasAimVectorNow =
      Math.abs(mobileState.aimDx) > 0.15 || Math.abs(mobileState.aimDy) > 0.15

    if (hasAimVectorNow) {
      emitShootAtAngle(Math.atan2(mobileState.aimDy, mobileState.aimDx))
      mobileState.lastAutoShotAt = performance.now()
    }
  }, 160)
}

function stopAutoFire() {
  if (!mobileState.autoFireId) return
  clearInterval(mobileState.autoFireId)
  mobileState.autoFireId = null
}

function updateMoveJoystickFromEvent(event) {
  const rect = joystickEl.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const rawX = event.clientX - centerX
  const rawY = event.clientY - centerY
  const distance = Math.hypot(rawX, rawY)
  const ratio =
    distance > mobileState.maxDistance ? mobileState.maxDistance / distance : 1
  const clampedX = rawX * ratio
  const clampedY = rawY * ratio

  joystickKnobEl.style.transform = `translate(calc(-50% + ${clampedX}px), calc(-50% + ${clampedY}px))`

  const normalizedX = clampedX / mobileState.maxDistance
  const normalizedY = clampedY / mobileState.maxDistance

  mobileState.dx = normalizedX
  mobileState.dy = normalizedY

  setMovementFromVector(normalizedX, normalizedY)
}

function updateAimJoystickFromEvent(event) {
  const rect = mobileAimJoystickEl.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const rawX = event.clientX - centerX
  const rawY = event.clientY - centerY
  const distance = Math.hypot(rawX, rawY)
  const ratio =
    distance > mobileState.maxDistance ? mobileState.maxDistance / distance : 1
  const clampedX = rawX * ratio
  const clampedY = rawY * ratio

  mobileAimJoystickKnobEl.style.transform = `translate(calc(-50% + ${clampedX}px), calc(-50% + ${clampedY}px))`

  const normalizedX = clampedX / mobileState.maxDistance
  const normalizedY = clampedY / mobileState.maxDistance

  mobileState.aimDx = normalizedX
  mobileState.aimDy = normalizedY

  if (Math.abs(normalizedX) > 0.12 || Math.abs(normalizedY) > 0.12) {
    mobileState.lastAimAngle = Math.atan2(normalizedY, normalizedX)

    if (
      mobileState.autoFireId &&
      performance.now() - mobileState.lastAutoShotAt > 100
    ) {
      emitShootAtAngle(mobileState.lastAimAngle)
      mobileState.lastAutoShotAt = performance.now()
    }
  }
}

if (isTouchDevice) {
  mobileControlsEl.style.display = 'flex'

  joystickEl.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    mobileState.movePointerId = event.pointerId
    joystickEl.setPointerCapture(event.pointerId)
    updateMoveJoystickFromEvent(event)
  })

  joystickEl.addEventListener('pointermove', (event) => {
    if (mobileState.movePointerId !== event.pointerId) return
    event.preventDefault()
    updateMoveJoystickFromEvent(event)
  })

  const stopMoveJoystick = (event) => {
    if (mobileState.movePointerId !== event.pointerId) return
    mobileState.movePointerId = null
    resetMobileMovement()
  }

  joystickEl.addEventListener('pointerup', stopMoveJoystick)
  joystickEl.addEventListener('pointercancel', stopMoveJoystick)

  mobileAimJoystickEl.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    mobileState.aimPointerId = event.pointerId
    mobileAimJoystickEl.setPointerCapture(event.pointerId)
    updateAimJoystickFromEvent(event)
    startAutoFire()
  })

  mobileAimJoystickEl.addEventListener('pointermove', (event) => {
    if (mobileState.aimPointerId !== event.pointerId) return
    event.preventDefault()
    updateAimJoystickFromEvent(event)
  })

  const stopAimJoystick = (event) => {
    if (mobileState.aimPointerId !== event.pointerId) return
    mobileState.aimPointerId = null
    resetMobileAim()
    stopAutoFire()
  }

  mobileAimJoystickEl.addEventListener('pointerup', stopAimJoystick)
  mobileAimJoystickEl.addEventListener('pointercancel', stopAimJoystick)
  mobileAimJoystickEl.addEventListener('pointerleave', stopAimJoystick)
}

function drawGrid() {
  const spacing = 120
  const offsetX = -(camera.x % spacing)
  const offsetY = -(camera.y % spacing)

  c.strokeStyle = 'rgba(20, 184, 166, 0.14)'
  c.lineWidth = 1

  for (let x = offsetX; x <= VIEWPORT_WIDTH; x += spacing) {
    c.beginPath()
    c.moveTo(x, 0)
    c.lineTo(x, VIEWPORT_HEIGHT)
    c.stroke()
  }

  for (let y = offsetY; y <= VIEWPORT_HEIGHT; y += spacing) {
    c.beginPath()
    c.moveTo(0, y)
    c.lineTo(VIEWPORT_WIDTH, y)
    c.stroke()
  }
}

function drawMiniMap() {
  if (isTouchDevice) return

  const width = Math.max(120, Math.min(190, Math.floor(VIEWPORT_WIDTH * 0.24)))
  const height = Math.floor(width * 0.58)
  const x = VIEWPORT_WIDTH - width - 16
  const y = VIEWPORT_HEIGHT - height - (isTouchDevice ? 136 : 16)

  c.fillStyle = 'rgba(4, 14, 28, 0.75)'
  c.fillRect(x, y, width, height)
  c.strokeStyle = 'rgba(255, 255, 255, 0.4)'
  c.strokeRect(x, y, width, height)

  for (const id in frontEndPlayers) {
    const player = frontEndPlayers[id]
    const mapX = x + (player.x / world.width) * width
    const mapY = y + (player.y / world.height) * height

    c.beginPath()
    c.fillStyle = id === socket.id ? '#34d399' : player.color
    c.arc(mapX, mapY, id === socket.id ? 4 : 3, 0, Math.PI * 2)
    c.fill()
  }
}

socket.on('roomJoined', (payload) => {
  roomState.roomId = payload.roomId
  roomState.maxPlayers = payload.maxPlayers
  world.width = payload.world.width
  world.height = payload.world.height
})

socket.on('state', (payload) => {
  const snapshotTime = performance.now()

  if (payload?.roomStats) {
    roomState.roomId = payload.roomStats.roomId
    roomState.maxPlayers = payload.roomStats.maxPlayers
    world.width = payload.roomStats.world.width
    world.height = payload.roomStats.world.height
  }

  const backEndPlayers = {}
  const visiblePlayers = Array.isArray(payload?.players) ? payload.players : []

  for (const backEndPlayer of visiblePlayers) {
    if (!backEndPlayer?.id) continue
    const playerId = backEndPlayer.id
    backEndPlayers[playerId] = backEndPlayer

    const isAlive = backEndPlayer.isAlive ?? backEndPlayer.alive

    if (!frontEndPlayers[playerId]) {
      frontEndPlayers[playerId] = new Player({
        x: backEndPlayer.x,
        y: backEndPlayer.y,
        radius: backEndPlayer.radius,
        color: backEndPlayer.color,
        username: backEndPlayer.username,
        score: backEndPlayer.score,
        kills: backEndPlayer.kills,
        deaths: backEndPlayer.deaths,
        hp: backEndPlayer.hp,
        maxHp: backEndPlayer.maxHp,
        isAlive
      })
    }

    const player = frontEndPlayers[playerId]
    player.score = backEndPlayer.score
    player.kills = backEndPlayer.kills
    player.deaths = backEndPlayer.deaths
    player.hp = backEndPlayer.hp
    player.maxHp = backEndPlayer.maxHp
    player.isAlive = isAlive

    if (playerId === socket.id) {
      player.x = backEndPlayer.x
      player.y = backEndPlayer.y
      player.target = {
        x: backEndPlayer.x,
        y: backEndPlayer.y
      }

      reconcileLocalPlayer(player, payload?.inputAck)
    } else {
      pushRemoteSnapshot(
        playerId,
        backEndPlayer.x,
        backEndPlayer.y,
        snapshotTime
      )

      player.target = {
        x: backEndPlayer.x,
        y: backEndPlayer.y
      }
    }
  }

  for (const id in frontEndPlayers) {
    if (!backEndPlayers[id]) {
      if (id === socket.id) {
        clearPlayerInputs()
        openMainMenuOverlay()
      }

      delete frontEndPlayers[id]
      delete remoteSnapshotBuffers[id]
    }
  }

  const backEndProjectiles = {}
  const visibleProjectiles = Array.isArray(payload?.projectiles)
    ? payload.projectiles
    : []

  for (const backEndProjectile of visibleProjectiles) {
    if (backEndProjectile?.id === undefined || backEndProjectile?.id === null)
      continue

    const projectileId = String(backEndProjectile.id)
    backEndProjectiles[projectileId] = backEndProjectile

    if (!frontEndProjectiles[projectileId]) {
      frontEndProjectiles[projectileId] = new Projectile({
        x: backEndProjectile.x,
        y: backEndProjectile.y,
        radius: backEndProjectile.radius,
        color: frontEndPlayers[backEndProjectile.playerId]?.color,
        velocity: backEndProjectile.velocity || { x: 0, y: 0 }
      })
    }

    frontEndProjectiles[projectileId].target = {
      x: backEndProjectile.x,
      y: backEndProjectile.y
    }
    frontEndProjectiles[projectileId].velocity = backEndProjectile.velocity || {
      x: 0,
      y: 0
    }

    if (frontEndPlayers[backEndProjectile.playerId]) {
      frontEndProjectiles[projectileId].color =
        frontEndPlayers[backEndProjectile.playerId].color
    }
  }

  for (const frontEndProjectileId in frontEndProjectiles) {
    if (!backEndProjectiles[frontEndProjectileId]) {
      delete frontEndProjectiles[frontEndProjectileId]
    }
  }

  const now = performance.now()
  if (now - lastLeaderboardUpdateAt > 200) {
    updateLeaderboard(backEndPlayers)
    lastLeaderboardUpdateAt = now
  }

  syncPlayerUiState()
})

let animationId
let lastAnimationAt = performance.now()
function animate(now = performance.now()) {
  animationId = requestAnimationFrame(animate)
  const deltaMs = Math.max(0, Math.min(50, now - lastAnimationAt || 16))
  lastAnimationAt = now

  c.clearRect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)

  const localPlayer = frontEndPlayers[socket.id]
  if (localPlayer && localPlayer.isAlive) {
    applyInputToEntity(localPlayer, currentInputState(), deltaMs)
  }

  if (localPlayer) {
    camera.x = clamp(
      localPlayer.x - VIEWPORT_WIDTH / 2,
      0,
      Math.max(0, world.width - VIEWPORT_WIDTH)
    )
    camera.y = clamp(
      localPlayer.y - VIEWPORT_HEIGHT / 2,
      0,
      Math.max(0, world.height - VIEWPORT_HEIGHT)
    )
  }

  drawGrid()

  const renderTimestamp = now - INTERPOLATION_DELAY_MS

  for (const id in frontEndPlayers) {
    const frontEndPlayer = frontEndPlayers[id]

    if (id !== socket.id) {
      const interpolated = sampleRemoteSnapshot(id, renderTimestamp)

      if (interpolated) {
        frontEndPlayer.x = interpolated.x
        frontEndPlayer.y = interpolated.y
      } else if (frontEndPlayer.target) {
        frontEndPlayer.x += (frontEndPlayer.target.x - frontEndPlayer.x) * 0.45
        frontEndPlayer.y += (frontEndPlayer.target.y - frontEndPlayer.y) * 0.45
      }
    }

    frontEndPlayer.draw(camera)
  }

  for (const id in frontEndProjectiles) {
    const frontEndProjectile = frontEndProjectiles[id]
    const velocity = frontEndProjectile.velocity || { x: 0, y: 0 }

    const tickScale = deltaMs / SERVER_TICK_MS
    frontEndProjectile.x += (velocity.x || 0) * tickScale
    frontEndProjectile.y += (velocity.y || 0) * tickScale

    if (frontEndProjectile.target) {
      frontEndProjectile.x +=
        (frontEndProjectile.target.x - frontEndProjectile.x) * 0.22
      frontEndProjectile.y +=
        (frontEndProjectile.target.y - frontEndProjectile.y) * 0.22
    }

    frontEndProjectile.draw(camera)
  }

  drawMiniMap()
}

const keys = {
  w: {
    pressed: false
  },
  a: {
    pressed: false
  },
  s: {
    pressed: false
  },
  d: {
    pressed: false
  }
}

function currentInputState() {
  return {
    up: keys.w.pressed,
    down: keys.s.pressed,
    left: keys.a.pressed,
    right: keys.d.pressed
  }
}

function emitBufferedInput(force = false) {
  const localPlayer = frontEndPlayers[socket.id]
  if (!localPlayer || !localPlayer.isAlive) return

  const input = currentInputState()
  const signature = inputSignature(input)
  const now = performance.now()
  const deltaMs = lastInputSentAt
    ? Math.max(8, Math.min(90, now - lastInputSentAt))
    : INPUT_SEND_MS

  if (!force && signature === lastInputSignature) return

  lastInputSentAt = now
  lastInputSignature = signature
  localInputSequence++

  const packet = {
    sequence: localInputSequence,
    input,
    deltaMs
  }

  pendingInputs.push(packet)
  if (pendingInputs.length > 120) {
    pendingInputs.shift()
  }

  socket.emit('input', packet)
}

setInterval(() => {
  emitBufferedInput(true)
}, INPUT_SEND_MS)

animate()

window.addEventListener('keydown', (event) => {
  if (!frontEndPlayers[socket.id]) return

  switch (event.code) {
    case 'KeyW':
      keys.w.pressed = true
      break

    case 'KeyA':
      keys.a.pressed = true
      break

    case 'KeyS':
      keys.s.pressed = true
      break

    case 'KeyD':
      keys.d.pressed = true
      break
  }

  emitBufferedInput(false)
})

window.addEventListener('keyup', (event) => {
  if (!frontEndPlayers[socket.id]) return

  switch (event.code) {
    case 'KeyW':
      keys.w.pressed = false
      break

    case 'KeyA':
      keys.a.pressed = false
      break

    case 'KeyS':
      keys.s.pressed = false
      break

    case 'KeyD':
      keys.d.pressed = false
      break
  }

  emitBufferedInput(false)
})

document.querySelector('#usernameForm').addEventListener('submit', (event) => {
  event.preventDefault()

  if (usernameInputEl) {
    usernameInputEl.blur()
  }

  usernameOverlayEl.style.display = 'none'
  setDeathOverlayVisible(false)
  pendingInputs.length = 0
  localInputSequence = 0
  lastInputSignature = ''
  lastInputSentAt = 0
  activeUsername = usernameInputEl ? usernameInputEl.value : ''

  socket.emit('initGame', {
    username: activeUsername
  })

  // iOS Safari may keep a zoomed visual viewport after keyboard hide.
  setTimeout(restoreViewportAfterKeyboard, 60)
  setTimeout(restoreViewportAfterKeyboard, 240)
})

if (usernameInputEl && isTouchDevice) {
  usernameInputEl.setAttribute('autocapitalize', 'off')
  usernameInputEl.setAttribute('autocomplete', 'off')
  usernameInputEl.setAttribute('spellcheck', 'false')

  usernameInputEl.addEventListener('blur', () => {
    setTimeout(restoreViewportAfterKeyboard, 80)
    setTimeout(restoreViewportAfterKeyboard, 260)
  })
}

if (leaderboardToggleEl && leaderboardPanelEl) {
  const setLeaderboardCollapsed = (collapsed) => {
    leaderboardPanelEl.classList.toggle('collapsed', collapsed)
    leaderboardToggleEl.textContent = collapsed ? 'Show' : 'Hide'
  }

  setLeaderboardCollapsed(isTouchDevice)

  leaderboardToggleEl.addEventListener('click', () => {
    const nextCollapsed = !leaderboardPanelEl.classList.contains('collapsed')
    setLeaderboardCollapsed(nextCollapsed)
  })
}

if (respawnBtnEl) {
  respawnBtnEl.addEventListener('click', () => {
    const localPlayer = frontEndPlayers[socket.id]
    if (!localPlayer || localPlayer.isAlive) return

    socket.emit('requestRespawn')
  })
}

if (backToMenuBtnEl) {
  backToMenuBtnEl.addEventListener('click', () => {
    const hasLocalPlayer = Boolean(frontEndPlayers[socket.id])
    if (!hasLocalPlayer) return

    clearPlayerInputs()
    setDeathOverlayVisible(false)
    openMainMenuOverlay()

    socket.emit('quitToMenu')
  })
}

setGameUiState(false)
setDeathOverlayVisible(false)
updateLeaderboard(frontEndPlayers)

window.addEventListener('resize', () => {
  syncMobileViewportHeightVar()
  syncCanvasSize()
  updateLeaderboard(frontEndPlayers)
})

window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    syncMobileViewportHeightVar()
    syncCanvasSize()
    updateLeaderboard(frontEndPlayers)
  }, 150)
})

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    syncMobileViewportHeightVar()
    syncCanvasSize()
  })
}

window.addEventListener('blur', () => {
  clearPlayerInputs()
})
