const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const FURNACE_SEED = 0x70be4
const MAX_PIXEL_RATIO = 2
const PARTICLE_COUNT = 54

function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

function createParticles() {
  const random = seededRandom(FURNACE_SEED)
  return Array.from({ length: PARTICLE_COUNT }, (_, index) => ({
    phase: random(),
    lane: random() * 2 - 1,
    speed: 0.035 + random() * 0.055,
    radius: 0.8 + random() * 1.7,
    cyan: index % 7 === 0,
  }))
}

function resizeCanvas(canvas, context, viewport) {
  const rect = canvas.getBoundingClientRect()
  const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
  viewport.width = Math.max(1, rect.width)
  viewport.height = Math.max(1, rect.height)
  canvas.width = Math.round(viewport.width * pixelRatio)
  canvas.height = Math.round(viewport.height * pixelRatio)
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
}

function particlePosition(particle, time, viewport) {
  const progress = (particle.phase + time * particle.speed) % 1
  const targetX = viewport.width * (viewport.width < 720 ? 0.5 : 0.76)
  const targetY = viewport.height * (viewport.width < 720 ? 0.62 : 0.42)
  const startX = particle.lane < 0 ? -30 : viewport.width + 30
  const startY = viewport.height * (0.15 + Math.abs(particle.lane) * 0.68)
  const bend = Math.sin(progress * Math.PI) * viewport.height * 0.12 * particle.lane
  return {
    x: startX + (targetX - startX) * progress,
    y: startY + (targetY - startY) * progress + bend,
    alpha: Math.sin(progress * Math.PI) * 0.56,
  }
}

function drawParticles(context, particles, viewport, time) {
  context.clearRect(0, 0, viewport.width, viewport.height)
  context.globalCompositeOperation = 'lighter'
  for (const particle of particles) {
    const point = particlePosition(particle, time, viewport)
    const previous = particlePosition(particle, time - 0.15, viewport)
    const color = particle.cyan ? '92, 221, 230' : '255, 130, 38'
    const gradient = context.createLinearGradient(previous.x, previous.y, point.x, point.y)
    gradient.addColorStop(0, `rgba(${color}, 0)`)
    gradient.addColorStop(1, `rgba(${color}, ${point.alpha})`)
    context.beginPath()
    context.moveTo(previous.x, previous.y)
    context.lineTo(point.x, point.y)
    context.strokeStyle = gradient
    context.lineWidth = particle.radius
    context.stroke()
    context.beginPath()
    context.arc(point.x, point.y, particle.radius * 1.45, 0, Math.PI * 2)
    context.fillStyle = `rgba(${color}, ${point.alpha})`
    context.fill()
  }
  context.globalCompositeOperation = 'source-over'
}

function createFrameLoop(context, particles, viewport) {
  let frame = 0
  let running = false
  const draw = timestamp => {
    if (!running) return
    drawParticles(context, particles, viewport, timestamp / 1000)
    frame = window.requestAnimationFrame(draw)
  }
  return {
    setRunning(shouldRun) {
      if (shouldRun && !running) {
        running = true
        frame = window.requestAnimationFrame(draw)
      } else if (!shouldRun && running) {
        running = false
        window.cancelAnimationFrame(frame)
      }
    },
  }
}

function createFurnace(canvas) {
  const context = canvas.getContext('2d', { alpha: true })
  if (!context || reducedMotion.matches) return () => {}
  const viewport = { width: 0, height: 0 }
  const loop = createFrameLoop(context, createParticles(), viewport)
  let intersecting = true
  const sync = () => loop.setRunning(intersecting && !document.hidden)
  const resize = () => resizeCanvas(canvas, context, viewport)
  const observer = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting
    sync()
  }, { threshold: 0.01 })

  resize()
  observer.observe(canvas)
  window.addEventListener('resize', resize, { passive: true })
  document.addEventListener('visibilitychange', sync)
  sync()

  return () => {
    observer.disconnect()
    loop.setRunning(false)
    window.removeEventListener('resize', resize)
    document.removeEventListener('visibilitychange', sync)
  }
}

function wireCopyButtons() {
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const source = document.querySelector(button.dataset.copy)
      const status = button.parentElement?.querySelector('.copy-status')
      if (!source || !status) return
      try {
        await navigator.clipboard.writeText(source.textContent.trim())
        status.textContent = 'Copied'
      } catch {
        status.textContent = 'Clipboard blocked. Select the command and copy it manually.'
      }
      window.setTimeout(() => { status.textContent = '' }, 1800)
    })
  }
}

const canvas = document.querySelector('#furnace-canvas')
if (canvas instanceof HTMLCanvasElement) createFurnace(canvas)
wireCopyButtons()
