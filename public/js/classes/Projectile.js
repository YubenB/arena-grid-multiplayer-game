class Projectile {
  constructor({ x, y, radius, color = 'white', velocity }) {
    this.x = x
    this.y = y
    this.radius = radius
    this.color = color
    this.velocity = velocity
  }

  draw(camera) {
    const viewport = window.__GAME_VIEWPORT || { width: 1366, height: 768 }
    const renderX = this.x - camera.x
    const renderY = this.y - camera.y

    if (
      renderX + this.radius < 0 ||
      renderX - this.radius > viewport.width ||
      renderY + this.radius < 0 ||
      renderY - this.radius > viewport.height
    ) {
      return
    }

    c.save()
    c.shadowColor = this.color
    c.shadowBlur = 20
    c.beginPath()
    c.arc(renderX, renderY, this.radius, 0, Math.PI * 2, false)
    c.fillStyle = this.color
    c.fill()
    c.restore()
  }

  update() {
    this.draw()
    this.x = this.x + this.velocity.x
    this.y = this.y + this.velocity.y
  }
}
