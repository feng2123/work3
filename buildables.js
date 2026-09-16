import * as THREE from 'three'

// ===================== 可搭建物共享系统 =====================
// 包含：空地检测、空地标记环、背包、帐篷、沙滩椅、雪球、雪人模型

/**
 * 程序化寻找"空地"：避开所有物理障碍物 + 地形平坦
 * @param {Array} bodyList 场景物理障碍物列表（sceneBodyList）
 * @param {object} opts
 *  - count 需要找几个点
 *  - radius 搜索半径
 *  - minClear 与障碍物的最小水平距离
 *  - flatness 允许的最大地形起伏
 *  - terrainHeight(x,z) 地形高度函数
 *  - terrainFilter(h,x,z) 额外过滤（如海边只选近水线处）
 *  - center 搜索中心
 */
export function findClearSpots(bodyList, opts = {}) {
  const {
    count = 2,
    radius = 55,
    minClear = 5,
    flatness = 0.25,
    terrainHeight,
    terrainFilter = null,
    center = { x: 0, z: 0 }
  } = opts
  if (!terrainHeight) return []
  const spots = []
  const step = 7
  const candidates = []
  for (let x = -radius; x <= radius; x += step) {
    for (let z = -radius; z <= radius; z += step) {
      const dx = x - center.x
      const dz = z - center.z
      if (dx * dx + dz * dz > radius * radius) continue
      const h = terrainHeight(x, z)
      if (terrainFilter && !terrainFilter(h, x, z)) continue
      // 平坦度：周围 4 点高度差
      const okFlat =
        Math.abs(terrainHeight(x + 3, z) - h) < flatness &&
        Math.abs(terrainHeight(x - 3, z) - h) < flatness &&
        Math.abs(terrainHeight(x, z + 3) - h) < flatness &&
        Math.abs(terrainHeight(x, z - 3) - h) < flatness
      if (!okFlat) continue
      // 避开所有障碍物
      let clear = true
      for (const b of bodyList) {
        const bx = b.position.x - x
        const bz = b.position.z - z
        if (bx * bx + bz * bz < minClear * minClear) { clear = false; break }
      }
      if (!clear) continue
      candidates.push({ x, z, y: h, score: dx * dx + dz * dz })
    }
  }
  candidates.sort((a, b) => a.score - b.score)
  // 保证点之间间距足够
  for (const c of candidates) {
    if (spots.every((s) => (s.x - c.x) * (s.x - c.x) + (s.z - c.z) * (s.z - c.z) > 625)) {
      spots.push(c)
    }
    if (spots.length >= count) break
  }
  return spots
}

/** 空地标记：半透明发光圆环 + 光柱（脉动） */
export function createSpotMarker(color = 0x66ccff) {
  const g = new THREE.Group()
  const ringGeo = new THREE.RingGeometry(1.6, 2.1, 40)
  ringGeo.rotateX(-Math.PI / 2)
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })
  const ring = new THREE.Mesh(ringGeo, ringMat)
  ring.position.y = 0.04
  g.add(ring)
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.25, 16).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false })
  )
  dot.position.y = 0.05
  g.add(dot)
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 1.5, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false })
  )
  beam.position.y = 0.75
  g.add(beam)
  g.userData.pulse = 0
  return g
}

/** 更新标记脉动动画（场景动画循环调用） */
export function updateMarkerPulse(marker, delta) {
  marker.userData.pulse = (marker.userData.pulse || 0) + delta * 2.2
  const k = 0.86 + Math.sin(marker.userData.pulse) * 0.14
  marker.scale.set(k, 1, k)
}

/** 背包：取零件后背在角色身后（kind: 'tent' | 'chair'） */
export function createBackpack(kind = 'tent') {
  const g = new THREE.Group()
  const mainColor = kind === 'tent' ? 0xd9883c : 0x2f9e6e
  const mat = new THREE.MeshStandardMaterial({ color: mainColor, roughness: 0.9 })
  const rollGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.55, 12)
  rollGeo.rotateZ(Math.PI / 2)
  const roll = new THREE.Mesh(rollGeo, mat)
  roll.position.set(0, 0.42, -0.32)
  g.add(roll)
  const capMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 0.9 })
  for (const sx of [-0.26, 0.26]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.23, 10, 8), capMat)
    cap.position.set(sx, 0.42, -0.32)
    g.add(cap)
  }
  const strap = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.55, 0.02),
    new THREE.MeshBasicMaterial({ color: 0x5a4a3a })
  )
  strap.position.set(0, 0.42, -0.42)
  g.add(strap)
  g.position.set(0, 0.75, -0.35)
  return g
}

/** 帐篷模型（金字塔帐篷），userData.seat 为坐入位置（相对） */
export function createTentModel() {
  const g = new THREE.Group()
  const tentMat = new THREE.MeshStandardMaterial({ color: 0xd9883c, roughness: 0.85, side: THREE.DoubleSide })
  const body = new THREE.Mesh(new THREE.ConeGeometry(2.1, 2.4, 4, 1, true), tentMat)
  body.position.y = 1.2
  body.castShadow = true
  g.add(body)
  const doorMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 1, side: THREE.DoubleSide })
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.1), doorMat)
  door.position.set(0, 0.55, 1.55)
  door.rotation.x = Math.PI * 0.12
  g.add(door)
  const flag = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.4, 6), new THREE.MeshBasicMaterial({ color: 0xff6644 }))
  flag.position.y = 2.5
  g.add(flag)
  const padMat = new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 1 })
  const pad = new THREE.Mesh(new THREE.CircleGeometry(1.8, 24), padMat)
  pad.rotation.x = -Math.PI / 2
  pad.position.y = 0.03
  pad.receiveShadow = true
  g.add(pad)
  g.userData.seat = { x: 0, y: 0.35, z: 0 }
  return g
}

/** 沙滩椅（躺椅）模型，userData.seat 为坐入位置（相对） */
export function createBeachChairModel() {
  const g = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({ color: 0xe8d8b8, roughness: 0.85 })
  const armMat = new THREE.MeshStandardMaterial({ color: 0x9a8a6a, roughness: 0.85 })
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.09, 0.62), mat)
  seat.position.set(0, 0.5, 0.05)
  seat.castShadow = true
  g.add(seat)
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.09, 0.95), mat)
  back.position.set(0, 0.95, -0.55)
  back.rotation.x = -0.42
  back.castShadow = true
  g.add(back)
  for (const lx of [-0.72, 0.72]) {
    for (const lz of [0.55, -0.3]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.42, 6), armMat)
      leg.position.set(lx, 0.21, lz)
      g.add(leg)
    }
  }
  const backLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.05, 6), armMat)
  backLeg.position.set(0, 0.62, -0.95)
  backLeg.rotation.x = -0.42
  g.add(backLeg)
  for (const sx of [-0.85, 0.85]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.8), armMat)
    arm.position.set(sx, 0.68, -0.1)
    g.add(arm)
  }
  g.userData.seat = { x: 0, y: 0.62, z: 0.1 }
  return g
}

/** 雪球 */
export function createSnowballMesh(r) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.65,
    emissive: 0x202028,
    emissiveIntensity: 0.04
  })
  const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), mat)
  ball.castShadow = true
  ball.receiveShadow = true
  return ball
}

/** 由三个雪球合成的雪人（底/中/顶 + 眼睛 + 鼻子 + 纽扣 + 手臂） */
export function createBuildSnowman() {
  const g = new THREE.Group()
  const snowMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0.05,
    emissive: 0x202028,
    emissiveIntensity: 0.04
  })
  const parts = [[1.0, 0.85], [0.72, 1.9], [0.52, 2.72]]
  for (const [r, y] of parts) {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), snowMat)
    ball.position.y = y
    ball.castShadow = true
    g.add(ball)
  }
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.3 })
  for (const ex of [-0.18, 0.18]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), darkMat)
    eye.position.set(ex, 2.86, 0.42)
    g.add(eye)
  }
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.4, 8), new THREE.MeshStandardMaterial({ color: 0xff8c30, roughness: 0.6 }))
  nose.position.set(0, 2.72, 0.55)
  nose.rotation.x = Math.PI / 2.4
  g.add(nose)
  for (let i = 0; i < 3; i++) {
    const btn = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), darkMat)
    btn.position.set(0, 2.2 - i * 0.28, 0.66)
    g.add(btn)
  }
  const twigMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 1 })
  const armL = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 5), twigMat)
  armL.position.set(-0.72, 2.3, 0.1)
  armL.rotation.z = Math.PI / 3
  g.add(armL)
  const armR = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 5), twigMat)
  armR.position.set(0.72, 2.3, 0.1)
  armR.rotation.z = -Math.PI / 3
  g.add(armR)
  return g
}
