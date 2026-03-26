class Player {
  constructor({
    x,
    y,
    radius,
    color,
    username,
    score = 0,
    kills = 0,
    deaths = 0,
    hp = 100,
    maxHp = 100,
    isAlive = true
  }) {
    this.x = x
    this.y = y
    this.radius = radius
    this.color = color
    this.username = username
    this.score = score
    this.kills = kills
    this.deaths = deaths
    this.hp = hp
    this.maxHp = maxHp
    this.isAlive = isAlive
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

    c.font = '12px sans-serif'
    c.fillStyle = 'white'
    c.fillText(this.username, renderX - 16, renderY + 24)

    if (this.isAlive) {
      const hpWidth = 36
      const hpRatio = Math.max(0, this.hp) / this.maxHp
      c.fillStyle = 'rgba(0,0,0,0.55)'
      c.fillRect(renderX - hpWidth / 2, renderY - this.radius - 14, hpWidth, 4)
      c.fillStyle = '#34d399'
      c.fillRect(
        renderX - hpWidth / 2,
        renderY - this.radius - 14,
        hpWidth * hpRatio,
        4
      )
    }

    c.save()
    c.shadowColor = this.isAlive ? this.color : '#f97316'
    c.shadowBlur = this.isAlive ? 20 : 10
    c.globalAlpha = this.isAlive ? 1 : 0.35
    c.beginPath()
    c.arc(renderX, renderY, this.radius, 0, Math.PI * 2, false)
    c.fillStyle = this.isAlive ? this.color : '#64748b'
    c.fill()
    c.restore()
  }
}
