import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js'
import * as CANNON from 'cannon-es'
import { initBeach, disposeBeach } from './beachScene.js'
import { initSnow, disposeSnow } from './snowScene.js'
import { setActiveScene, createMoon } from './envManager.js'
import { createBirdController } from './birdController.js'

// ===================== 全局变量 =====================
let scene, camera, renderer, controls, clock
let world, composer, leafParticles
let grassMesh, grassVelocities
const sceneMeshList = []
const sceneBodyList = []
const textureLoader = new THREE.TextureLoader()
const treeGroups = []
const cloudGroups = [] // 云朵数组
let sunLight, sunLensflare, ambientLight // 太阳光与镜头光晕
let rainPoints = null   // 雨滴粒子（雨天显示）
let moon = null         // 月亮（夜空发光 + 月光）
// 玩家小人
let playerMesh, playerBody
const playerKeys = { w: false, a: false, s: false, d: false, shift: false }
let cameraYaw = 0
let cameraPitch = 0.25
let isOrbitMode = false
// 鸟（可骑乘切换）
let birdController = null
// 坐下交互
const sitTargets = []  // 可坐目标：{x, z, y}
let isSitting = false
let sitTargetRef = null
// 场景切换支持
let animationFrameId = null
let eventAbortController = null
let onTeleportCallback = null
const wind = {
  time: 0,
  strength: 0.06,
  speed: 0.6
}
// 蓝天白云增强配置（云朵显著版）
const FOREST_CONFIG = {
  groundSize: 240,
  treeCount: 60,
  rockCount: 25,
  hillCount: 12,
  // 高山参数（连绵山脉）
  mountainRangeCount: 6,
  mountainPeaksPerRange: 5,
  mountainHeight: [18, 35],
  mountainRadius: [10, 18],
  mountainDistance: [110, 150],
  // 雾效：指数雾包裹远处，营造纵深感
  fogColor: 0xa8c8d8,
  fogNear: 60,
  fogFar: 220,
  boundX: 115,
  // 云朵增强参数
  cloudCount: 50,
  cloudHeightRange: [40, 100],
  cloudMoveSpeed: 0.012,
  cloudScale: 2.0,
  cloudDensity: 1.5,
  // 草地参数
  grassCount: 14000,
  grassAreaRadius: 110,
  grassSize: 1.5,
  grassSizeVariance: 0.6,
  // 正午太阳光参数
  sunPos: new THREE.Vector3(50, 90, 40),
  sunColor: 0xffffff,
  sunIntensity: 2.0
}

// ===================== 纹理加载工具 =====================
function createTex(path, repeatX = 20, repeatZ = 20, isNormalDX = false) {
  const tex = textureLoader.load(
    `/texture/${path}`,
    () => console.log(`✅ 贴图加载成功: /texture/${path}`),
    undefined,
    () => console.warn(`❌ 贴图缺失 404: /texture/${path}，自动使用纯色`)
  )
  if (tex) {
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(repeatX, repeatZ)
    if (renderer) {
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
    }
    if (isNormalDX) {
      tex.colorSpace = THREE.NoColorSpace
    }
  }
  return tex
}

// ========== 场景纹理资源 ==========
const groundColorTex = createTex('Ground037_1K-JPG/Ground037_1K-JPG_Color.jpg', 30, 30)
const groundRoughTex = createTex('Ground037_1K-JPG/Ground037_1K-JPG_Roughness.jpg', 30, 30)
const groundNormalDXTex = createTex('Ground037_1K-JPG/Ground037_1K-JPG_NormalDX.jpg', 30, 30, true)
const barkColorTex = createTex('Bark012_1K-JPG/Bark012_1K-JPG_Color.jpg', 3, 6)
const barkRoughTex = createTex('Bark012_1K-JPG/Bark012_1K-JPG_Roughness.jpg', 3, 6)
const rockColorTex = createTex('Rock060_1K-JPG/Rock060_1K-JPG_Color.jpg', 2, 2)
const rockRoughTex = createTex('Rock060_1K-JPG/Rock060_1K-JPG_Roughness.jpg', 2, 2)
const rockNormalDXTex = createTex('Rock060_1K-JPG/Rock060_1K-JPG_NormalDX.jpg', 2, 2, true)
const rockColorTex2 = createTex('Rock051_1K-JPG/Rock051_1K-JPG_Color.jpg', 2, 2)
const rockRoughTex2 = createTex('Rock051_1K-JPG/Rock051_1K-JPG_Roughness.jpg', 2, 2)
const rockNormalDXTex2 = createTex('Rock051_1K-JPG/Rock051_1K-JPG_NormalDX.jpg', 2, 2, true)
const leafColorTex = new THREE.TextureLoader();
const texture2 = leafColorTex.load(
  'public/leaf.png',
  () => console.log("树叶纹理加载成功"),
  undefined,
  (err) => console.error("树叶贴图加载失败：", err)
);

// 云朵、镜头光晕在线贴图（无需本地资源）
const cloudTex = textureLoader.load('https://threejs.org/examples/textures/lensflare/cloud.png')
const flareTex0 = textureLoader.load('https://threejs.org/examples/textures/lensflare/lensflare0.png')
const flareTex1 = textureLoader.load('https://threejs.org/examples/textures/lensflare/lensflare1.png')

// 草地纹理
const grassTex = textureLoader.load(
  '/grass.png',
  () => console.log('✅ 草地贴图加载成功'),
  undefined,
  () => console.warn('❌ 草地贴图缺失，使用顶点色草地')
)


// ===================== 初始化Three渲染 =====================
function initThree() {
  scene = new THREE.Scene()
  // 天蓝色背景，远处与雾色融合
  scene.background = new THREE.Color(0x8bb8d8)
  scene.fog = new THREE.Fog(FOREST_CONFIG.fogColor, FOREST_CONFIG.fogNear, FOREST_CONFIG.fogFar)
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000)
  camera.position.set(0, 22, 45)
  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.3
  document.body.appendChild(renderer.domElement)
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.05
  controls.enabled = false // 默认使用第三人称跟随，OrbitControls 备用
  clock = new THREE.Clock()

  // 使用 AbortController 统一管理事件监听，便于场景切换时清理
  eventAbortController = new AbortController()
  const { signal } = eventAbortController

  // 鼠标拖动旋转第三人称视角
  let isDragging = false
  let lastMouseX = 0
  let lastMouseY = 0
  renderer.domElement.addEventListener('mousedown', (e) => {
    isDragging = true
    lastMouseX = e.clientX
    lastMouseY = e.clientY
  }, { signal })
  window.addEventListener('mouseup', () => { isDragging = false }, { signal })
  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return
    const dx = e.clientX - lastMouseX
    const dy = e.clientY - lastMouseY
    cameraYaw -= dx * 0.005
    // 放宽 pitch 范围到 ±1.5（约 ±85°），可抬头看天空、低头看地面
    cameraPitch = Math.max(-1.5, Math.min(1.5, cameraPitch + dy * 0.005))
    lastMouseX = e.clientX
    lastMouseY = e.clientY
  }, { signal })

  // 键盘控制
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase()
    if (k === 'w') playerKeys.w = true
    if (k === 'a') playerKeys.a = true
    if (k === 's') playerKeys.s = true
    if (k === 'd') playerKeys.d = true
    if (k === 'shift') playerKeys.shift = true
    // 按 V 切换自由视角
    if (k === 'v') {
      isOrbitMode = !isOrbitMode
      controls.enabled = isOrbitMode
    }
    // 按 E：坐下/起身 或 靠近鸟时切换人物与鸟
    if (k === 'e') {
      if (birdController && birdController.isBirdMode()) {
        birdController.toggleMode()
      } else if (isSitting) {
        standUp()
      } else {
        const target = findNearestSitTarget()
        if (target) {
          sitDown(target)
        } else if (birdController && birdController.isNearBird()) {
          birdController.toggleMode()
        }
      }
    }
  }, { signal })
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase()
    if (k === 'w') playerKeys.w = false
    if (k === 'a') playerKeys.a = false
    if (k === 's') playerKeys.s = false
    if (k === 'd') playerKeys.d = false
    if (k === 'shift') playerKeys.shift = false
  }, { signal })

  // 冷调环境光，模拟晴天漫反射
  ambientLight = new THREE.AmbientLight(0xf0f8ff, 0.55)
  scene.add(ambientLight)

  // ========== 太阳光 + 镜头光晕 ==========
  sunLight = new THREE.DirectionalLight(FOREST_CONFIG.sunColor, FOREST_CONFIG.sunIntensity)
  sunLight.position.copy(FOREST_CONFIG.sunPos)
  sunLight.castShadow = true
  sunLight.shadow.mapSize.set(4096, 4096)
  sunLight.shadow.camera.left = -160
  sunLight.shadow.camera.right = 160
  sunLight.shadow.camera.top = 160
  sunLight.shadow.camera.bottom = -160
  sunLight.shadow.bias = 0.0008
  sunLight.shadow.radius = 4
  scene.add(sunLight)

  // 太阳镜头光晕
  const lensflare = new Lensflare()
  lensflare.addElement(new LensflareElement(flareTex0, 220, 0, sunLight.color))
  lensflare.addElement(new LensflareElement(flareTex1, 120, 0.6))
  lensflare.addElement(new LensflareElement(flareTex1, 70, 0.7))
  lensflare.addElement(new LensflareElement(flareTex1, 120, 0.9))
  lensflare.addElement(new LensflareElement(flareTex1, 70, 1))
  sunLight.add(lensflare)
  sunLensflare = lensflare

  window.addEventListener('resize', onWindowResize, { signal })
}

// 后期泛光（柔和天光，不刺眼）
function initPostProcess() {
  composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.25,
    0.20,
    0.85
  )
  composer.addPass(bloomPass)
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  composer.setSize(window.innerWidth, window.innerHeight)
}

// ===================== 初始化Cannon物理 =====================
function initPhysics() {
  world = new CANNON.World()
  world.gravity.set(0, -9.8, 0)
  world.broadphase = new CANNON.SAPBroadphase(world)
  world.allowSleep = true
  world.defaultContactMaterial.friction = 0.3
  world.defaultContactMaterial.restitution = 0
  // 提高接触硬度：球体不会陷入地面，减少上坡抖动
  world.defaultContactMaterial.contactEquationStiffness = 1e8
  world.defaultContactMaterial.contactEquationRelaxation = 3
  // 玩家材质：低摩擦，不粘地
  world.solver.iterations = 20 // 提高迭代次数，增强碰撞精度防穿模
  world.solver.tolerance = 0.001
}

// ===================== 地面生成（凹凸不平山地地形） =====================
// 全局高度查询函数，供其他物体贴地用
function getTerrainHeight(x, z) {
  // 多层正弦噪声模拟自然起伏
  const n1 = Math.sin(x * 0.04) * Math.cos(z * 0.035) * 1.8
  const n2 = Math.sin(x * 0.09 + z * 0.07) * 0.9
  const n3 = Math.sin(x * 0.15 - z * 0.12) * 0.4
  // 边缘抬高，形成山谷感
  const dist = Math.sqrt(x * x + z * z)
  const edge = Math.max(0, (dist - 80) / 60) * 2.5
  return n1 + n2 + n3 + edge
}

function createGround() {
  const size = FOREST_CONFIG.groundSize
  const groundGeo = new THREE.PlaneGeometry(size, size, 80, 80)
  groundGeo.rotateX(-Math.PI / 2)

  // 顶点位移：根据噪声函数抬高/降低
  const posAttr = groundGeo.attributes.position
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i)
    const z = posAttr.getZ(i)
    posAttr.setY(i, getTerrainHeight(x, z))
  }
  posAttr.needsUpdate = true
  groundGeo.computeVertexNormals()

  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x76c464,
    emissive: 0x183010,
    emissiveIntensity: 0.10,
    map: groundColorTex,
    roughnessMap: groundRoughTex,
    normalMap: groundNormalDXTex,
    normalScale: new THREE.Vector2(0.25, 0.25),
    roughness: 0.9
  })
  const groundMesh = new THREE.Mesh(groundGeo, groundMat)
  groundMesh.receiveShadow = true
  scene.add(groundMesh)
  sceneMeshList.push(groundMesh)

  // 注意：地面不创建物理体。
  // 原因：Trimesh 三角形对球体的碰撞响应会让玩家在斜坡上卡住，
  //       每帧重力把球往下拉、三角形把球推回，导致上坡走不动。
  // 解决：玩家 y 由 updatePlayer 里的 getTerrainHeight 手动平滑控制，
  //       只保留玩家与树/石/枯木的碰撞。
}

// ===================== 草地生成（3D 草丛 mesh，低矮自然） =====================
function createGrass() {
  const { grassCount, grassAreaRadius, grassSize, grassSizeVariance } = FOREST_CONFIG

  // 构建 3D 草丛几何体：8 片细叶围成一圈，纯顶点色
  const bladeCount = 8
  const positions = []
  const colors = []
  const indices = []

  const baseColor = new THREE.Color(0x356b18)
  const midColor = new THREE.Color(0x4f8a28)
  const tipColor = new THREE.Color(0x7bbf3a)

  for (let b = 0; b < bladeCount; b++) {
    const angle = (b / bladeCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
    const tiltOut = 0.1 + Math.random() * 0.15

    const h = 0.25 + Math.random() * 0.12
    const w = 0.05 + Math.random() * 0.02
    const r = 0.015 + Math.random() * 0.025

    // 底部两点（垂直于半径方向展开）
    const bx = Math.cos(angle) * r
    const bz = Math.sin(angle) * r
    const perpX = -Math.sin(angle) * w * 0.5
    const perpZ = Math.cos(angle) * w * 0.5

    // 顶部一点（向外倾斜）
    const tx = Math.cos(angle) * (r + h * Math.sin(tiltOut))
    const tz = Math.sin(angle) * (r + h * Math.sin(tiltOut))
    const ty = h

    const baseIdx = b * 3
    positions.push(
      bx - perpX, 0, bz - perpZ,
      bx + perpX, 0, bz + perpZ,
      tx, ty, tz
    )
    indices.push(baseIdx, baseIdx + 1, baseIdx + 2)

    // 顶点色：底部深绿 → 顶部浅绿
    const cb = baseColor.clone().lerp(midColor, Math.random() * 0.3)
    const ct = midColor.clone().lerp(tipColor, Math.random() * 0.3)
    colors.push(cb.r, cb.g, cb.b, cb.r, cb.g, cb.b, ct.r, ct.g, ct.b)
  }

  const tuftGeo = new THREE.BufferGeometry()
  tuftGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  tuftGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  tuftGeo.setIndex(indices)
  tuftGeo.computeVertexNormals()

  const tuftMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.8,
    metalness: 0,
    emissive: new THREE.Color(0x0a1a05),
    emissiveIntensity: 0.05
  })

  grassMesh = new THREE.InstancedMesh(tuftGeo, tuftMat, grassCount)
  grassMesh.castShadow = false
  grassMesh.receiveShadow = false

  // 每丛颜色微调
  const instanceColors = new Float32Array(grassCount * 3)

  const dummy = new THREE.Object3D()
  grassVelocities = []

  for (let i = 0; i < grassCount; i++) {
    let x, z
    let attempts = 0
    do {
      const angle = Math.random() * Math.PI * 2
      const radius = Math.sqrt(Math.random()) * grassAreaRadius
      x = Math.cos(angle) * radius
      z = Math.sin(angle) * radius
      attempts++
    } while (Math.sqrt(x * x + z * z) < 6 && attempts < 10)

    const sizeScale = grassSize + (Math.random() - 0.5) * grassSizeVariance
    const yRot = Math.random() * Math.PI * 2
    const ty = getTerrainHeight(x, z)

    dummy.position.set(x, ty, z)
    dummy.rotation.set(0, yRot, 0)
    dummy.scale.setScalar(sizeScale)
    dummy.updateMatrix()
    grassMesh.setMatrixAt(i, dummy.matrix)

    // 每丛色相微调
    const tint = new THREE.Color().setHSL(
      0.23 + (Math.random() - 0.5) * 0.04,
      0.4 + Math.random() * 0.2,
      0.35 + (Math.random() - 0.5) * 0.1
    )
    instanceColors[i * 3] = tint.r
    instanceColors[i * 3 + 1] = tint.g
    instanceColors[i * 3 + 2] = tint.b

    grassVelocities.push({
      x, z, yRot,
      baseScale: sizeScale,
      phase: Math.random() * Math.PI * 2,
      stiffness: 0.3 + Math.random() * 0.4
    })
  }

  grassMesh.instanceColor = new THREE.InstancedBufferAttribute(instanceColors, 3)
  grassMesh.instanceMatrix.needsUpdate = true
  scene.add(grassMesh)
  sceneMeshList.push(grassMesh)
}

// ===================== 云朵生成（3D 球体堆叠真实感云朵） =====================
function createCloud(x, z, baseHeight) {
  const cloudGroup = new THREE.Group()

  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    emissive: 0xffffff,
    emissiveIntensity: 0.15
  })

  const cloudScale = FOREST_CONFIG.cloudScale
  const cloudDensity = FOREST_CONFIG.cloudDensity

  // 核心云团：大球体堆叠，形成厚实感
  const puffCount = Math.floor(10 * cloudDensity)
  for (let i = 0; i < puffCount; i++) {
    const radius = (4 + Math.random() * 8) * cloudScale * 0.5
    const puffGeo = new THREE.SphereGeometry(radius, 10, 7)
    const puff = new THREE.Mesh(puffGeo, cloudMat.clone())

    puff.material.opacity = 0.55 + Math.random() * 0.25

    // 椭球变形，更自然
    const sx = 1.2 + Math.random() * 0.8
    const sy = 0.5 + Math.random() * 0.3
    const sz = 1.0 + Math.random() * 0.6
    puff.scale.set(sx, sy, sz)

    // 位置分散，形成蓬松云朵
    puff.position.set(
      (Math.random() - 0.5) * 18 * cloudDensity,
      (Math.random() - 0.5) * 4 * cloudScale,
      (Math.random() - 0.5) * 12 * cloudDensity
    )

    puff.rotation.set(
      Math.random() * Math.PI,
      Math.random() * Math.PI,
      Math.random() * Math.PI
    )

    cloudGroup.add(puff)
  }

  // 顶部高光层：更亮更薄，模拟云顶受光
  const topCount = Math.floor(5 * cloudDensity)
  for (let i = 0; i < topCount; i++) {
    const radius = (3 + Math.random() * 5) * cloudScale * 0.5
    const topGeo = new THREE.SphereGeometry(radius, 8, 6)
    const topMat = cloudMat.clone()
    topMat.opacity = 0.45
    topMat.emissiveIntensity = 0.35
    const topPuff = new THREE.Mesh(topGeo, topMat)

    topPuff.scale.set(1.3, 0.35, 1.0)
    topPuff.position.set(
      (Math.random() - 0.5) * 14 * cloudDensity,
      3 * cloudScale + Math.random() * 2,
      (Math.random() - 0.5) * 10 * cloudDensity
    )

    cloudGroup.add(topPuff)
  }

  // 底部阴影层：稍暗，增加立体感
  const bottomCount = Math.floor(4 * cloudDensity)
  for (let i = 0; i < bottomCount; i++) {
    const radius = (3.5 + Math.random() * 6) * cloudScale * 0.5
    const botGeo = new THREE.SphereGeometry(radius, 8, 6)
    const botMat = cloudMat.clone()
    botMat.opacity = 0.5
    botMat.emissiveIntensity = 0.05
    botMat.color.setHex(0xe8e8f0)
    const botPuff = new THREE.Mesh(botGeo, botMat)

    botPuff.scale.set(1.1, 0.4, 0.9)
    botPuff.position.set(
      (Math.random() - 0.5) * 16 * cloudDensity,
      -2.5 * cloudScale - Math.random() * 2,
      (Math.random() - 0.5) * 11 * cloudDensity
    )

    cloudGroup.add(botPuff)
  }

  cloudGroup.position.set(x, baseHeight, z)
  cloudGroup.userData.originX = x
  cloudGroup.userData.puffs = cloudGroup.children
  cloudGroups.push(cloudGroup)
  scene.add(cloudGroup)
  sceneMeshList.push(cloudGroup)
}

// ===================== 树冠：简单几何体堆积 =====================
function createSimpleCrown(parent, scale = 1) {
  const crownGroup = new THREE.Group()
  const greenBase = new THREE.Color(0x4e7a32)
  const greenDark = new THREE.Color(0x3a5f24)
  const greenLight = new THREE.Color(0x679d45)
  const crownShapes = [
    { type: 'sphere', scale: 1.05, y: 5.2, size: 2.8 },
    { type: 'sphere', scale: 0.9, y: 6.4, size: 2.2 },
    { type: 'sphere', scale: 0.85, y: 4.6, size: 2.0, offsetX: 1.1, offsetZ: 0.6 },
    { type: 'sphere', scale: 0.85, y: 4.8, size: 2.0, offsetX: -0.9, offsetZ: 0.9 },
    { type: 'sphere', scale: 0.75, y: 5.0, size: 1.8, offsetX: 0.4, offsetZ: -1.2 },
    { type: 'ellipsoid', scale: 0.9, y: 3.9, sizeX: 2.6, sizeY: 1.4, sizeZ: 2.6 },
    { type: 'cone', scale: 0.8, y: 7.8, size: 1.8, height: 2.4 },
    { type: 'cylinder', scale: 0.75, y: 7.2, radiusTop: 1.6, radiusBottom: 2.0, height: 1.8 }
  ]
  crownShapes.forEach((shapeDef) => {
    let geo
    const s = shapeDef.scale * scale
    if (shapeDef.type === 'sphere') {
      geo = new THREE.SphereGeometry(shapeDef.size * s, 8, 6)
    }
    if (shapeDef.type === 'ellipsoid') {
      geo = new THREE.SphereGeometry(1, 8, 6)
      geo.scale(shapeDef.sizeX * s, shapeDef.sizeY * s, shapeDef.sizeZ * s)
    }
    if (shapeDef.type === 'cone') {
      geo = new THREE.ConeGeometry(shapeDef.size * s, shapeDef.height * s, 8)
    }
    if (shapeDef.type === 'cylinder') {
      geo = new THREE.CylinderGeometry(
        shapeDef.radiusTop * s,
        shapeDef.radiusBottom * s,
        shapeDef.height * s,
        8
      )
    }
    const mat = new THREE.MeshStandardMaterial({
      color: greenBase.clone().lerp(Math.random() > 0.5 ? greenDark : greenLight, 0.25),
      roughness: 0.9,
      emissive: new THREE.Color(0x081004),
      emissiveIntensity: 0.04,
      map: texture2
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.y = shapeDef.y * scale
    if (shapeDef.offsetX) mesh.position.x = shapeDef.offsetX * scale
    if (shapeDef.offsetZ) mesh.position.z = shapeDef.offsetZ * scale
    mesh.castShadow = true
    mesh.receiveShadow = true
    crownGroup.add(mesh)
  })
  parent.add(crownGroup)
  return crownGroup
}

// ===================== 小几何体模拟树叶细节 =====================
function addLeafDetails(parent, scale = 1) {
  const detailCount = Math.floor(35 + scale * 25)
  for (let i = 0; i < detailCount; i++) {
    const leafGroup = new THREE.Group()
    const leafType = Math.random()
    let geo
    let size = 0.18 + Math.random() * 0.35
    if (leafType < 0.4) {
      geo = new THREE.BoxGeometry(size, size * 0.6, size * 0.15)
    } else if (leafType < 0.75) {
      geo = new THREE.SphereGeometry(size * 0.5, 6, 4)
    } else {
      geo = new THREE.ConeGeometry(size * 0.4, size * 0.9, 6)
    }
    const hue = 0.22 + Math.random() * 0.12
    const sat = 0.45 + Math.random() * 0.1
    const light = 0.35 + Math.random() * 0.18
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(hue, sat, light),
      roughness: 0.9,
      emissive: new THREE.Color(0x040802),
      emissiveIntensity: 0.03
    })
    const mesh = new THREE.Mesh(geo, mat)
    const angle = Math.random() * Math.PI * 2
    const radius = Math.random() * 2.8 * scale
    const height = 3.5 * scale + Math.random() * 4.5 * scale
    mesh.position.set(
      Math.cos(angle) * radius,
      height,
      Math.sin(angle) * radius
    )
    mesh.rotation.set(
      (Math.random() - 0.5) * 1.2,
      Math.random() * Math.PI,
      (Math.random() - 0.5) * 0.6
    )
    mesh.castShadow = true
    mesh.receiveShadow = true
    leafGroup.add(mesh)
    parent.add(leafGroup)
  }
}

// ===================== 树木 =====================
function createTree(posX, posZ, scale = 1, rotY = 0, tiltX = 0, tiltZ = 0) {
  const treeGroup = new THREE.Group()
  treeGroups.push(treeGroup)
  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x6b4423,
    emissive: 0x181006,
    emissiveIntensity: 0.05,
    map: barkColorTex,
    roughnessMap: barkRoughTex,
    roughness: 1
  })
  const trunkGeo = new THREE.CylinderGeometry(0.4 * scale, 0.6 * scale, 4 * scale, 8)
  const trunkMesh = new THREE.Mesh(trunkGeo, trunkMat)
  trunkMesh.position.y = 2 * scale
  trunkMesh.castShadow = true
  treeGroup.add(trunkMesh)
  createSimpleCrown(treeGroup, scale)
  addLeafDetails(treeGroup, scale)
  treeGroup.rotation.y = rotY
  treeGroup.rotation.x = tiltX
  treeGroup.rotation.z = tiltZ
  treeGroup.position.set(posX, getTerrainHeight(posX, posZ), posZ)
  scene.add(treeGroup)
  sceneMeshList.push(treeGroup)
  const trunkBody = new CANNON.Body({ mass: 0 })
  trunkBody.addShape(new CANNON.Cylinder(0.4 * scale, 0.6 * scale, 4 * scale, 8))
  // 物理体对齐树干位置：底部贴地，中心在 2*scale 高度
  trunkBody.position.set(posX, getTerrainHeight(posX, posZ) + 2 * scale, posZ)
  world.addBody(trunkBody)
  sceneBodyList.push(trunkBody)
}

// ===================== 岩石 =====================
function createRock(posX, posZ, size) {
  const rockGeo = new THREE.DodecahedronGeometry(size, 0)
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x777777,
    emissive: 0x111111,
    emissiveIntensity: 0.04,
    map: rockColorTex,
    roughnessMap: rockRoughTex,
    normalMap: rockNormalDXTex,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.95
  })
  const rockMesh = new THREE.Mesh(rockGeo, rockMat)
  rockMesh.position.set(posX, getTerrainHeight(posX, posZ) + size * 0.5, posZ)
  rockMesh.castShadow = true
  rockMesh.receiveShadow = true
  scene.add(rockMesh)
  sceneMeshList.push(rockMesh)
  const rockBody = new CANNON.Body({ mass: 0 })
  rockBody.addShape(new CANNON.Sphere(size * 0.8))
  // 物理体对齐岩石位置：底部贴地，中心在 size*0.5 高度
  rockBody.position.set(posX, getTerrainHeight(posX, posZ) + size * 0.5, posZ)
  world.addBody(rockBody)
  sceneBodyList.push(rockBody)
  // 登记为可坐目标（坐在石头顶部）
  sitTargets.push({ x: posX, z: posZ, y: getTerrainHeight(posX, posZ) + size * 0.5 })
}

// ===================== 土坡 =====================
function createHill(posX, posZ, r, h) {
  const hillGeo = new THREE.CylinderGeometry(0, r, h, 12)
  const hillMat = new THREE.MeshStandardMaterial({
    color: 0x689e4f,
    emissive: 0x102008,
    emissiveIntensity: 0.07,
    roughness: 1
  })
  const hillMesh = new THREE.Mesh(hillGeo, hillMat)
  const hillY = getTerrainHeight(posX, posZ)
  hillMesh.position.set(posX, hillY + h / 2, posZ)
  hillMesh.receiveShadow = true
  scene.add(hillMesh)
  sceneMeshList.push(hillMesh)
  const hillBody = new CANNON.Body({ mass: 0 })
  hillBody.addShape(new CANNON.Cylinder(0, r, h, 12))
  hillBody.position.set(posX, h / 2, posZ)
  world.addBody(hillBody)
  sceneBodyList.push(hillBody)
}

// ===================== 枯木装饰（倒伏/倾斜的枯树干） =====================
function createDeadwood(posX, posZ) {
  const len = 3 + Math.random() * 4
  const radius = 0.2 + Math.random() * 0.2
  const group = new THREE.Group()

  // 主干：不规则圆柱
  const trunkGeo = new THREE.CylinderGeometry(radius * 0.6, radius, len, 6, 3)
  // 顶点扰动让树干弯曲
  const posAttr = trunkGeo.attributes.position
  for (let i = 0; i < posAttr.count; i++) {
    const y = posAttr.getY(i)
    const bend = Math.sin(y * 0.5) * 0.15
    posAttr.setX(i, posAttr.getX(i) + bend)
    posAttr.setZ(i, posAttr.getZ(i) + Math.cos(y * 0.4) * 0.1)
  }
  posAttr.needsUpdate = true
  trunkGeo.computeVertexNormals()

  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x5a4a38,
    roughness: 1,
    metalness: 0,
    flatShading: true,
    map: barkColorTex,
    roughnessMap: barkRoughTex,
    emissive: 0x1a1208,
    emissiveIntensity: 0.04
  })
  const trunk = new THREE.Mesh(trunkGeo, trunkMat)
  trunk.castShadow = true
  trunk.receiveShadow = true
  group.add(trunk)

  // 少量枯枝
  const branchCount = 2 + Math.floor(Math.random() * 3)
  for (let b = 0; b < branchCount; b++) {
    const bLen = 0.8 + Math.random() * 1.2
    const bGeo = new THREE.CylinderGeometry(0.05, 0.1, bLen, 5)
    const branch = new THREE.Mesh(bGeo, trunkMat)
    branch.position.set(
      (Math.random() - 0.5) * len * 0.5,
      (Math.random() - 0.5) * len * 0.4,
      0
    )
    branch.rotation.z = (Math.random() - 0.5) * 1.5
    branch.rotation.y = Math.random() * Math.PI * 2
    branch.castShadow = true
    group.add(branch)
  }

  // 随机倒伏角度：部分倒地、部分倾斜站立
  const isFallen = Math.random() > 0.4
  if (isFallen) {
    group.rotation.z = Math.PI / 2 + (Math.random() - 0.5) * 0.3
    group.rotation.y = Math.random() * Math.PI * 2
    group.position.set(posX, getTerrainHeight(posX, posZ) + radius, posZ)
  } else {
    group.rotation.z = (Math.random() - 0.5) * 0.5
    group.rotation.x = (Math.random() - 0.5) * 0.4
    group.position.set(posX, getTerrainHeight(posX, posZ) + len * 0.4, posZ)
  }

  scene.add(group)
  sceneMeshList.push(group)

  // 物理体：用 Box 包围枯木，跟随枯木的旋转和位置
  const deadBody = new CANNON.Body({ mass: 0 })
  // Box 半尺寸：长 len/2，宽高用 radius*1.5 给点余量
  const halfLen = len * 0.5
  const halfRad = radius * 1.5
  const boxShape = new CANNON.Box(new CANNON.Vec3(halfLen, halfRad, halfRad))
  deadBody.addShape(boxShape)
  // 同步 group 的位置和旋转到物理体
  deadBody.position.set(group.position.x, group.position.y, group.position.z)
  // three.js 的 Euler 转 cannon 四元数
  deadBody.quaternion.setFromEuler(group.rotation.x, group.rotation.y, group.rotation.z)
  world.addBody(deadBody)
  sceneBodyList.push(deadBody)

  // 倒伏的枯木可坐
  if (isFallen) {
    sitTargets.push({
      x: group.position.x,
      z: group.position.z,
      y: group.position.y + radius * 0.8
    })
  }
}

// ===================== 蘑菇装饰（InstancedMesh） =====================
function createMushrooms() {
  const count = 120
  const halfSize = FOREST_CONFIG.groundSize / 2 - 10

  // 蘑菇几何体：菌盖（半球）+ 菌柄（圆柱）
  const capGeo = new THREE.SphereGeometry(0.25, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)
  capGeo.translate(0, 0.3, 0)
  const stemGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.3, 6)
  stemGeo.translate(0, 0.15, 0)

  // 合并几何体
  const capPos = capGeo.attributes.position.array
  const stemPos = stemGeo.attributes.position.array
  const merged = new Float32Array(capPos.length + stemPos.length)
  merged.set(capPos, 0)
  merged.set(stemPos, capPos.length)
  const mushGeo = new THREE.BufferGeometry()
  mushGeo.setAttribute('position', new THREE.BufferAttribute(merged, 3))
  mushGeo.computeVertexNormals()

  // 两种颜色的蘑菇：红白、棕白
  const mushMatRed = new THREE.MeshStandardMaterial({
    color: 0xc0392b,
    roughness: 0.7,
    metalness: 0,
    emissive: 0x2a0808,
    emissiveIntensity: 0.08,
    flatShading: true
  })
  const mushMatBrown = new THREE.MeshStandardMaterial({
    color: 0x8b6914,
    roughness: 0.7,
    metalness: 0,
    emissive: 0x1a1204,
    emissiveIntensity: 0.08,
    flatShading: true
  })

  const meshRed = new THREE.InstancedMesh(mushGeo, mushMatRed, count / 2)
  const meshBrown = new THREE.InstancedMesh(mushGeo, mushMatBrown, count / 2)
  meshRed.castShadow = true
  meshRed.receiveShadow = true
  meshBrown.castShadow = true
  meshBrown.receiveShadow = true

  const dummy = new THREE.Object3D()
  for (let i = 0; i < count; i++) {
    const x = (Math.random() - 0.5) * halfSize * 1.6
    const z = (Math.random() - 0.5) * halfSize * 1.6
    const ty = getTerrainHeight(x, z)
    const s = 0.6 + Math.random() * 0.8
    dummy.position.set(x, ty, z)
    dummy.rotation.set(0, Math.random() * Math.PI * 2, 0)
    dummy.scale.setScalar(s)
    dummy.updateMatrix()

    if (i < count / 2) {
      meshRed.setMatrixAt(i, dummy.matrix)
    } else {
      meshBrown.setMatrixAt(i - count / 2, dummy.matrix)
    }
  }
  meshRed.instanceMatrix.needsUpdate = true
  meshBrown.instanceMatrix.needsUpdate = true
  scene.add(meshRed)
  scene.add(meshBrown)
  sceneMeshList.push(meshRed, meshBrown)
}

// ===================== 灌木丛（低矮多球堆叠，贴地散布） =====================
function createBush(posX, posZ) {
  const group = new THREE.Group()
  const scale = 0.6 + Math.random() * 0.6

  // 颜色系：深绿到浅绿
  const greens = [0x2d5a1a, 0x3a6b22, 0x4a7d2a, 0x5a8f35]

  // 3-5 个球体堆叠成灌木
  const ballCount = 3 + Math.floor(Math.random() * 3)
  for (let i = 0; i < ballCount; i++) {
    const r = (0.4 + Math.random() * 0.4) * scale
    const geo = new THREE.SphereGeometry(r, 8, 6)
    // 椭球变形
    geo.scale(
      1 + Math.random() * 0.3,
      0.7 + Math.random() * 0.2,
      1 + Math.random() * 0.3
    )
    const mat = new THREE.MeshStandardMaterial({
      color: greens[Math.floor(Math.random() * greens.length)],
      roughness: 0.9,
      metalness: 0,
      flatShading: true,
      emissive: 0x0a1a05,
      emissiveIntensity: 0.04
    })
    const ball = new THREE.Mesh(geo, mat)
    const angle = (i / ballCount) * Math.PI * 2 + Math.random()
    const dist = Math.random() * 0.3 * scale
    ball.position.set(
      Math.cos(angle) * dist,
      r * 0.5 + Math.random() * 0.2,
      Math.sin(angle) * dist
    )
    ball.castShadow = true
    ball.receiveShadow = true
    group.add(ball)
  }

  group.position.set(posX, getTerrainHeight(posX, posZ), posZ)
  group.rotation.y = Math.random() * Math.PI * 2
  scene.add(group)
  sceneMeshList.push(group)
}

function createMountainRange(centerX, centerZ, rangeAngle, rangeLength) {
  const { mountainPeaksPerRange, mountainHeight, mountainRadius } = FOREST_CONFIG
  const dx = Math.cos(rangeAngle)
  const dz = Math.sin(rangeAngle)

  // 沿山脊方向均匀分布峰位，相邻山峰间距让底部重叠
  const spacing = rangeLength / (mountainPeaksPerRange - 1)

  for (let p = 0; p < mountainPeaksPerRange; p++) {
    const t = p / (mountainPeaksPerRange - 1) - 0.5 // -0.5 ~ 0.5
    const offset = t * rangeLength
    const px = centerX + dx * offset + (Math.random() - 0.5) * spacing * 0.3
    const pz = centerZ + dz * offset + (Math.random() - 0.5) * spacing * 0.3

    const radius = mountainRadius[0] + Math.random() * (mountainRadius[1] - mountainRadius[0])
    const height = mountainHeight[0] + Math.random() * (mountainHeight[1] - mountainHeight[0])
    // 中间的山峰更高
    const peakBoost = 1 - Math.abs(t) * 0.4
    const finalHeight = height * peakBoost
    const finalRadius = radius * (0.9 + Math.abs(t) * 0.2)

    // 圆台几何体，顶部做成带弧度的穹顶；每座山独立随机种子保证形状各异
    const topRadius = finalRadius * (0.24 + Math.random() * 0.14) // 顶部圆面半径
    const domeHeight = topRadius * (0.45 + Math.random() * 0.25) // 穹顶隆起高度
    // 山体随机参数：噪声幅度、相位、穹顶中心偏移、整体倾斜
    const noiseAmp = 0.18 + Math.random() * 0.18     // 侧表面凹凸幅度
    const noisePhaseX = Math.random() * 10
    const noisePhaseZ = Math.random() * 10
    const domeOffX = (Math.random() - 0.5) * topRadius * 0.6  // 穹顶中心偏移
    const domeOffZ = (Math.random() - 0.5) * topRadius * 0.6
    const geo = new THREE.CylinderGeometry(topRadius, finalRadius, finalHeight, 24, 5)
    const posAttr = geo.attributes.position

    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i)
      const y = posAttr.getY(i)
      const z = posAttr.getZ(i)
      // 归一化高度（0=底，1=顶），用于随高度变化的扰动
      const h = (y + finalHeight / 2) / finalHeight
      // 侧表面扰动：低频大波 + 高频小波，幅度随高度上升而增大
      if (y > -finalHeight / 2 + 1) {
        const big = Math.sin(x * 0.4 + noisePhaseX) * Math.cos(z * 0.4 + noisePhaseZ)
        const small = Math.sin(x * 1.3 + noisePhaseX) * Math.cos(z * 1.1 + noisePhaseZ) * 0.5
        const noise = (big + small) * noiseAmp * (0.4 + h * 0.6)
        posAttr.setX(i, x * (1 + noise))
        posAttr.setZ(i, z * (1 + noise))
      }
      // 顶部圆面顶点抬升成球冠穹顶：中心偏移使其不对称
      if (y > finalHeight / 2 - 0.1) {
        const dx = x - domeOffX
        const dz = z - domeOffZ
        const r = Math.sqrt(dx * dx + dz * dz)
        const ratio = Math.min(1, r / topRadius)
        const lift = domeHeight * Math.sqrt(Math.max(0, 1 - ratio * ratio))
        posAttr.setY(i, y + lift)
      }
    }
    posAttr.needsUpdate = true
    geo.computeVertexNormals()

    // 绿色山体材质：底部深绿，flatShading 保持棱角感
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3d6b27,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
      emissive: 0x0a1a05,
      emissiveIntensity: 0.06,
      map: rockColorTex2,
      roughnessMap: rockRoughTex2,
      normalMap: rockNormalDXTex2,
      normalScale: new THREE.Vector2(0.5, 0.5),
      
    })

    const peak = new THREE.Mesh(geo, mat)
    peak.position.set(px, finalHeight / 2, pz)
    // 随机轻微倾斜，让每座山朝向不同
    peak.rotation.set(
      (Math.random() - 0.5) * 0.18,
      Math.random() * Math.PI * 2,
      (Math.random() - 0.5) * 0.18
    )
    peak.castShadow = true
    peak.receiveShadow = true
    scene.add(peak)
    sceneMeshList.push(peak)
  }
}

// ===================== 飘落落叶粒子 =====================
function createLeafParticles() {
  const leafGeo = new THREE.PlaneGeometry(0.8, 0.8)
  const leafMat = new THREE.MeshBasicMaterial({
    color: 0x889922,
    transparent: true,
    opacity: 0.7
  })
  const count = 120
  const instMesh = new THREE.InstancedMesh(leafGeo, leafMat)
  const dummy = new THREE.Object3D()
  const velocityList = []
  for (let i = 0; i < count; i++) {
    dummy.position.set(
      (Math.random() - 0.5) * 200,
      Math.random() * 40,
      (Math.random() - 0.5) * 200
    )
    dummy.rotation.set(
      Math.random() * Math.PI,
      Math.random() * Math.PI,
      Math.random() * Math.PI
    )
    dummy.updateMatrix()
    instMesh.setMatrixAt(i, dummy.matrix)
    velocityList.push({
      x: (Math.random() - 0.5) * 0.08,
      y: -0.03 - Math.random() * 0.04,
      z: (Math.random() - 0.5) * 0.08
    })
  }
  leafParticles = { mesh: instMesh, vel: velocityList }
  scene.add(instMesh)
  sceneMeshList.push(instMesh)
}

// ===================== 生成森林+大量云朵+远景云层 =====================
function buildForest() {
  const halfSize = FOREST_CONFIG.groundSize / 2 - 10

  // 先生成草地（地面覆盖）
  createGrass()

  for (let i = 0; i < FOREST_CONFIG.treeCount; i++) {
    const x = (Math.random() - 0.5) * halfSize * 1.8
    const z = (Math.random() - 0.5) * halfSize * 1.8
    const scale = 0.7 + Math.random() * 0.6
    const rotY = Math.random() * Math.PI * 2
    const tiltX = (Math.random() - 0.5) * 0.15
    const tiltZ = (Math.random() - 0.5) * 0.15
    createTree(x, z, scale, rotY, tiltX, tiltZ)
  }
  for (let i = 0; i < FOREST_CONFIG.rockCount; i++) {
    const x = (Math.random() - 0.5) * halfSize * 1.7
    const z = (Math.random() - 0.5) * halfSize * 1.7
    const size = 0.6 + Math.random() * 1.2
    createRock(x, z, size)
  }
  for (let i = 0; i < FOREST_CONFIG.hillCount; i++) {
    const x = (Math.random() - 0.5) * halfSize * 1.5
    const z = (Math.random() - 0.5) * halfSize * 1.5
    const r = 3 + Math.random() * 6
    const h = 0.6 + Math.random() * 1.8
    createHill(x, z, r, h)
  }

  // 枯木装饰
  for (let i = 0; i < 20; i++) {
    const x = (Math.random() - 0.5) * halfSize * 1.6
    const z = (Math.random() - 0.5) * halfSize * 1.6
    createDeadwood(x, z)
  }

  // 灌木丛装饰
  for (let i = 0; i < 60; i++) {
    const x = (Math.random() - 0.5) * halfSize * 1.7
    const z = (Math.random() - 0.5) * halfSize * 1.7
    createBush(x, z)
  }

  // 蘑菇装饰
  createMushrooms()

  // 连绵山脉，在场景周边随机分布
  const [dMin, dMax] = FOREST_CONFIG.mountainDistance
  for (let i = 0; i < FOREST_CONFIG.mountainRangeCount; i++) {
    const angle = (i / FOREST_CONFIG.mountainRangeCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.5
    const dist = dMin + Math.random() * (dMax - dMin)
    const cx = Math.cos(angle) * dist
    const cz = Math.sin(angle) * dist
    const rangeAngle = angle + Math.PI / 2 + (Math.random() - 0.5) * 0.8
    const rangeLength = 45 + Math.random() * 35
    createMountainRange(cx, cz, rangeAngle, rangeLength)
  }

  // 近景主云层
  const [minH, maxH] = FOREST_CONFIG.cloudHeightRange
  for (let i = 0; i < FOREST_CONFIG.cloudCount; i++) {
    const x = (Math.random() - 0.5) * 400
    const z = (Math.random() - 0.5) * 300
    const height = minH + Math.random() * (maxH - minH)
    createCloud(x, z, height)
  }

  // 远景超大云层，填满天空背景，云朵存在感大幅提升
  for (let i = 0; i < 12; i++) {
    const x = (Math.random() - 0.5) * 500
    const z = -180 - Math.random() * 120
    const height = 70 + Math.random() * 50
    createCloud(x, z, height)
  }
}


// ===================== 渲染循环（云朵移动+风力） =====================
function animate() {
  animationFrameId = requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.016)
  world.step(delta)
  if (controls.enabled) {
    controls.update()
  } else if (birdController && birdController.isBirdMode()) {
    birdController.update(delta)
  } else {
    updatePlayer(delta)
  }
  wind.time += delta * wind.speed

  // 雨滴
  updateRainParticles()

  // 树木随风摆动
  treeGroups.forEach((tree) => {
    tree.children.forEach((obj) => {
      if (obj.geometry) {
        const type = obj.geometry.type
        if (
          type === 'BoxGeometry' ||
          type === 'SphereGeometry' ||
          type === 'ConeGeometry' ||
          type === 'CylinderGeometry'
        ) {
          obj.rotation.z = Math.sin(wind.time + obj.position.x * 0.4) * wind.strength
        }
      }
    })
  })

  // 云朵水平漂移 + 微风轻微晃动
  cloudGroups.forEach(cloud => {
    cloud.position.x += FOREST_CONFIG.cloudMoveSpeed
    if (cloud.position.x > 220) {
      cloud.position.x = -220
    }
    cloud.children.forEach(piece => {
      piece.rotation.y = Math.sin(wind.time * 0.7 + piece.position.z) * 0.03
    })
  })

  // 草地随风摇曳
  if (grassMesh && grassVelocities) {
    const dummy = new THREE.Object3D()
    const total = grassMesh.count
    const windStrength = wind.strength * 1.2
    for (let i = 0; i < total; i++) {
      const g = grassVelocities[i]
      const sway = Math.sin(wind.time * 1.5 + g.phase) * windStrength * g.stiffness

      dummy.position.set(g.x, getTerrainHeight(g.x, g.z), g.z)
      dummy.rotation.set(0, g.yRot, sway)
      dummy.scale.setScalar(g.baseScale)
      dummy.updateMatrix()
      grassMesh.setMatrixAt(i, dummy.matrix)
    }
    grassMesh.instanceMatrix.needsUpdate = true
  }

  // 落叶粒子更新
  if (leafParticles) {
    const dummy = new THREE.Object3D()
    const total = leafParticles.mesh.count
    for (let i = 0; i < total; i++) {
      leafParticles.mesh.getMatrixAt(i, dummy.matrix)
      dummy.matrix.decompose(dummy.position, dummy.rotation, dummy.scale)
      dummy.position.x += leafParticles.vel[i].x
      dummy.position.y += leafParticles.vel[i].y
      dummy.position.z += leafParticles.vel[i].z
      dummy.rotation.x += 0.01
      dummy.rotation.z += 0.008
      if (dummy.position.y < 0) {
        dummy.position.y = 40
        dummy.position.x = (Math.random() - 0.5) * 200
        dummy.position.z = (Math.random() - 0.5) * 200
      }
      dummy.updateMatrix()
      leafParticles.mesh.setMatrixAt(i, dummy.matrix)
    }
    leafParticles.mesh.instanceMatrix.needsUpdate = true
  }

  composer.render()
}

// ===================== 玩家小人（3D mesh + Cannon 物理） =====================
function createPlayer() {
  const group = new THREE.Group()

  // 身体
  const bodyGeo = new THREE.CapsuleGeometry(0.35, 0.8, 4, 12)
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2d5fa8,
    roughness: 0.7,
    metalness: 0.1
  })
  const body = new THREE.Mesh(bodyGeo, bodyMat)
  body.position.y = 0.75
  body.castShadow = true
  group.add(body)

  // 头
  const headGeo = new THREE.SphereGeometry(0.28, 16, 12)
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xf0c898,
    roughness: 0.6,
    metalness: 0
  })
  const head = new THREE.Mesh(headGeo, headMat)
  head.position.y = 1.7
  head.castShadow = true
  group.add(head)

  // 头发（半球）
  const hairGeo = new THREE.SphereGeometry(0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI / 1.8)
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 })
  const hair = new THREE.Mesh(hairGeo, hairMat)
  hair.position.y = 1.75
  group.add(hair)

  // 手臂（两侧）
  const armGeo = new THREE.CapsuleGeometry(0.1, 0.6, 4, 8)
  const armMat = new THREE.MeshStandardMaterial({ color: 0x2d5fa8, roughness: 0.7 })
  const armL = new THREE.Mesh(armGeo, armMat)
  armL.position.set(-0.45, 0.8, 0)
  armL.castShadow = true
  group.add(armL)
  const armR = new THREE.Mesh(armGeo, armMat)
  armR.position.set(0.45, 0.8, 0)
  armR.castShadow = true
  group.add(armR)

  // 腿
  const legGeo = new THREE.CapsuleGeometry(0.12, 0.5, 4, 8)
  const legMat = new THREE.MeshStandardMaterial({ color: 0x2a2a3a, roughness: 0.8 })
  const legL = new THREE.Mesh(legGeo, legMat)
  legL.position.set(-0.15, 0.2, 0)
  legL.castShadow = true
  group.add(legL)
  const legR = new THREE.Mesh(legGeo, legMat)
  legR.position.set(0.15, 0.2, 0)
  legR.castShadow = true
  group.add(legR)

  // 朝向指示（鼻子）
  const noseGeo = new THREE.SphereGeometry(0.05, 6, 4)
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xd0a070 })
  const nose = new THREE.Mesh(noseGeo, noseMat)
  nose.position.set(0, 1.7, 0.28)
  group.add(nose)

  // 存储四肢引用用于跑动动画
  group.userData = { armL, armR, legL, legR }

  playerMesh = group
  scene.add(playerMesh)

  // Cannon 物理体：球体碰撞，fixedRotation 保持直立
  // 半径 0.4，球心在地面 y=0.4 处；模型脚底对齐球心-0.4=0
  playerBody = new CANNON.Body({
    mass: 5,
    fixedRotation: true,
    material: new CANNON.Material({ friction: 0.0 })
  })
  playerBody.addShape(new CANNON.Sphere(0.4))
  playerBody.position.set(0, 2, 20)
  playerBody.linearDamping = 0.2 // 低阻尼，跑动有惯性
  playerBody.allowSleep = false // 不休眠，随时响应输入
  playerBody.ccdSpeedThreshold = 0.5 // 高速时启用 CCD，避免穿模
  playerBody.ccdMotionThreshold = 0.5
  world.addBody(playerBody)
}

// ===================== 坐下交互 =====================
function findNearestSitTarget() {
  if (!playerBody) return null
  const px = playerBody.position.x
  const pz = playerBody.position.z
  let best = null
  let bestDist = 3.0 * 3.0  // 交互范围 3 米
  for (const t of sitTargets) {
    const dx = t.x - px
    const dz = t.z - pz
    const d = dx * dx + dz * dz
    if (d < bestDist) { bestDist = d; best = t }
  }
  return best
}

function sitDown(target) {
  isSitting = true
  sitTargetRef = target
  // 把玩家吸附到坐点
  playerBody.position.set(target.x, target.y, target.z)
  playerBody.velocity.set(0, 0, 0)
  // 面向随机方向（面向 -Z，即摄像机方向）
  playerMesh.rotation.y = cameraYaw
  // 坐姿：弯曲双腿
  const limbs = playerMesh.userData
  if (limbs) {
    limbs.legL.rotation.x = -1.3
    limbs.legR.rotation.x = -1.3
    limbs.armL.rotation.x = 0.6
    limbs.armR.rotation.x = 0.6
  }
}

function standUp() {
  isSitting = false
  sitTargetRef = null
  const limbs = playerMesh.userData
  if (limbs) {
    limbs.legL.rotation.x = 0
    limbs.legR.rotation.x = 0
    limbs.armL.rotation.x = 0
    limbs.armR.rotation.x = 0
  }
}

// 更新玩家移动 + 第三人称摄像机
let playerAnimTime = 0
function updatePlayer(delta) {
  if (!playerBody || !playerMesh) return

  // 坐下时锁定位置，不响应移动
  if (isSitting && sitTargetRef) {
    playerBody.velocity.set(0, 0, 0)
    playerBody.position.set(sitTargetRef.x, sitTargetRef.y, sitTargetRef.z)
    playerMesh.position.copy(playerBody.position)
    playerMesh.position.y += 0.2
    return
  }

  // WASD 移动（相对摄像机方向）
  const moveSpeed = playerKeys.shift ? 14 : 8
  const forward = new THREE.Vector3(
    -Math.sin(cameraYaw),
    0,
    -Math.cos(cameraYaw)
  )
  const right = new THREE.Vector3(
    Math.cos(cameraYaw),
    0,
    -Math.sin(cameraYaw)
  )

  let moveX = 0
  let moveZ = 0
  if (playerKeys.w) { moveX += forward.x; moveZ += forward.z }
  if (playerKeys.s) { moveX -= forward.x; moveZ -= forward.z }
  if (playerKeys.d) { moveX += right.x; moveZ += right.z }
  if (playerKeys.a) { moveX -= right.x; moveZ -= right.z }

  const len = Math.sqrt(moveX * moveX + moveZ * moveZ)
  const isMoving = len > 0
  if (isMoving) {
    moveX = (moveX / len) * moveSpeed
    moveZ = (moveZ / len) * moveSpeed
    // 用加速度平滑接近目标速度，而非直接覆盖，让物理引擎能响应斜坡
    const accel = 0.25
    playerBody.velocity.x += (moveX - playerBody.velocity.x) * accel
    playerBody.velocity.z += (moveZ - playerBody.velocity.z) * accel
    playerBody.wakeUp()

    // 小人朝向移动方向（平滑插值）
    const targetRot = Math.atan2(moveX, moveZ)
    let diff = targetRot - playerMesh.rotation.y
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2
    playerMesh.rotation.y += diff * 0.2
  } else {
    playerBody.velocity.x *= 0.7
    playerBody.velocity.z *= 0.7
  }

  // 手动控制玩家 y 完全跟随地形高度，避免 Trimesh 三角形卡住
  // 地面无物理体，y 由 getTerrainHeight 平滑插值控制
  const terrainY = getTerrainHeight(playerBody.position.x, playerBody.position.z)
  const targetY = terrainY + 0.4 // 球心目标高度 = 地形 + 半径
  // 平滑过渡：每帧朝目标 y 移动 30%，避免瞬移抖动
  playerBody.position.y += (targetY - playerBody.position.y) * 0.3
  // 清零 y 速度，重力不再影响玩家
  playerBody.velocity.y = 0

  // 同步 mesh 到物理体（保留朝向）
  // 球心在物理体 y，模型脚底在 y=-0.17，整体上移 0.2 使脚底贴近球心下方
  const prevRotY = playerMesh.rotation.y
  playerMesh.position.copy(playerBody.position)
  playerMesh.position.y += 0.2 // 模型偏移：脚底对齐球底
  playerMesh.rotation.y = prevRotY

  // 边界检测：玩家走出森林场景半径时，传送到沙滩
  const px = playerBody.position.x
  const pz = playerBody.position.z
  const distFromCenter = Math.sqrt(px * px + pz * pz)
  if (distFromCenter > FOREST_CONFIG.boundX) {
    if (onTeleportCallback) {
      onTeleportCallback()
      return
    }
  }

  // 跑动动画：摆臂 + 跨腿
  const limbs = playerMesh.userData
  if (limbs) {
    if (isMoving) {
      playerAnimTime += delta * (playerKeys.shift ? 16 : 11)
      const swing = Math.sin(playerAnimTime) * 0.5 // 减小幅度避免穿地
      limbs.armL.rotation.x = swing
      limbs.armR.rotation.x = -swing
      limbs.legL.rotation.x = -swing * 0.8
      limbs.legR.rotation.x = swing * 0.8
    } else {
      // 停下时四肢归位
      limbs.armL.rotation.x *= 0.8
      limbs.armR.rotation.x *= 0.8
      limbs.legL.rotation.x *= 0.8
      limbs.legR.rotation.x *= 0.8
    }
  }

  // 第三人称摄像机跟随
  // pitch 直接控制摄像机俯仰：>0 俯视，<0 仰视天空
  const camDist = 6
  const camOffset = new THREE.Vector3(
    Math.sin(cameraYaw) * camDist * Math.cos(cameraPitch),
    Math.sin(cameraPitch) * camDist + 3, // 基础高度 3 + pitch 控制升降
    Math.cos(cameraYaw) * camDist * Math.cos(cameraPitch)
  )
  camera.position.copy(playerMesh.position).add(camOffset)
  camera.lookAt(
    playerMesh.position.x,
    playerMesh.position.y + 1.2,
    playerMesh.position.z
  )
}

// ===================== 雨滴粒子（雨天） =====================
function createRainParticles() {
  const count = 6000
  const positions = new Float32Array(count * 3)
  const velocities = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 200
    positions[i * 3 + 1] = Math.random() * 55
    positions[i * 3 + 2] = (Math.random() - 0.5) * 200
    velocities[i] = 0.9 + Math.random() * 0.7
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.userData.velocities = velocities
  const mat = new THREE.PointsMaterial({
    color: 0xaaccee,
    size: 0.16,
    transparent: true,
    opacity: 0.55,
    depthWrite: false
  })
  rainPoints = new THREE.Points(geo, mat)
  rainPoints.visible = false
  scene.add(rainPoints)
}

function updateRainParticles() {
  if (!rainPoints || !rainPoints.visible) return
  const pos = rainPoints.geometry.attributes.position.array
  const vel = rainPoints.geometry.userData.velocities
  for (let i = 0; i < pos.length / 3; i++) {
    pos[i * 3 + 1] -= vel[i]
    pos[i * 3] += 0.02
    if (pos[i * 3 + 1] < 0) {
      pos[i * 3 + 1] = 55
      pos[i * 3] = (Math.random() - 0.5) * 200
      pos[i * 3 + 2] = (Math.random() - 0.5) * 200
    }
  }
  rainPoints.geometry.attributes.position.needsUpdate = true
}

// ===================== 环境应用（昼夜 / 晴雨） =====================
function applyEnvironment(state) {
  if (!scene || !renderer) return
  const isNight = state.time === 'night'
  const isRainy = state.weather === 'rainy'

  // —— 昼夜 ——
  if (isNight) {
    scene.background = new THREE.Color(0x0b1226)
    scene.fog.color.set(0x0b1226)
    ambientLight.color.set(0x445577)
    ambientLight.intensity = 0.28
    sunLight.color.set(0x6688cc)
    sunLight.intensity = 0.25
    renderer.toneMappingExposure = 0.55
    if (sunLensflare) sunLensflare.visible = false
    // 开启月亮发光 + 月光照明
    if (moon) { moon.mesh.visible = true; moon.light.visible = true }
  } else {
    scene.background = new THREE.Color(0x8bb8d8)
    scene.fog.color.set(FOREST_CONFIG.fogColor)
    ambientLight.color.set(0xf0f8ff)
    ambientLight.intensity = 0.55
    sunLight.color.set(FOREST_CONFIG.sunColor)
    sunLight.intensity = FOREST_CONFIG.sunIntensity
    renderer.toneMappingExposure = 1.3
    if (sunLensflare) sunLensflare.visible = true
    if (moon) { moon.mesh.visible = false; moon.light.visible = false }
  }

  // —— 晴雨 ——
  if (isRainy) {
    scene.fog.near = 30
    scene.fog.far = 130
    sunLight.intensity *= 0.45
    ambientLight.intensity *= 0.7
    if (rainPoints) rainPoints.visible = true
  } else {
    scene.fog.near = FOREST_CONFIG.fogNear
    scene.fog.far = FOREST_CONFIG.fogFar
    if (rainPoints) rainPoints.visible = false
  }
}

// ===================== 对外接口：初始化 / 卸载森林场景 =====================
export function initForest(opts = {}) {
  onTeleportCallback = opts.onTeleport || null
  // 重置摄像机角度，保证每次进入视角一致
  cameraYaw = 0
  cameraPitch = 0.25
  isOrbitMode = false
  isSitting = false
  sitTargetRef = null
  if (birdController) birdController.reset()
  // 重置按键状态
  playerKeys.w = playerKeys.a = playerKeys.s = playerKeys.d = playerKeys.shift = false

  initThree()
  initPhysics()
  initPostProcess()
  createGround()
  buildForest()
  createLeafParticles()
  createRainParticles()
  moon = createMoon(scene)
  createPlayer()
  // 鸟控制器（支持人物/鸟切换操控，可跨场景通行）
  birdController = createBirdController({
    scene,
    getPlayerMesh: () => playerMesh,
    getPlayerBody: () => playerBody,
    getTerrainHeight,
    boundX: FOREST_CONFIG.boundX,
    onTeleport: () => onTeleportCallback && onTeleportCallback(),
    camera,
    getCameraYaw: () => cameraYaw,
    getCameraPitch: () => cameraPitch,
    playerKeys
  })
  birdController.create()
  // 注册环境 GUI，森林支持 晴/雨
  setActiveScene(applyEnvironment, ['sunny', 'rainy'])
  animate()
  console.log('🌲 森林场景已启动')
}

export function disposeForest() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
  if (eventAbortController) {
    eventAbortController.abort()
    eventAbortController = null
  }
  // 释放物理世界中的全部刚体
  if (world) {
    world.bodies.slice().forEach((b) => world.removeBody(b))
  }
  // 释放渲染器与 DOM
  if (renderer) {
    renderer.dispose()
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
    renderer.forceContextLoss?.()
  }
  // 清空集合
  treeGroups.length = 0
  cloudGroups.length = 0
  sceneMeshList.length = 0
  sceneBodyList.length = 0
  grassMesh = null
  grassVelocities = null
  leafParticles = null
  moon = null
  sitTargets.length = 0
  isSitting = false
  sitTargetRef = null
  if (birdController) { birdController.dispose(); birdController = null }
  console.log('🧹 森林场景已卸载')
}

// ===================== 场景传送：森林 → 沙滩 → 雪原 → 森林 =====================
function teleportToBeach() {
  disposeForest()
  initBeach({ onTeleport: teleportToSnow })
}

function teleportToSnow() {
  disposeBeach()
  initSnow({ onTeleport: teleportToForest })
}

function teleportToForest() {
  disposeSnow()
  initForest({ onTeleport: teleportToBeach })
}

// ===================== 入口：从森林场景启动 =====================
initForest({ onTeleport: teleportToBeach })
