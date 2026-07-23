import * as THREE from 'three'

const FLAME_ATLAS_URL = new URL('./assets/fire-flipbook-5x5.png', import.meta.url).href
const FLAME_GRID = 5
const FLAME_FRAMES = 25

const FULL_QUALITY = Object.freeze({
  name: 'full', emberCount: 56, flameLayers: 3, flameFps: 18, maxPixelRatio: 1.75,
})
const LITE_QUALITY = Object.freeze({
  name: 'lite', emberCount: 30, flameLayers: 2, flameFps: 12, maxPixelRatio: 1.25,
})

export function resolveCoreQuality() {
  const memory = Number(navigator.deviceMemory || 8)
  const cores = Number(navigator.hardwareConcurrency || 8)
  const constrained = window.innerWidth <= 640 || memory <= 4 || cores <= 4
  return constrained ? LITE_QUALITY : FULL_QUALITY
}

const ribbonVertexShader = `
  uniform float uTime;
  uniform float uSeed;
  uniform float uMotion;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec3 point = position;
    float lift = smoothstep(0.05, 1.0, uv.y);
    float sway = sin(uTime * 2.1 + uv.y * 5.2 + uSeed) * 0.06;
    float lick = sin(uTime * 4.2 - uv.y * 9.0 + uSeed * 1.7) * 0.025;
    point.x += (sway + lick) * lift * uMotion;
    point.z += cos(uTime * 2.5 + uv.y * 7.0 + uSeed) * 0.022 * lift * uMotion;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(point, 1.0);
  }
`

const ribbonFragmentShader = `
  uniform float uTime;
  uniform float uSeed;
  uniform float uMotion;
  uniform float uHeat;
  uniform float uOpacity;
  uniform vec3 uCoreColor;
  uniform vec3 uEdgeColor;
  varying vec2 vUv;

  float hash(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    local = local * local * (3.0 - 2.0 * local);
    return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), local.x),
      mix(hash(cell + vec2(0.0, 1.0)), hash(cell + 1.0), local.x), local.y);
  }

  void main() {
    float time = uTime * uMotion;
    float turbulence = noise(vec2(vUv.x * 4.2 + uSeed, vUv.y * 5.8 - time * 1.45));
    float edge = smoothstep(0.0, 0.22, vUv.x) * smoothstep(1.0, 0.78, vUv.x);
    float base = smoothstep(0.02, 0.08, vUv.y);
    float alpha = edge * base * (0.78 + turbulence * 0.36) * uOpacity;
    if (alpha < 0.012) discard;
    float core = (1.0 - smoothstep(0.1, 0.78, vUv.y)) * (1.0 - abs(vUv.x - 0.5) * 1.4);
    vec3 color = mix(uEdgeColor, uCoreColor, clamp(core + uHeat * 0.18, 0.0, 1.0));
    color *= 0.9 + turbulence * 0.45 + uHeat * 0.16;
    gl_FragColor = vec4(color, alpha);
  }
`

const atlasVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const atlasFragmentShader = `
  uniform sampler2D uMap;
  uniform float uFrame;
  uniform float uGrid;
  uniform float uOpacity;
  uniform float uHeat;
  varying vec2 vUv;

  void main() {
    float frame = floor(uFrame + 0.5);
    float column = mod(frame, uGrid);
    float row = floor(frame / uGrid);
    vec2 atlasUv = vec2((vUv.x + column) / uGrid,
      (vUv.y + (uGrid - 1.0 - row)) / uGrid);
    vec4 texel = texture2D(uMap, atlasUv);
    float luminance = max(max(texel.r, texel.g), texel.b);
    float alpha = texel.a * smoothstep(0.01, 0.08, luminance) * uOpacity;
    if (alpha < 0.012) discard;
    vec3 color = texel.rgb * (0.82 + uHeat * 0.22);
    gl_FragColor = vec4(color, alpha);
  }
`

function createFlameMaterial(seed, inner = false) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uSeed: { value: seed }, uMotion: { value: 1 },
      uHeat: { value: 0 }, uOpacity: { value: inner ? 0.64 : 0.46 },
      uCoreColor: { value: new THREE.Color(inner ? 0xfff4b0 : 0xffb21a) },
      uEdgeColor: { value: new THREE.Color(inner ? 0xff8a00 : 0xe93608) },
    },
    vertexShader: ribbonVertexShader,
    fragmentShader: ribbonFragmentShader,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
}

function createRibbonGeometry(segments = 18, seed = 0) {
  const positions = new Float32Array((segments + 1) * 2 * 3)
  const uvs = new Float32Array((segments + 1) * 2 * 2)
  const indices = []
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments
    const center = Math.sin(t * 3.4 + seed) * 0.07 * t
    const width = 0.28 * Math.pow(1 - t, 0.64) + 0.015
    const y = t
    const offset = index * 6
    positions[offset] = center - width
    positions[offset + 1] = y
    positions[offset + 2] = 0
    positions[offset + 3] = center + width
    positions[offset + 4] = y
    positions[offset + 5] = 0
    const uvOffset = index * 4
    uvs[uvOffset] = 0
    uvs[uvOffset + 1] = t
    uvs[uvOffset + 2] = 1
    uvs[uvOffset + 3] = t
    if (index < segments) {
      const start = index * 2
      indices.push(start, start + 1, start + 2, start + 1, start + 3, start + 2)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.translate(0, -0.5, 0)
  return geometry
}

function flameAnchor(pivot, tip) {
  pivot.updateWorldMatrix(true, true)
  tip.updateWorldMatrix(true, false)
  const box = new THREE.Box3().setFromObject(tip)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const base = new THREE.Vector3(center.x, box.min.y - size.y * 0.015, center.z)
  return {
    position: pivot.worldToLocal(base),
    width: Math.max(size.x * 1.55, size.z * 1.55, 0.62),
    height: Math.max(size.y * 1.22, 1.15),
  }
}

function createRibbonFallback(group, anchor, quality, materials) {
  for (let index = 0; index < quality.flameLayers; index += 1) {
    const geometry = createRibbonGeometry(18, index * 1.73 + 0.4)
    const material = createFlameMaterial(index * 2.3 + 1.7, index === 1)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.x = (index - (quality.flameLayers - 1) / 2) * anchor.width * 0.16
    mesh.position.z = index * 0.018
    mesh.scale.set(anchor.width * (1.03 - index * 0.12), anchor.height * (1 - index * 0.1), 1)
    group.add(mesh)
    materials.push({ material, geometry })
  }
}

function createAtlasMaterial(texture, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture }, uFrame: { value: 0 }, uGrid: { value: FLAME_GRID },
      uOpacity: { value: opacity }, uHeat: { value: 0 },
    },
    vertexShader: atlasVertexShader,
    fragmentShader: atlasFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
}

function createFlameLayers(anchor, quality) {
  const group = new THREE.Group()
  group.name = 'FlameEffect'
  group.position.copy(anchor.position)
  const fallbackGroup = new THREE.Group()
  fallbackGroup.name = 'ProceduralFlame'
  const fallbackMaterials = []
  createRibbonFallback(fallbackGroup, anchor, quality, fallbackMaterials)
  group.add(fallbackGroup)

  const atlasGroup = new THREE.Group()
  atlasGroup.name = 'FireFlipbook'
  atlasGroup.visible = false
  const atlasMaterial = createAtlasMaterial(null, quality.name === 'full' ? 0.82 : 0.74)
  const atlasMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), atlasMaterial)
  atlasMesh.scale.set(anchor.width * 1.16, anchor.height * 1.22, 1)
  atlasMesh.position.y = anchor.height * 0.03
  atlasGroup.add(atlasMesh)
  group.add(atlasGroup)
  const light = new THREE.PointLight(0xff6a00, 10, 5, 2)
  light.position.y = anchor.height * 0.42
  group.add(light)
  return { group, fallbackGroup, fallbackMaterials, atlasGroup, atlasMaterial, atlasMesh, light }
}

function loadFireAtlas(state, onModeChange) {
  const loader = new THREE.TextureLoader()
  loader.load(FLAME_ATLAS_URL, texture => {
    if (state.disposed) {
      texture.dispose()
      return
    }
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    state.atlasMaterial.uniforms.uMap.value = texture
    state.atlasGroup.visible = true
    state.fallbackGroup.visible = false
    state.atlasReady = true
    onModeChange?.('flipbook')
  }, undefined, () => {
    if (!state.disposed) onModeChange?.('procedural')
  })
}

function updateFlame(state, quality, time, reveal, pulse, frozen) {
  const motion = frozen ? 0 : 1
  const heat = 0.35 + reveal * 0.3 + pulse * 0.35
  state.fallbackMaterials.forEach(({ material }) => {
    material.uniforms.uTime.value = frozen ? 0.85 : time
    material.uniforms.uMotion.value = motion
    material.uniforms.uHeat.value = heat
  })
  if (state.atlasReady) {
    const frame = Math.floor((frozen ? 0 : time) * quality.flameFps) % FLAME_FRAMES
    state.atlasMaterial.uniforms.uFrame.value = frame
    state.atlasMaterial.uniforms.uHeat.value = heat
  }
  const breath = frozen ? 1 : 1 + Math.sin(time * 3.2) * 0.035
  state.group.scale.set(breath, breath * (1 + reveal * 0.08), breath)
  state.light.intensity = 8 + heat * 8 + (frozen ? 0 : Math.sin(time * 7.1) * 1.4)
}

function disposeFlame(state, pivot) {
  state.disposed = true
  pivot.remove(state.group)
  state.fallbackMaterials.forEach(({ material, geometry }) => {
    geometry.dispose()
    material.dispose()
  })
  state.atlasMesh.geometry.dispose()
  const texture = state.atlasMaterial.uniforms.uMap.value
  if (texture) texture.dispose()
  state.atlasMaterial.dispose()
}

export function createProceduralFlame(pivot, tip, quality, onModeChange) {
  const state = {
    ...createFlameLayers(flameAnchor(pivot, tip), quality),
    atlasReady: false,
    disposed: false,
  }
  pivot.add(state.group)
  tip.visible = false
  loadFireAtlas(state, onModeChange)
  return {
    update: (time, reveal, pulse, frozen) => {
      updateFlame(state, quality, time, reveal, pulse, frozen)
    },
    dispose: () => disposeFlame(state, pivot),
  }
}
