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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
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
  playerInputs.length = 0
  resetMobileMovement()
  resetMobileAim()
  stopAutoFire()
}

function openMainMenuOverlay() {
  usernameOverlayEl.style.display = 'flex'
  setDeathOverlayVisible(false)
  setGameUiState(false)

  if (usernameInputEl && !isTouchDevice) {
    usernameInputEl.focus()
    usernameInputEl.select()
  }
}

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

socket.on('roomStats', (stats) => {
  roomState.roomId = stats.roomId
  roomState.maxPlayers = stats.maxPlayers
  world.width = stats.world.width
  world.height = stats.world.height
})

socket.on('updateProjectiles', (backEndProjectiles) => {
  for (const id in backEndProjectiles) {
    const backEndProjectile = backEndProjectiles[id]

    if (!frontEndProjectiles[id]) {
      frontEndProjectiles[id] = new Projectile({
        x: backEndProjectile.x,
        y: backEndProjectile.y,
        radius: backEndProjectile.radius,
        color: frontEndPlayers[backEndProjectile.playerId]?.color,
        velocity: backEndProjectile.velocity
      })
    } else {
      frontEndProjectiles[id].x = backEndProjectile.x
      frontEndProjectiles[id].y = backEndProjectile.y
      frontEndProjectiles[id].velocity = backEndProjectile.velocity
    }
  }

  for (const frontEndProjectileId in frontEndProjectiles) {
    if (!backEndProjectiles[frontEndProjectileId]) {
      delete frontEndProjectiles[frontEndProjectileId]
    }
  }
})

socket.on('updatePlayers', (backEndPlayers) => {
  const now = performance.now()
  if (now - lastLeaderboardUpdateAt > 200) {
    updateLeaderboard(backEndPlayers)
    lastLeaderboardUpdateAt = now
  }

  for (const id in backEndPlayers) {
    const backEndPlayer = backEndPlayers[id]

    if (!frontEndPlayers[id]) {
      frontEndPlayers[id] = new Player({
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
        isAlive: backEndPlayer.isAlive
      })
    } else {
      frontEndPlayers[id].target = {
        x: backEndPlayer.x,
        y: backEndPlayer.y
      }

      frontEndPlayers[id].score = backEndPlayer.score
      frontEndPlayers[id].kills = backEndPlayer.kills
      frontEndPlayers[id].deaths = backEndPlayer.deaths
      frontEndPlayers[id].hp = backEndPlayer.hp
      frontEndPlayers[id].maxHp = backEndPlayer.maxHp
      frontEndPlayers[id].isAlive = backEndPlayer.isAlive

      if (id === socket.id) {
        const lastBackendInputIndex = playerInputs.findIndex((input) => {
          return backEndPlayer.sequenceNumber === input.sequenceNumber
        })

        if (lastBackendInputIndex > -1)
          playerInputs.splice(0, lastBackendInputIndex + 1)

        playerInputs.forEach((input) => {
          frontEndPlayers[id].target.x += input.dx
          frontEndPlayers[id].target.y += input.dy
        })
      }
    }
  }

  // this is where we delete frontend players
  for (const id in frontEndPlayers) {
    if (!backEndPlayers[id]) {
      if (id === socket.id) {
        clearPlayerInputs()
        openMainMenuOverlay()
      }

      delete frontEndPlayers[id]
    }
  }

  syncPlayerUiState()
})

let animationId
function animate() {
  animationId = requestAnimationFrame(animate)
  c.clearRect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)

  const localPlayer = frontEndPlayers[socket.id]
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

  for (const id in frontEndPlayers) {
    const frontEndPlayer = frontEndPlayers[id]

    // linear interpolation
    if (frontEndPlayer.target) {
      frontEndPlayers[id].x +=
        (frontEndPlayers[id].target.x - frontEndPlayers[id].x) * 0.5
      frontEndPlayers[id].y +=
        (frontEndPlayers[id].target.y - frontEndPlayers[id].y) * 0.5
    }

    frontEndPlayer.draw(camera)
  }

  for (const id in frontEndProjectiles) {
    const frontEndProjectile = frontEndProjectiles[id]
    frontEndProjectile.x += frontEndProjectile.velocity.x
    frontEndProjectile.y += frontEndProjectile.velocity.y
    frontEndProjectile.draw(camera)
  }

  drawMiniMap()
}

animate()

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

const SPEED = 5
const playerInputs = []
let sequenceNumber = 0
setInterval(() => {
  const localPlayer = frontEndPlayers[socket.id]
  if (!localPlayer || !localPlayer.isAlive) return

  if (keys.w.pressed) {
    sequenceNumber++
    playerInputs.push({ sequenceNumber, dx: 0, dy: -SPEED })
    socket.emit('keydown', { keycode: 'KeyW', sequenceNumber })
  }

  if (keys.a.pressed) {
    sequenceNumber++
    playerInputs.push({ sequenceNumber, dx: -SPEED, dy: 0 })
    socket.emit('keydown', { keycode: 'KeyA', sequenceNumber })
  }

  if (keys.s.pressed) {
    sequenceNumber++
    playerInputs.push({ sequenceNumber, dx: 0, dy: SPEED })
    socket.emit('keydown', { keycode: 'KeyS', sequenceNumber })
  }

  if (keys.d.pressed) {
    sequenceNumber++
    playerInputs.push({ sequenceNumber, dx: SPEED, dy: 0 })
    socket.emit('keydown', { keycode: 'KeyD', sequenceNumber })
  }
}, 15)

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
})

document.querySelector('#usernameForm').addEventListener('submit', (event) => {
  event.preventDefault()

  if (usernameInputEl) {
    usernameInputEl.blur()
  }

  usernameOverlayEl.style.display = 'none'
  setDeathOverlayVisible(false)
  playerInputs.length = 0

  socket.emit('initGame', {
    username: usernameInputEl ? usernameInputEl.value : ''
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
