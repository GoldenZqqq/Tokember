import * as THREE from 'three'

const FULL_QUALITY = Object.freeze({
  name: 'full', emberCount: 56, flamePlanes: 3, maxPixelRatio: 1.75,
})
const LITE_QUALITY = Object.freeze({
  name: 'lite', emberCount: 30, flamePlanes: 2, maxPixelRatio: 1.25,
})

export function resolveCoreQuality() {
  const memory = Number(navigator.deviceMemory || 8)
  const cores = Number(navigator.hardwareConcurrency || 8)
  const constrained = window.innerWidth <= 640 || memory <= 4 || cores <= 4
  return constrained ? LITE_QUALITY : FULL_QUALITY
}

const vertexShader = `
  uniform float uTime;
  uniform float uSeed;
  uniform float uMotion;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec3 point = position;
    float lift = smoothstep(0.05, 1.0, uv.y);
    float primary = sin(uTime * 2.5 + uv.y * 5.8 + uSeed) * 0.12;
    float secondary = sin(uTime * 4.1 - uv.y * 9.0 + uSeed * 1.7) * 0.05;
    point.x += (primary + secondary) * lift * uMotion;
    point.z += cos(uTime * 2.0 + uv.y * 7.0 + uSeed) * 0.035 * lift * uMotion;
    point.y *= 1.0 + sin(uTime * 3.3 + uSeed) * 0.035 * uMotion;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(point, 1.0);
  }
`

const fragmentShader = `
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

  float flameNoise(vec2 point) {
    float first = noise(point);
    float second = noise(point * 2.15 + 7.3) * 0.5;
    float third = noise(point * 4.1 + 13.7) * 0.25;
    return (first + second + third) / 1.75;
  }

  void main() {
    float time = uTime * uMotion;
    float y = vUv.y;
    float x = (vUv.x - 0.5) * 2.0;
    float turbulence = flameNoise(vec2(vUv.x * 2.7 + uSeed, y * 5.4 - time * 1.7));
    float drift = (turbulence - 0.5) * 0.34;

    float center = drift * 0.48 + sin(time * 2.4 + uSeed) * 0.13 * y;
    float centerWidth = mix(0.70, 0.035, pow(y, 0.78));
    float central = 1.0 - smoothstep(centerWidth, centerWidth + 0.095, abs(x - center));
    float centralTip = 1.0 - smoothstep(0.78 + turbulence * 0.14, 1.02, y);

    float leftCenter = -0.40 + drift * 0.35 + sin(time * 2.8 + uSeed * 1.4) * 0.14 + y * 0.12;
    float leftWidth = mix(0.34, 0.018, pow(y, 0.76));
    float left = 1.0 - smoothstep(leftWidth, leftWidth + 0.075, abs(x - leftCenter));
    left *= 1.0 - smoothstep(0.58 + turbulence * 0.16, 0.98, y);

    float rightCenter = 0.33 + drift * 0.28 + sin(time * 2.1 + uSeed * 2.1) * 0.11 - y * 0.09;
    float rightWidth = mix(0.29, 0.014, pow(y, 0.82));
    float right = 1.0 - smoothstep(rightWidth, rightWidth + 0.07, abs(x - rightCenter));
    right *= 1.0 - smoothstep(0.66 + turbulence * 0.12, 0.99, y);

    float body = max(central * centralTip, max(left, right));
    float baseRuffle = 0.83 + noise(vec2(x * 3.5 + uSeed, time * 0.35)) * 0.27;
    float baseHeight = 0.006 + pow(min(abs(x), 1.0), 1.7) * 0.04;
    baseHeight += (noise(vec2(x * 4.2 + uSeed, time * 0.42)) - 0.5) * 0.018;
    float base = smoothstep(baseHeight, baseHeight + 0.022, y);
    float alpha = body * base * baseRuffle * (0.8 + turbulence * 0.34) * uOpacity;
    if (alpha < 0.015) discard;
    float core = central * (1.0 - smoothstep(0.18, 0.84, y));
    vec3 color = mix(uEdgeColor, uCoreColor, clamp(core + uHeat * 0.18, 0.0, 1.0));
    color *= 0.88 + turbulence * 0.5 + uHeat * 0.2;
    gl_FragColor = vec4(color, alpha);
  }
`

function createFlameMaterial(seed, inner = false) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uSeed: { value: seed }, uMotion: { value: 1 },
      uHeat: { value: 0 }, uOpacity: { value: inner ? 0.58 : 0.42 },
      uCoreColor: { value: new THREE.Color(inner ? 0xfff4b0 : 0xffb21a) },
      uEdgeColor: { value: new THREE.Color(inner ? 0xff8a00 : 0xe93608) },
    },
    vertexShader, fragmentShader, transparent: true, side: THREE.DoubleSide,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  })
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

function addFlamePlanes(group, geometry, anchor, quality, materials) {
  for (let index = 0; index < quality.flamePlanes; index += 1) {
    const angle = index * Math.PI / quality.flamePlanes
    const outer = new THREE.Mesh(geometry, createFlameMaterial(1.7 + index * 2.3))
    outer.rotation.y = angle
    outer.rotation.z = index === 0 ? 0.02 : index % 2 ? -0.08 : 0.11
    outer.position.x = index === 0 ? 0 : (index % 2 ? -0.08 : 0.08) * anchor.width
    outer.scale.set(anchor.width * 1.08, anchor.height, 1)
    group.add(outer)
    materials.push(outer.material)
    const inner = new THREE.Mesh(geometry, createFlameMaterial(5.1 + index * 1.9, true))
    inner.rotation.y = angle + 0.11
    inner.rotation.z = index % 2 ? 0.06 : -0.04
    inner.position.x = (index % 2 ? -0.045 : 0.045) * anchor.width
    inner.position.y = anchor.height * 0.02
    inner.scale.set(anchor.width * 0.62, anchor.height * 0.72, 1)
    group.add(inner)
    materials.push(inner.material)
    if (quality.name === 'full') {
      const lick = new THREE.Mesh(geometry, createFlameMaterial(8.4 + index * 1.3))
      lick.position.set((index % 2 ? -0.18 : 0.18) * anchor.width, anchor.height * 0.03, 0)
      lick.rotation.z = index % 2 ? -0.16 : 0.12
      lick.scale.set(anchor.width * 0.46, anchor.height * 0.76, 1)
      group.add(lick)
      materials.push(lick.material)
    }
  }
}

export function createProceduralFlame(pivot, tip, quality) {
  const anchor = flameAnchor(pivot, tip)
  const group = new THREE.Group()
  group.name = 'ProceduralFlame'
  group.position.copy(anchor.position)
  const geometry = new THREE.PlaneGeometry(1, 1, 12, 24)
  geometry.translate(0, 0.5, 0)
  const materials = []
  addFlamePlanes(group, geometry, anchor, quality, materials)
  const light = new THREE.PointLight(0xff6a00, 10, 5, 2)
  light.position.y = anchor.height * 0.42
  group.add(light)
  pivot.add(group)
  tip.visible = false
  return {
    update(time, reveal, pulse, frozen) {
      const motion = frozen ? 0 : 1
      const heat = 0.35 + reveal * 0.3 + pulse * 0.35
      materials.forEach(material => {
        material.uniforms.uTime.value = frozen ? 0.85 : time
        material.uniforms.uMotion.value = motion
        material.uniforms.uHeat.value = heat
      })
      const breath = frozen ? 1 : 1 + Math.sin(time * 3.2) * 0.035
      group.scale.set(breath, breath * (1 + reveal * 0.08), breath)
      light.intensity = 8 + heat * 8 + (frozen ? 0 : Math.sin(time * 7.1) * 1.4)
    },
    dispose() {
      pivot.remove(group)
      geometry.dispose()
      materials.forEach(material => material.dispose())
    },
  }
}
