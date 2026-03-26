const gameCanvas = document.querySelector('canvas')
let lastShotInputAt = 0

function handleShootInput(event) {
  if (typeof emitShootAtClientPoint !== 'function') return

  const now = performance.now()
  if (now - lastShotInputAt < 80) return
  lastShotInputAt = now

  emitShootAtClientPoint(event.clientX, event.clientY)
}

gameCanvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.pointerType === 'mouse') return

  handleShootInput(event)
})

// Some desktop browsers can miss pointerdown for tap-to-click setups.
gameCanvas.addEventListener('click', (event) => {
  if (event.button !== 0) return
  handleShootInput(event)
})
