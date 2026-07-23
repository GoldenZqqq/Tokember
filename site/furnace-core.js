/**
 * Interactive Tokember furnace-core mark (three.js + glTF).
 * Uses a canvas-only 3D Hero with morphing armor and a local fire flipbook.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createProceduralFlame, resolveCoreQuality } from './furnace-flame.js'
import { createCompactPose, createShellMesh } from './furnace-shells.js'

const MODEL_URL = new URL('./assets/tokember-core.glb', import.meta.url).href
const IDLE_SPIN = 0.28
const DRAG_SCALE = 0.0055
const VELOCITY_DAMP = 0.92
const TILT_LIMIT = 0.42
const CORE_PARTS = new Set([
  'RingSeg_Gold', 'RingSeg_Orange', 'RingSeg_Hot',
  'InnerCore', 'InnerGlow', 'EmberRing',
])

const BRAND_MATERIALS = {
  RingSeg_Gold: { color: 0xfbbf24, emissive: 0xf59e0b, emissiveIntensity: 1.35, metalness: 0.55, roughness: 0.28 },
  RingSeg_Orange: { color: 0xf97316, emissive: 0xea580c, emissiveIntensity: 1.55, metalness: 0.5, roughness: 0.26 },
  RingSeg_Hot: { color: 0xea580c, emissive: 0xc2410c, emissiveIntensity: 1.7, metalness: 0.48, roughness: 0.24 },
  FlameTip: { color: 0xff7a12, emissive: 0xff6200, emissiveIntensity: 2.6, metalness: 0.08, roughness: 0.32 },
  InnerCore: { color: 0x120c08, emissive: 0x7c2d12, emissiveIntensity: 0.55, metalness: 0.85, roughness: 0.4 },
  InnerGlow: { color: 0xff6b00, emissive: 0xff6b00, emissiveIntensity: 0.9, metalness: 0, roughness: 1, transparent: true, opacity: 0.22 },
  EmberRing: { color: 0xfbbf24, emissive: 0xfbbf24, emissiveIntensity: 2.8, metalness: 0.2, roughness: 0.4 },
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

function seededRandom(seed = 17) {
  let value = seed >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 4294967296
  }
}

function resolveBrandKey(...candidates) {
  const aliases = {
    Sphere: 'InnerCore',
    'Sphere.001': 'InnerGlow',
    Torus: 'EmberRing',
    Mat_Gold: 'RingSeg_Gold',
    Mat_Orange: 'RingSeg_Orange',
    Mat_Hot: 'RingSeg_Hot',
    Mat_Flame: 'FlameTip',
    Mat_Core: 'InnerCore',
    Mat_Glow: 'InnerGlow',
    Mat_Ember: 'EmberRing',
  }
  for (const raw of candidates) {
    if (!raw) continue
    const clean = String(raw).replace(/_mesh$/i, '').replace(/\.\d+$/, '').trim()
    if (BRAND_MATERIALS[clean]) return clean
    if (aliases[clean]) return aliases[clean]
    for (const key of Object.keys(BRAND_MATERIALS)) {
      if (clean === key || clean.startsWith(key) || clean.includes(key)) return key
    }
  }
  return ''
}

function brandMaterial(key) {
  const spec = BRAND_MATERIALS[key]
  if (!spec) return null
  const material = new THREE.MeshStandardMaterial({
    color: spec.color,
    emissive: new THREE.Color(spec.emissive),
    emissiveIntensity: spec.emissiveIntensity,
    metalness: spec.metalness,
    roughness: spec.roughness,
    transparent: Boolean(spec.transparent),
    opacity: spec.opacity ?? 1,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  material.name = key
  return material
}

function applyBrandMaterials(root) {
  root.traverse(node => {
    if (!node.isMesh) return
    const sourceMat = Array.isArray(node.material) ? node.material[0] : node.material
    const key = resolveBrandKey(node.name, sourceMat?.name)
    const material = brandMaterial(key)
    if (material) node.material = material
    node.castShadow = false
    node.receiveShadow = false
  })
}

function fitCameraToObject(camera, object, offset = 1.35) {
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  object.position.sub(center)
  const maxDim = Math.max(size.x, size.y, size.z, 0.001)
  const fov = camera.fov * (Math.PI / 180)
  const distance = (maxDim / (2 * Math.tan(fov / 2))) * offset
  camera.position.set(0.15 * distance, 0.08 * distance, distance)
  camera.near = distance / 100
  camera.far = distance * 20
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
}

function wrapMotionParts(model) {
  const nodes = []
  model.traverse(node => {
    if (node.isMesh && CORE_PARTS.has(node.name)) nodes.push(node)
  })
  model.updateWorldMatrix(true, true)
  let shellIndex = 0
  return nodes.map((node, index) => {
    const parent = node.parent
    if (!parent) return null
    const motion = new THREE.Group()
    motion.name = `${node.name}Motion`
    motion.position.copy(node.position)
    motion.quaternion.copy(node.quaternion)
    motion.scale.copy(node.scale)
    parent.remove(node)
    parent.add(motion)
    motion.add(node)
    node.position.set(0, 0, 0)
    node.quaternion.identity()
    node.scale.set(1, 1, 1)
    motion.updateWorldMatrix(true, true)
    const worldCenter = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3())
    const center = motion.worldToLocal(worldCenter)
    const expanded = {
      position: motion.position.clone(),
      quaternion: motion.quaternion.clone(),
      scale: motion.scale.clone(),
    }
    const currentShellIndex = node.name.startsWith('RingSeg_') ? shellIndex++ : -1
    const shell = currentShellIndex >= 0
      ? createShellMesh(node, center, currentShellIndex)
      : null
    if (shell) {
      node.visible = false
      motion.add(shell)
    }
    return {
      name: node.name,
      motion,
      shell,
      center,
      expanded,
      compact: createCompactPose(node.name, center, currentShellIndex >= 0 ? currentShellIndex : index, expanded),
    }
  }).filter(Boolean)
}

function applyPiecePose(piece, reveal) {
  if (piece.shell) piece.shell.morphTargetInfluences[0] = 1 - reveal
  piece.motion.position.copy(piece.compact.position).lerp(piece.expanded.position, reveal)
  piece.motion.quaternion.copy(piece.compact.quaternion).slerp(piece.expanded.quaternion, reveal)
  piece.motion.scale.copy(piece.compact.scale).lerp(piece.expanded.scale, reveal)
}

function createGlowTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext('2d')
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64)
  gradient.addColorStop(0, 'rgba(255, 177, 49, 0.9)')
  gradient.addColorStop(0.18, 'rgba(249, 115, 22, 0.36)')
  gradient.addColorStop(0.58, 'rgba(249, 115, 22, 0.08)')
  gradient.addColorStop(1, 'rgba(249, 115, 22, 0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 128, 128)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function createHaloLayer(texture, color, size, opacity, z) {
  const material = new THREE.SpriteMaterial({
    map: texture,
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.position.z = z
  sprite.scale.set(size, size, 1)
  return sprite
}

function createEmberField(texture, count) {
  const random = seededRandom()
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const particles = []
  const warm = new THREE.Color(0xf59e0b)
  const cyan = new THREE.Color(0x5cdde6)
  for (let index = 0; index < count; index += 1) {
    const radius = 1.45 + random() * 1.35
    const angle = random() * Math.PI * 2
    const height = (random() - 0.5) * 1.6
    const offset = index * 3
    positions[offset] = Math.cos(angle) * radius
    positions[offset + 1] = height
    positions[offset + 2] = Math.sin(angle) * radius * 0.64
    const color = index % 7 === 0 ? cyan : warm
    colors[offset] = color.r
    colors[offset + 1] = color.g
    colors[offset + 2] = color.b
    particles.push({ angle, radius, height, speed: 0.08 + random() * 0.15, phase: random() * 6.28 })
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  const material = new THREE.PointsMaterial({
    map: texture,
    size: 0.07,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  return { geometry, material, points: new THREE.Points(geometry, material), particles }
}

function updateEmberField(field, time, delta, reveal) {
  const positions = field.geometry.attributes.position.array
  field.particles.forEach((particle, index) => {
    particle.angle += particle.speed * delta * (1 + reveal * 0.4)
    const wobble = Math.sin(time * 0.9 + particle.phase) * 0.07
    const offset = index * 3
    positions[offset] = Math.cos(particle.angle) * (particle.radius + wobble)
    positions[offset + 1] = particle.height + Math.sin(time * 0.7 + particle.phase) * 0.05
    positions[offset + 2] = Math.sin(particle.angle) * (particle.radius + wobble) * 0.64
  })
  field.geometry.attributes.position.needsUpdate = true
  field.material.opacity = 0.34 + reveal * 0.2
}

function createEffects(root, quality) {
  const texture = createGlowTexture()
  const group = new THREE.Group()
  const warmHalo = createHaloLayer(texture, 0xf97316, 2.7, 0.22, -0.65)
  const cyanHalo = createHaloLayer(texture, 0x36d5e0, 1.35, 0.1, -0.72)
  const field = createEmberField(texture, quality.emberCount)
  group.add(warmHalo, cyanHalo, field.points)
  root.add(group)
  return { texture, group, warmHalo, cyanHalo, field }
}

function createFurnaceCore(stage, canvas, status) {
  if (!stage || !canvas) return () => {}
  if (!window.WebGLRenderingContext) {
    stage.dataset.modelState = 'unavailable'
    if (status) status.textContent = 'Interactive furnace core unavailable.'
    return () => {}
  }
  const quality = resolveCoreQuality()
  stage.dataset.coreQuality = quality.name
  stage.dataset.flameState = 'procedural'
  stage.dataset.shellPose = 'enclosing'
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' })
  } catch {
    stage.dataset.modelState = 'unavailable'
    if (status) status.textContent = 'Interactive furnace core unavailable.'
    return () => {}
  }
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100)
  const root = new THREE.Group()
  const pivot = new THREE.Group()
  const effects = createEffects(root, quality)
  root.add(pivot)
  scene.add(root)
  addLighting(scene)

  let frame = 0
  let running = false
  let intersecting = true
  let modelReady = false
  let pieces = []
  let flame = null
  let baseEmissive = new Map()
  let pulse = 0
  const state = {
    reveal: 0,
    targetReveal: 0,
    pinned: false,
    hovering: false,
    focused: false,
    dragging: false,
    moved: false,
    suppressClick: false,
    lastX: 0,
    lastY: 0,
    pointerId: null,
    yaw: -0.22,
    pitch: -0.1,
    vYaw: 0,
    vPitch: 0,
  }
  const clock = new THREE.Clock()
  stage.dataset.coreState = 'compact'

  function resize() {
    const rect = stage.getBoundingClientRect()
    const width = Math.max(1, rect.width)
    const height = Math.max(1, rect.height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  function setLive(isLive) {
    stage.classList.toggle('is-live', isLive)
    stage.dataset.modelState = isLive ? 'ready' : 'unavailable'
    if (status) status.textContent = isLive
      ? 'Interactive furnace core ready.'
      : 'Interactive furnace core unavailable.'
  }
  function captureEmissive(object) {
    baseEmissive = new Map()
    object.traverse(node => {
      if (!node.isMesh || !node.material) return
      const materials = Array.isArray(node.material) ? node.material : [node.material]
      materials.forEach(material => {
        if ('emissiveIntensity' in material) baseEmissive.set(material, material.emissiveIntensity)
      })
    })
  }

  function updateEmissive(time) {
    const breath = reducedMotion.matches ? 0 : 0.08 * Math.sin(time * 1.6)
    for (const [material, base] of baseEmissive) {
      material.emissiveIntensity = base * (1 + breath + pulse * 0.48 + (1 - state.reveal) * 0.12)
    }
  }

  function syncTarget(pulseOnReveal = true) {
    const next = state.pinned || state.hovering || state.focused ? 1 : 0
    if (next !== state.targetReveal && next > state.targetReveal && pulseOnReveal) pulse = 1
    state.targetReveal = next
    stage.dataset.coreState = next ? 'revealed' : 'compact'
    stage.dataset.shellPose = next ? 'separated' : 'enclosing'
    renderStillFrame()
  }

  function togglePinned() {
    state.pinned = !state.pinned
    syncTarget()
  }
  function updatePose(time, delta) {
    state.reveal = reducedMotion.matches
      ? state.targetReveal
      : THREE.MathUtils.damp(state.reveal, state.targetReveal, 5.8, delta)
    pieces.forEach(piece => applyPiecePose(piece, state.reveal))
    const motion = reducedMotion.matches ? 0 : 1
    root.position.y = Math.sin(time * 0.72) * 0.045 * motion
    root.position.x = Math.cos(time * 0.41) * 0.018 * motion
    root.rotation.z = Math.sin(time * 0.37) * 0.015 * motion
    pivot.rotation.order = 'YXZ'
    pivot.rotation.y = state.yaw
    pivot.rotation.x = state.pitch
    effects.group.rotation.y = Math.sin(time * 0.24) * 0.12 * motion
    effects.warmHalo.material.opacity = 0.18 + state.reveal * 0.1 + pulse * 0.12
    effects.cyanHalo.material.opacity = 0.07 + state.reveal * 0.05
    const haloScale = 1 + state.reveal * 0.12 + pulse * 0.2
    effects.warmHalo.scale.setScalar(2.7 * haloScale)
    effects.cyanHalo.scale.setScalar(1.35 * haloScale)
    updateEmberField(effects.field, time, delta, state.reveal)
    flame?.update(time, state.reveal, pulse, reducedMotion.matches)
    pulse = Math.max(0, pulse - delta * 2.4)
    updateEmissive(time)
  }

  function tick() {
    if (!running) return
    const delta = Math.min(clock.getDelta(), 0.05)
    const time = clock.elapsedTime
    if (!state.dragging) {
      const damping = Math.pow(VELOCITY_DAMP, delta * 60)
      state.vYaw *= damping
      state.vPitch *= damping
      state.vPitch += (-0.1 - state.pitch) * 1.8 * delta
    }
    state.yaw += state.vYaw + (reducedMotion.matches ? 0 : IDLE_SPIN * delta)
    state.pitch = THREE.MathUtils.clamp(state.pitch + state.vPitch, -TILT_LIMIT, TILT_LIMIT)
    updatePose(time, delta)
    renderer.render(scene, camera)
    frame = window.requestAnimationFrame(tick)
  }

  function setRunning(shouldRun) {
    if (shouldRun && !running) {
      running = true
      clock.start()
      frame = window.requestAnimationFrame(tick)
    } else if (!shouldRun && running) {
      running = false
      window.cancelAnimationFrame(frame)
    }
  }

  function renderStillFrame() {
    if (!modelReady || !reducedMotion.matches || !intersecting || document.hidden) return
    updatePose(clock.elapsedTime, 0)
    renderer.render(scene, camera)
  }
  function sync() {
    setRunning(intersecting && !document.hidden && modelReady && !reducedMotion.matches)
    renderStillFrame()
  }

  function onPointerDown(event) {
    if (!modelReady) return
    state.dragging = true
    state.moved = false
    state.pointerId = event.pointerId
    state.lastX = event.clientX
    state.lastY = event.clientY
    state.vYaw = 0
    state.vPitch = 0
    stage.setPointerCapture?.(event.pointerId)
    stage.classList.add('is-dragging')
  }

  function onPointerMove(event) {
    if (!state.dragging || event.pointerId !== state.pointerId) return
    const dx = event.clientX - state.lastX
    const dy = event.clientY - state.lastY
    state.lastX = event.clientX
    state.lastY = event.clientY
    if (Math.abs(dx) + Math.abs(dy) > 5) state.moved = true
    state.yaw += dx * DRAG_SCALE
    state.pitch = THREE.MathUtils.clamp(state.pitch + dy * DRAG_SCALE, -TILT_LIMIT, TILT_LIMIT)
    state.vYaw = dx * DRAG_SCALE * 0.35
    state.vPitch = dy * DRAG_SCALE * 0.35
  }

  function releasePointer(event) {
    if (event.pointerId !== state.pointerId) return
    state.suppressClick = state.moved
    state.dragging = false
    state.pointerId = null
    stage.classList.remove('is-dragging')
  }

  function onPointerEnter(event) {
    if (event.pointerType === 'touch') return
    state.hovering = true
    syncTarget()
  }
  function onPointerLeave() {
    state.hovering = false
    syncTarget(false)
  }

  function onFocusIn() {
    state.focused = true
    syncTarget()
  }
  function onFocusOut(event) {
    if (event.relatedTarget instanceof Node && stage.contains(event.relatedTarget)) return
    state.focused = false
    syncTarget(false)
  }

  function onClick(event) {
    if (event.detail === 0) return
    if (state.suppressClick) {
      state.suppressClick = false
      return
    }
    togglePinned()
  }
  function onKeyDown(event) {
    if (event.key === 'Escape') {
      state.pinned = false
      syncTarget(false)
    } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      togglePinned()
    }
  }

  const loader = new GLTFLoader()
  loader.load(
    MODEL_URL,
    gltf => {
      const model = gltf.scene
      applyBrandMaterials(model)
      model.rotateX(Math.PI / 2)
      pivot.add(model)
      const flameTip = model.getObjectByName('FlameTip')
      if (flameTip?.isMesh) {
        flame = createProceduralFlame(pivot, flameTip, quality, mode => {
          stage.dataset.flameState = mode
          renderStillFrame()
        })
      }
      pieces = wrapMotionParts(model)
      fitCameraToObject(camera, pivot, 1.28)
      captureEmissive(model)
      pieces.forEach(piece => applyPiecePose(piece, 0))
      modelReady = true
      setLive(true)
      resize()
      sync()
    },
    undefined,
    () => setLive(false),
  )

  resize()
  const observer = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting
    sync()
  }, { threshold: 0.05 })
  observer.observe(stage)
  window.addEventListener('resize', resize, { passive: true })
  document.addEventListener('visibilitychange', sync)
  stage.addEventListener('pointerdown', onPointerDown)
  stage.addEventListener('pointermove', onPointerMove)
  stage.addEventListener('pointerup', releasePointer)
  stage.addEventListener('pointercancel', releasePointer)
  stage.addEventListener('pointerenter', onPointerEnter)
  stage.addEventListener('pointerleave', onPointerLeave)
  stage.addEventListener('click', onClick)
  stage.addEventListener('focusin', onFocusIn)
  stage.addEventListener('focusout', onFocusOut)
  stage.addEventListener('keydown', onKeyDown)
  reducedMotion.addEventListener?.('change', sync)

  return () => {
    observer.disconnect()
    setRunning(false)
    window.removeEventListener('resize', resize)
    document.removeEventListener('visibilitychange', sync)
    stage.removeEventListener('pointerdown', onPointerDown)
    stage.removeEventListener('pointermove', onPointerMove)
    stage.removeEventListener('pointerup', releasePointer)
    stage.removeEventListener('pointercancel', releasePointer)
    stage.removeEventListener('pointerenter', onPointerEnter)
    stage.removeEventListener('pointerleave', onPointerLeave)
    stage.removeEventListener('click', onClick)
    stage.removeEventListener('focusin', onFocusIn)
    stage.removeEventListener('focusout', onFocusOut)
    stage.removeEventListener('keydown', onKeyDown)
    reducedMotion.removeEventListener?.('change', sync)
    renderer.dispose()
    flame?.dispose()
    effects.field.geometry.dispose()
    effects.field.material.dispose()
    effects.warmHalo.material.dispose()
    effects.cyanHalo.material.dispose()
    effects.texture.dispose()
    root.traverse(node => {
      if (!node.isMesh) return
      node.geometry?.dispose()
      const materials = Array.isArray(node.material) ? node.material : [node.material]
      materials.forEach(material => material?.dispose())
    })
    setLive(false)
  }
}

function addLighting(scene) {
  const key = new THREE.DirectionalLight(0xffc48a, 1.35)
  key.position.set(3.2, 2.4, 4.5)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x5cdde6, 0.35)
  fill.position.set(-3.5, 1.2, 2.2)
  scene.add(fill)
  const rim = new THREE.PointLight(0xff6b00, 18, 12, 2)
  rim.position.set(0.4, 0.6, 1.8)
  scene.add(rim)
  scene.add(new THREE.AmbientLight(0x2a1810, 0.55))
}

const stage = document.querySelector('#furnace-stage')
const canvas = document.querySelector('#furnace-core-canvas')
const status = document.querySelector('#furnace-status')
if (stage instanceof HTMLElement && canvas instanceof HTMLCanvasElement) {
  createFurnaceCore(stage, canvas, status instanceof HTMLElement ? status : null)
}
