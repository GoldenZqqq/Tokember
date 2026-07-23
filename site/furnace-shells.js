import * as THREE from 'three'

const SHELL_COLUMNS = 14
const SHELL_ROWS = 12

function shellPoint(u, v, shellIndex, center, compact) {
  const centerAngle = shellIndex * (Math.PI * 2 / 3) + Math.PI / 6
  if (compact) {
    const theta = centerAngle + (u - 0.5) * 1.78
    const phi = (v - 0.5) * 1.46
    const radius = 0.66 + Math.sin(u * Math.PI) * 0.025
    const radial = Math.cos(phi) * radius
    return new THREE.Vector3(
      center.x + Math.cos(theta) * radial,
      center.y + Math.sin(phi) * radius,
      center.z + Math.sin(theta) * radial,
    )
  }
  const theta = centerAngle + (u - 0.5) * (1.02 + v * 0.18)
  const radial = 0.38 + v * 0.25 + Math.sin(u * Math.PI) * 0.08
  return new THREE.Vector3(
    center.x + Math.cos(theta) * radial,
    center.y + (v - 0.5) * 1.28,
    center.z + Math.sin(theta) * radial,
  )
}

function createShellPositions(center, shellIndex, compact) {
  const count = (SHELL_COLUMNS + 1) * (SHELL_ROWS + 1)
  const positions = new Float32Array(count * 3)
  for (let row = 0; row <= SHELL_ROWS; row += 1) {
    for (let column = 0; column <= SHELL_COLUMNS; column += 1) {
      const index = row * (SHELL_COLUMNS + 1) + column
      const point = shellPoint(column / SHELL_COLUMNS, row / SHELL_ROWS, shellIndex, center, compact)
      const offset = index * 3
      positions[offset] = point.x
      positions[offset + 1] = point.y
      positions[offset + 2] = point.z
    }
  }
  return positions
}

function createShellIndices() {
  const indices = []
  for (let row = 0; row < SHELL_ROWS; row += 1) {
    for (let column = 0; column < SHELL_COLUMNS; column += 1) {
      const start = row * (SHELL_COLUMNS + 1) + column
      const next = start + SHELL_COLUMNS + 1
      indices.push(start, start + 1, next, start + 1, next + 1, next)
    }
  }
  return indices
}

function createShellGeometry(center, shellIndex) {
  const expanded = createShellPositions(center, shellIndex, false)
  const compact = createShellPositions(center, shellIndex, true)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(expanded, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(
    (SHELL_COLUMNS + 1) * (SHELL_ROWS + 1) * 2,
  ), 2))
  geometry.setIndex(createShellIndices())
  const uv = geometry.getAttribute('uv')
  for (let row = 0; row <= SHELL_ROWS; row += 1) {
    for (let column = 0; column <= SHELL_COLUMNS; column += 1) {
      const index = row * (SHELL_COLUMNS + 1) + column
      uv.setXY(index, column / SHELL_COLUMNS, row / SHELL_ROWS)
    }
  }
  geometry.computeVertexNormals()
  const morphPosition = new THREE.Float32BufferAttribute(compact, 3)
  const compactGeometry = geometry.clone()
  compactGeometry.setAttribute('position', morphPosition.clone())
  compactGeometry.computeVertexNormals()
  geometry.morphAttributes.position = [morphPosition]
  geometry.morphAttributes.normal = [compactGeometry.getAttribute('normal').clone()]
  geometry.morphTargetsRelative = false
  compactGeometry.dispose()
  return geometry
}

export function createCompactPose(name, center, index, expanded) {
  const isShell = name.startsWith('RingSeg_')
  const scale = isShell ? 1 : name === 'EmberRing' ? 0.74 : name === 'InnerGlow' ? 1.08 : 1
  const direction = center.lengthSq() > 0.001
    ? center.clone().normalize()
    : new THREE.Vector3(Math.cos(index * 2.1), 0, Math.sin(index * 2.1)).normalize()
  const targetCenter = isShell ? new THREE.Vector3() : direction.multiplyScalar(0.03)
  const quaternion = isShell
    ? new THREE.Quaternion()
    : new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, index * 0.15))
  const transformedCenter = center.clone().multiplyScalar(scale).applyQuaternion(quaternion)
  return {
    position: targetCenter.sub(transformedCenter),
    quaternion,
    scale: new THREE.Vector3(scale, scale, scale),
  }
}

export function createShellMesh(node, center, shellIndex) {
  const mesh = new THREE.Mesh(createShellGeometry(center, shellIndex), node.material)
  mesh.name = `${node.name}GeneratedShell`
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.updateMorphTargets()
  return mesh
}
