import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import * as CANNON from 'cannon-es'
import { setActiveScene, createMoon } from './envManager.js'
import { createBirdController } from './birdController.js'

// ===================== 雪原场景配置 =====================
const SNOW_CONFIG = {
  groundSize: 300,
  boundX: 115,           // 玩家走出此半径将传送回森林
  fogColor: 0xc8d0d8,
  fogNear: 60,           // 与森林场景一致
  fogFar: 220,           // 与森林场景一致，避免一眼望到头
  sunPos: new THREE.Vector3(40, 55, 30),
  sunColor: 0xd8d8e8,
  sunIntensity: 1.3,
  pineCount: 55,
  rockCount: 25,
  snowmanCount: 8,
  iglooCount: 3,
  campfireCount: 5,       // 篝火数量
  mountainCount: 6,       // 雪山数量
  cloudCount: 28,
  snowParticleCount: 3000,
  frozenPondCount: 4
}
// ===================== 全局变量 =====================
let scene, camera, renderer, controls, clock
let world, composer, sunLight
let ambientLight, hemiLight
let playerMesh, playerBody
let snowParticles, snowVelocities
let snowGroundMesh
let moon = null
let birdController = null
const pineTrees = []
const cloudGroups = []
const campfires = []     // 篝火集合（含粒子）
const mountains = []     // 雪山集合
const sceneBodyList = []
let animationFrameId = null
let onTeleportCallback = null
let eventAbortController = null
const textureLoader = new THREE.TextureLoader()

const playerKeys = { w: false, a: false, s: false, d: false, shift: false }
let cameraYaw = 0
let cameraPitch = 0.25
let isOrbitMode = false
let playerAnimTime = 0
const wind = { time: 0, strength: 0.03, speed: 0.5 }

// ===================== 纹理加载工具 =====================
function createTex(path, repeatX = 20, repeatZ = 20, isNormalDX = false) {
  const tex = textureLoader.load(
    `/texture/${path}`,
    () => console.log(`✅ 雪原贴图加载: /texture/${path}`),
    undefined,
    () => console.warn(`❌ 雪原贴图缺失: /texture/${path}`)
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

// 复用岩石与树皮纹理
const rockColorTex = createTex('Rock060_1K-JPG/Rock060_1K-JPG_Color.jpg', 2, 2)
const rockRoughTex = createTex('Rock060_1K-JPG/Rock060_1K-JPG_Roughness.jpg', 2, 2)
const rockNormalDXTex = createTex('Rock060_1K-JPG/Rock060_1K-JPG_NormalDX.jpg', 2, 2, true)
const barkColorTex = createTex('Bark012_1K-JPG/Bark012_1K-JPG_Color.jpg', 3, 6)
const barkRoughTex = createTex('Bark012_1K-JPG/Bark012_1K-JPG_Roughness.jpg', 3, 6)
const snowgroundColorTex = createTex('Snow001_1K-JPG/Snow001_1K-JPG_Color.jpg', 30, 30)
const snowgroundRoughTex = createTex('Snow001_1K-JPG/Snow001_1K-JPG_Roughness.jpg', 30, 30)
const snowgroundNormalDXTex = createTex('Snow001_1K-JPG/Snow001_1K-JPG_NormalDX.jpg', 30, 30, true)
const snowgroundColorTex2 = createTex('Snow012_1K-JPG/Snow012_1K-JPG_Color.jpg', 30, 30)
const snowgroundRoughTex2 = createTex('Snow012_1K-JPG/Snow012_1K-JPG_Roughness.jpg', 30, 30)
const snowgroundNormalDXTex2 = createTex('Snow012_1K-JPG/Snow012_1K-JPG_NormalDX.jpg', 30, 30, true)

// ===================== 环境应用（昼夜 / 晴雪） =====================
function applyEnvironment(state) {
  if (!scene || !renderer) return
  const isNight = state.time === 'night'
  const isSnowy = state.weather === 'snowy'

  // —— 昼夜 ——
  if (isNight) {
    scene.background = new THREE.Color(0x0a1020)
    scene.fog.color.set(0x0a1020)
    ambientLight.color.set(0x334466)
    ambientLight.intensity = 0.3
    hemiLight.color.set(0x334466)
    hemiLight.groundColor.set(0x1a2030)
    hemiLight.intensity = 0.28
    sunLight.color.set(0x6688bb)
    sunLight.intensity = 0.22
    renderer.toneMappingExposure = 0.5
    // 开启月亮发光 + 月光照明
    if (moon) { moon.mesh.visible = true; moon.light.visible = true }
  } else {
    scene.background = new THREE.Color(0xb8c4d0)
    scene.fog.color.set(SNOW_CONFIG.fogColor)
    ambientLight.color.set(0xc8d8e8)
    ambientLight.intensity = 0.7
    hemiLight.color.set(0xa8b8c8)
    hemiLight.groundColor.set(0xf0f0f5)
    hemiLight.intensity = 0.6
    sunLight.color.set(SNOW_CONFIG.sunColor)
    sunLight.intensity = SNOW_CONFIG.sunIntensity
    renderer.toneMappingExposure = 1.15
    if (moon) { moon.mesh.visible = false; moon.light.visible = false }
  }

  // —— 晴雪 ——
  if (isSnowy) {
    scene.fog.far = 150
    sunLight.intensity *= 0.7
    ambientLight.intensity *= 0.85
    if (snowParticles) snowParticles.visible = true
  } else {
    scene.fog.far = SNOW_CONFIG.fogFar
    if (snowParticles) snowParticles.visible = false
  }
}

// ===================== 对外接口 =====================
export function initSnow(opts = {}) {
  onTeleportCallback = opts.onTeleport || null
  initThree()
  initPhysics()
  initPostProcess()
  createSnowGround()
  createFrozenPonds()
  createPineTrees()
  createSnowRocks()
  createSnowmen()
  createIgloos()
  createMountains()
  createCampfires()
  createClouds()
  createSnowParticles()
  moon = createMoon(scene)
  createPlayer()
  // 鸟控制器
  birdController = createBirdController({
    scene,
    getPlayerMesh: () => playerMesh,
    getPlayerBody: () => playerBody,
    getTerrainHeight,
    boundX: SNOW_CONFIG.boundX,
    onTeleport: () => onTeleportCallback && onTeleportCallback(),
    camera,
    getCameraYaw: () => cameraYaw,
    getCameraPitch: () => cameraPitch,
    playerKeys
  })
  birdController.create()
  // 注册环境 GUI，雪原支持 晴/雪
  setActiveScene(applyEnvironment, ['sunny', 'snowy'])
  animate()
  console.log('❄️ 雪原场景已启动')
}

export function disposeSnow() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
  if (eventAbortController) {
    eventAbortController.abort()
    eventAbortController = null
  }
  if (world) {
    world.bodies.slice().forEach((b) => world.removeBody(b))
  }
  if (renderer) {
    renderer.dispose()
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
    renderer.forceContextLoss?.()
  }
  pineTrees.length = 0
  cloudGroups.length = 0
  campfires.length = 0
  mountains.length = 0
  sceneBodyList.length = 0
  snowParticles = null
  snowVelocities = null
  moon = null
  if (birdController) { birdController.dispose(); birdController = null }
  console.log('🧹 雪原场景已卸载')
}

// ===================== 初始化 Three 渲染 =====================
function initThree() {
  eventAbortController = new AbortController()
  const { signal } = eventAbortController

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0xb8c4d0)
  scene.fog = new THREE.Fog(SNOW_CONFIG.fogColor, SNOW_CONFIG.fogNear, SNOW_CONFIG.fogFar)

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000)
  camera.position.set(0, 8, 14)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15
  document.body.appendChild(renderer.domElement)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.05
  controls.enabled = false
  clock = new THREE.Clock()

  // 鼠标拖动旋转视角
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
    if (k === 'v') {
      isOrbitMode = !isOrbitMode
      controls.enabled = isOrbitMode
    }
    // 按 E：点燃/熄灭篝火 或 靠近鸟时切换人物与鸟
    if (k === 'e') {
      if (birdController && birdController.isBirdMode()) {
        birdController.toggleMode()
      } else {
        const camp = findNearestCampfire()
        if (camp) {
          toggleCampfire(camp)
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

  // 冷色环境光，模拟雪地漫反射
  ambientLight = new THREE.AmbientLight(0xc8d8e8, 0.7)
  scene.add(ambientLight)

  // 半球光：天空灰蓝 + 地面雪白
  hemiLight = new THREE.HemisphereLight(0xa8b8c8, 0xf0f0f5, 0.6)
  scene.add(hemiLight)

  // 太阳：柔弱冬日阳光
  sunLight = new THREE.DirectionalLight(SNOW_CONFIG.sunColor, SNOW_CONFIG.sunIntensity)
  sunLight.position.copy(SNOW_CONFIG.sunPos)
  sunLight.castShadow = true
  sunLight.shadow.mapSize.set(4096, 4096)
  sunLight.shadow.camera.left = -160
  sunLight.shadow.camera.right = 160
  sunLight.shadow.camera.top = 160
  sunLight.shadow.camera.bottom = -160
  sunLight.shadow.bias = 0.0008
  sunLight.shadow.radius = 4
  scene.add(sunLight)

  window.addEventListener('resize', onWindowResize, { signal })
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  composer.setSize(window.innerWidth, window.innerHeight)
}

function initPostProcess() {
  composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.15,
    0.12,
    0.9
  )
  composer.addPass(bloomPass)
}

// ===================== 初始化 Cannon 物理 =====================
function initPhysics() {
  world = new CANNON.World()
  world.gravity.set(0, -9.8, 0)
  world.broadphase = new CANNON.SAPBroadphase(world)
  world.allowSleep = true
  world.defaultContactMaterial.friction = 0.3
  world.defaultContactMaterial.restitution = 0
  world.defaultContactMaterial.contactEquationStiffness = 1e8
  world.defaultContactMaterial.contactEquationRelaxation = 3
  world.solver.iterations = 20
  world.solver.tolerance = 0.001
}

// ===================== 雪原地形高度 =====================
function getTerrainHeight(x, z) {
  // 雪地起伏：缓丘 + 噪声
  const n1 = Math.sin(x * 0.03) * Math.cos(z * 0.028) * 1.5
  const n2 = Math.sin(x * 0.08 + z * 0.06) * 0.6
  const n3 = Math.sin(x * 0.15 - z * 0.11) * 0.3
  return n1 + n2 + n3
}

// ===================== 雪原地面 =====================
function createSnowGround() {
  const size = SNOW_CONFIG.groundSize
  const geo = new THREE.PlaneGeometry(size, size, 80, 80)
  geo.rotateX(-Math.PI / 2)

  const posAttr = geo.attributes.position
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i)
    const z = posAttr.getZ(i)
    posAttr.setY(i, getTerrainHeight(x, z))
  }
  posAttr.needsUpdate = true
  geo.computeVertexNormals()

  // 雪地材质：白色带蓝调，高粗糙度
  const mat = new THREE.MeshStandardMaterial({
    color: 0xf0f4f8,
    roughness: 0.85,
    map: snowgroundColorTex,
    roughnessMap: snowgroundRoughTex,
    normalMap: snowgroundNormalDXTex,
    metalness: 0.05,
    emissive: 0x202830,
    emissiveIntensity: 0.06,
    flatShading: false
  })
  snowGroundMesh = new THREE.Mesh(geo, mat)
  snowGroundMesh.receiveShadow = true
  scene.add(snowGroundMesh)
}

// ===================== 冰湖 =====================
function createFrozenPond(posX, posZ, radius) {
  const group = new THREE.Group()

  // 冰面
  const iceGeo = new THREE.CircleGeometry(radius, 32)
  iceGeo.rotateX(-Math.PI / 2)
  const iceMat = new THREE.MeshStandardMaterial({
    color: 0xa8d8e8,
    roughness: 0.15,
    metalness: 0.6,
    transparent: true,
    opacity: 0.85,
    emissive: 0x204050,
    emissiveIntensity: 0.1
  })
  const ice = new THREE.Mesh(iceGeo, iceMat)
  ice.position.y = 0.05
  ice.receiveShadow = true
  group.add(ice)

  // 冰面边缘积雪
  const rimGeo = new THREE.RingGeometry(radius * 0.92, radius * 1.08, 32)
  rimGeo.rotateX(-Math.PI / 2)
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    transparent: true,
    opacity: 0.7
  })
  const rim = new THREE.Mesh(rimGeo, rimMat)
  rim.position.y = 0.08
  group.add(rim)

  group.position.set(posX, getTerrainHeight(posX, posZ), posZ)
  scene.add(group)
}

function createFrozenPonds() {
  for (let i = 0; i < SNOW_CONFIG.frozenPondCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 20 + Math.random() * 70
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const pondRadius = 5 + Math.random() * 8
    createFrozenPond(x, z, pondRadius)
  }
}

// ===================== 雪松 =====================
function createPineTree(posX, posZ, scale = 1) {
  const group = new THREE.Group()
  const trunkHeight = 3 * scale

  // 树干
  const trunkGeo = new THREE.CylinderGeometry(0.25 * scale, 0.4 * scale, trunkHeight, 8)
  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x5a3a20,
    roughness: 0.95,
    map: barkColorTex,
    roughnessMap: barkRoughTex
  })
  const trunk = new THREE.Mesh(trunkGeo, trunkMat)
  trunk.position.y = trunkHeight / 2
  trunk.castShadow = true
  group.add(trunk)

  // 松树冠：3 层圆锥（深绿）
  const layerCount = 3
  for (let l = 0; l < layerCount; l++) {
    const layerRadius = (2.5 - l * 0.6) * scale
    const layerHeight = 3 * scale
    const layerY = trunkHeight + l * 1.8 * scale

    const coneGeo = new THREE.ConeGeometry(layerRadius, layerHeight, 10)
    const coneMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.33, 0.3, 0.18 + l * 0.03),
      roughness: 0.9,
      flatShading: true,
      emissive: 0x040a04,
      emissiveIntensity: 0.04
    })
    const cone = new THREE.Mesh(coneGeo, coneMat)
    cone.position.y = layerY + layerHeight / 2
    cone.castShadow = true
    cone.receiveShadow = true
    group.add(cone)

    // 雪盖：每层圆锥顶部白色雪帽
    const snowCapGeo = new THREE.ConeGeometry(layerRadius * 0.6, layerHeight * 0.35, 10)
    const snowCapMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.7,
      flatShading: true,
      emissive: 0x202028,
      emissiveIntensity: 0.05
    })
    const snowCap = new THREE.Mesh(snowCapGeo, snowCapMat)
    snowCap.position.y = layerY + layerHeight * 0.82
    snowCap.castShadow = true
    group.add(snowCap)
  }

  group.position.set(posX, getTerrainHeight(posX, posZ), posZ)
  group.rotation.y = Math.random() * Math.PI * 2
  // 随机倾斜
  group.rotation.z = (Math.random() - 0.5) * 0.08
  scene.add(group)
  pineTrees.push(group)

  // 物理体
  const trunkBody = new CANNON.Body({ mass: 0 })
  trunkBody.addShape(new CANNON.Cylinder(0.25 * scale, 0.4 * scale, trunkHeight, 8))
  trunkBody.position.set(posX, getTerrainHeight(posX, posZ) + trunkHeight / 2, posZ)
  world.addBody(trunkBody)
  sceneBodyList.push(trunkBody)
}

function createPineTrees() {
  for (let i = 0; i < SNOW_CONFIG.pineCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 15 + Math.random() * 85
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const scale = 0.7 + Math.random() * 0.7
    createPineTree(x, z, scale)
  }
}

// ===================== 雪岩 =====================
function createSnowRock(posX, posZ, size) {
  const group = new THREE.Group()

  // 岩石本体
  const rockGeo = new THREE.DodecahedronGeometry(size, 0)
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x6a6a6a,
    map: rockColorTex,
    roughnessMap: rockRoughTex,
    normalMap: rockNormalDXTex,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.95,
    flatShading: true
  })
  const rock = new THREE.Mesh(rockGeo, rockMat)
  rock.position.y = size * 0.4
  rock.rotation.set(Math.random(), Math.random(), Math.random())
  rock.castShadow = true
  rock.receiveShadow = true
  group.add(rock)

  // 雪盖：扁平白色椭球覆盖岩石顶部
  const snowGeo = new THREE.SphereGeometry(size * 0.9, 10, 6)
  snowGeo.scale(1, 0.35, 1)
  const snowMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.7,
    flatShading: true,
    emissive: 0x202028,
    emissiveIntensity: 0.05
  })
  const snow = new THREE.Mesh(snowGeo, snowMat)
  snow.position.y = size * 0.65
  snow.castShadow = true
  group.add(snow)

  group.position.set(posX, getTerrainHeight(posX, posZ), posZ)
  scene.add(group)

  // 物理体
  const rockBody = new CANNON.Body({ mass: 0 })
  rockBody.addShape(new CANNON.Sphere(size * 0.8))
  rockBody.position.set(posX, getTerrainHeight(posX, posZ) + size * 0.5, posZ)
  world.addBody(rockBody)
  sceneBodyList.push(rockBody)
}

function createSnowRocks() {
  for (let i = 0; i < SNOW_CONFIG.rockCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 10 + Math.random() * 90
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const size = 0.6 + Math.random() * 1.8
    createSnowRock(x, z, size)
  }
}

// ===================== 雪人 =====================
function createSnowman(posX, posZ) {
  const group = new THREE.Group()
  const scale = 0.8 + Math.random() * 0.4

  // 三个雪球（底→中→顶）
  const ballSizes = [1.0, 0.7, 0.5]
  const ballY = [0.9, 2.0, 2.9]
  const snowMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0.05,
    emissive: 0x202028,
    emissiveIntensity: 0.04,
    flatShading: false
  })

  ballSizes.forEach((r, i) => {
    const ballGeo = new THREE.SphereGeometry(r * scale, 16, 12)
    const ball = new THREE.Mesh(ballGeo, snowMat)
    ball.position.y = ballY[i] * scale
    ball.castShadow = true
    ball.receiveShadow = true
    group.add(ball)
  })

  // 煤眼
  const eyeGeo = new THREE.SphereGeometry(0.06 * scale, 8, 6)
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.4 })
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat)
  eyeL.position.set(-0.18 * scale, 3.0 * scale, 0.42 * scale)
  group.add(eyeL)
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat)
  eyeR.position.set(0.18 * scale, 3.0 * scale, 0.42 * scale)
  group.add(eyeR)

  // 胡萝卜鼻子
  const noseGeo = new THREE.ConeGeometry(0.08 * scale, 0.45 * scale, 8)
  const noseMat = new THREE.MeshStandardMaterial({
    color: 0xe67e22,
    roughness: 0.6,
    emissive: 0x2a1808,
    emissiveIntensity: 0.1
  })
  const nose = new THREE.Mesh(noseGeo, noseMat)
  nose.position.set(0, 2.85 * scale, 0.55 * scale)
  nose.rotation.x = Math.PI / 2
  group.add(nose)

  // 煤扣子（中层正面）
  const btnGeo = new THREE.SphereGeometry(0.05 * scale, 6, 6)
  for (let b = 0; b < 3; b++) {
    const btn = new THREE.Mesh(btnGeo, eyeMat)
    btn.position.set(0, (2.3 - b * 0.35) * scale, 0.55 * scale)
    group.add(btn)
  }

  // 树枝手臂
  const armMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.95 })
  const armGeo = new THREE.CylinderGeometry(0.04 * scale, 0.05 * scale, 1.2 * scale, 5)
  const armL = new THREE.Mesh(armGeo, armMat)
  armL.position.set(-0.75 * scale, 2.1 * scale, 0)
  armL.rotation.z = Math.PI / 2.5
  armL.castShadow = true
  group.add(armL)
  const armR = new THREE.Mesh(armGeo, armMat)
  armR.position.set(0.75 * scale, 2.1 * scale, 0)
  armR.rotation.z = -Math.PI / 2.5
  armR.castShadow = true
  group.add(armR)

  // 围巾
  const scarfGeo = new THREE.TorusGeometry(0.45 * scale, 0.12 * scale, 8, 20)
  const scarfMat = new THREE.MeshStandardMaterial({
    color: 0xc0392b,
    roughness: 0.8,
    flatShading: true
  })
  const scarf = new THREE.Mesh(scarfGeo, scarfMat)
  scarf.position.y = 2.45 * scale
  scarf.rotation.x = Math.PI / 2
  scarf.castShadow = true
  group.add(scarf)

  // 帽子（礼帽）
  const hatBrimGeo = new THREE.CylinderGeometry(0.45 * scale, 0.45 * scale, 0.05 * scale, 16)
  const hatMat = new THREE.MeshStandardMaterial({ color: 0x1a1a2a, roughness: 0.6 })
  const hatBrim = new THREE.Mesh(hatBrimGeo, hatMat)
  hatBrim.position.y = 3.35 * scale
  hatBrim.castShadow = true
  group.add(hatBrim)
  const hatTopGeo = new THREE.CylinderGeometry(0.3 * scale, 0.3 * scale, 0.6 * scale, 16)
  const hatTop = new THREE.Mesh(hatTopGeo, hatMat)
  hatTop.position.y = 3.65 * scale
  hatTop.castShadow = true
  group.add(hatTop)

  group.position.set(posX, getTerrainHeight(posX, posZ), posZ)
  group.rotation.y = Math.random() * Math.PI * 2
  scene.add(group)
}



function createSnowmen() {
  for (let i = 0; i < SNOW_CONFIG.snowmanCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 15 + Math.random() * 80
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    createSnowman(x, z)
  }
}

// ===================== 雪屋（冰屋） =====================
function createIgloo(posX, posZ, scale = 1) {
  const group = new THREE.Group()

  // 主穹顶（半球）
  const domeGeo = new THREE.SphereGeometry(3 * scale, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)
  const domeMat = new THREE.MeshStandardMaterial({
    color: 0xe8eef5,
    roughness: 0.85,
    metalness: 0.05,
    flatShading: true,
    emissive: 0x202830,
    emissiveIntensity: 0.05
  })
  const dome = new THREE.Mesh(domeGeo, domeMat)
  dome.castShadow = true
  dome.receiveShadow = true
  group.add(dome)

  // 入口隧道
  const tunnelGeo = new THREE.CylinderGeometry(1 * scale, 1.2 * scale, 1.8 * scale, 12, 1, false, 0, Math.PI)
  const tunnelMat = domeMat.clone()
  const tunnel = new THREE.Mesh(tunnelGeo, tunnelMat)
  tunnel.rotation.x = Math.PI / 2
  tunnel.position.set(0, 1 * scale, 3 * scale)
  tunnel.castShadow = true
  group.add(tunnel)

  // 冰砖纹路：在穹顶上添加几条横向线条
  for (let r = 1; r < 4; r++) {
    const ringGeo = new THREE.TorusGeometry(3 * scale * Math.cos(r * 0.35), 0.04 * scale, 6, 24)
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xb0c0d0,
      roughness: 0.8
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.position.y = 3 * scale * Math.sin(r * 0.35)
    ring.rotation.x = Math.PI / 2
    group.add(ring)
  }

  group.position.set(posX, getTerrainHeight(posX, posZ), posZ)
  scene.add(group)
}

function createIgloos() {
  for (let i = 0; i < SNOW_CONFIG.iglooCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 30 + Math.random() * 60
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const scale = 0.8 + Math.random() * 0.6
    createIgloo(x, z, scale)
  }
}

// ===================== 雪山（围绕场景边缘） =====================
function createMountain(posX, posZ, scale = 1) {
  const group = new THREE.Group()

  // 主峰：圆台几何体，每座山独立随机种子保证形状各异
  const peakHeight = 35 * scale
  const peakRadius = 14 * scale
  const peakTopRadius = peakRadius * (0.24 + Math.random() * 0.12)
  const peakDomeHeight = peakTopRadius * (0.4 + Math.random() * 0.25)
  const peakNoiseAmp = 0.16 + Math.random() * 0.18
  const peakPhaseX = Math.random() * 10
  const peakPhaseZ = Math.random() * 10
  const peakDomeOffX = (Math.random() - 0.5) * peakTopRadius * 0.6
  const peakDomeOffZ = (Math.random() - 0.5) * peakTopRadius * 0.6
  const peakGeo = new THREE.CylinderGeometry(peakTopRadius, peakRadius, peakHeight, 9, 8)
  const posAttr = peakGeo.attributes.position
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i)
    const y = posAttr.getY(i)
    const z = posAttr.getZ(i)
    const h = (y + peakHeight / 2) / peakHeight
    // 侧表面扰动：低频大波 + 高频小波，幅度随高度增大
    const big = Math.sin(x * 0.4 + peakPhaseX) * Math.cos(z * 0.4 + peakPhaseZ)
    const small = Math.sin(x * 1.3 + peakPhaseX) * Math.cos(z * 1.1 + peakPhaseZ) * 0.5
    const noise = (big + small) * peakNoiseAmp * (0.4 + h * 0.6) * scale
    posAttr.setX(i, x * (1 + noise))
    posAttr.setZ(i, z * (1 + noise))
    // 顶部圆面抬升成球冠穹顶（中心偏移使不对称）
    if (y > peakHeight / 2 - 0.1) {
      const dx = x - peakDomeOffX
      const dz = z - peakDomeOffZ
      const r = Math.sqrt(dx * dx + dz * dz)
      const ratio = Math.min(1, r / peakTopRadius)
      const lift = peakDomeHeight * Math.sqrt(Math.max(0, 1 - ratio * ratio))
      posAttr.setY(i, y + lift)
    }
  }
  posAttr.needsUpdate = true
  peakGeo.computeVertexNormals()

  // 山体：深色岩石材质
  const rockMat = new THREE.MeshStandardMaterial({
    //color: 0x4a4a52,
    roughness: 0.95,
    metalness: 0.05,
    map:snowgroundColorTex2,
    roughnessMap:snowgroundRoughTex2,
    normalMap:snowgroundNormalDXTex2,
    flatShading: true,
    emissive: 0x080808,
    emissiveIntensity: 0.05
  })
  const peak = new THREE.Mesh(peakGeo, rockMat)
  peak.position.y = peakHeight / 2
  peak.castShadow = false // 雪山较远不接收主光阴影
  peak.receiveShadow = true
  group.add(peak)

  // 雪盖：覆盖山顶 60% 的白色圆台，顶部带穹顶弧度（复用主峰随机参数保持轮廓一致）
  const snowHeight = peakHeight * 0.65
  const snowRadius = peakRadius * 0.82
  const snowTopRadius = snowRadius * 0.3
  const snowDomeHeight = snowTopRadius * 0.5
  const snowGeo = new THREE.CylinderGeometry(snowTopRadius, snowRadius, snowHeight, 9, 6)
  const snowPosAttr = snowGeo.attributes.position
  for (let i = 0; i < snowPosAttr.count; i++) {
    const x = snowPosAttr.getX(i)
    const y = snowPosAttr.getY(i)
    const z = snowPosAttr.getZ(i)
    const h = (y + snowHeight / 2) / snowHeight
    // 复用主峰的噪声参数让雪盖贴合山体轮廓
    const big = Math.sin(x * 0.4 + peakPhaseX) * Math.cos(z * 0.4 + peakPhaseZ)
    const small = Math.sin(x * 1.3 + peakPhaseX) * Math.cos(z * 1.1 + peakPhaseZ) * 0.5
    const noise = (big + small) * peakNoiseAmp * (0.4 + h * 0.6) * scale
    snowPosAttr.setX(i, x * (1 + noise))
    snowPosAttr.setZ(i, z * (1 + noise))
    if (y > snowHeight / 2 - 0.1) {
      const dx = x - peakDomeOffX
      const dz = z - peakDomeOffZ
      const r = Math.sqrt(dx * dx + dz * dz)
      const ratio = Math.min(1, r / snowTopRadius)
      const lift = snowDomeHeight * Math.sqrt(Math.max(0, 1 - ratio * ratio))
      snowPosAttr.setY(i, y + lift)
    }
  }
  snowPosAttr.needsUpdate = true
  snowGeo.computeVertexNormals()

  const snowMat = new THREE.MeshStandardMaterial({
    color: 0xf0f4f8,
    roughness: 0.8,
    metalness: 0.05,
    flatShading: true,
    emissive: 0x202028,
    emissiveIntensity: 0.06
  })
 // const snowCap = new THREE.Mesh(snowGeo, snowMat)
  //snowCap.position.y = peakHeight - snowHeight / 2 + 0.5
 // group.add(snowCap)

  // 山脚雪坡（扁平圆盘铺底）
  const baseGeo = new THREE.CylinderGeometry(peakRadius * 1.4, peakRadius * 1.6, 3, 16)
  const base = new THREE.Mesh(baseGeo, snowMat)
  base.position.y = 1.5
  base.receiveShadow = true
  group.add(base)

  // 次峰：附在主峰旁的小山，独立随机相位
  const subPeakHeight = peakHeight * 0.55
  const subPeakBot = peakRadius * 0.55
  const subPeakTop = subPeakBot * 0.3
  const subPeakDome = subPeakTop * 0.5
  const subPhaseX = Math.random() * 10
  const subPhaseZ = Math.random() * 10
  const subDomeOffX = (Math.random() - 0.5) * subPeakTop * 0.6
  const subDomeOffZ = (Math.random() - 0.5) * subPeakTop * 0.6
  const subNoiseAmp = 0.14 + Math.random() * 0.16
  const subPeakGeo = new THREE.CylinderGeometry(subPeakTop, subPeakBot, subPeakHeight, 8, 5)
  const subPosAttr = subPeakGeo.attributes.position
  for (let i = 0; i < subPosAttr.count; i++) {
    const x = subPosAttr.getX(i)
    const y = subPosAttr.getY(i)
    const z = subPosAttr.getZ(i)
    const h = (y + subPeakHeight / 2) / subPeakHeight
    const big = Math.sin(x * 0.4 + subPhaseX) * Math.cos(z * 0.4 + subPhaseZ)
    const small = Math.sin(x * 1.3 + subPhaseX) * Math.cos(z * 1.1 + subPhaseZ) * 0.5
    const noise = (big + small) * subNoiseAmp * (0.4 + h * 0.6) * scale
    subPosAttr.setX(i, x * (1 + noise))
    subPosAttr.setZ(i, z * (1 + noise))
    if (y > subPeakHeight / 2 - 0.1) {
      const dx = x - subDomeOffX
      const dz = z - subDomeOffZ
      const r = Math.sqrt(dx * dx + dz * dz)
      const ratio = Math.min(1, r / subPeakTop)
      const lift = subPeakDome * Math.sqrt(Math.max(0, 1 - ratio * ratio))
      subPosAttr.setY(i, y + lift)
    }
  }
  subPosAttr.needsUpdate = true
  subPeakGeo.computeVertexNormals()
  const subPeak = new THREE.Mesh(subPeakGeo, rockMat)
  subPeak.position.set(peakRadius * 0.9, peakHeight * 0.27, -peakRadius * 0.5)
  group.add(subPeak)

  const subSnowHeight = peakHeight * 0.35
  const subSnowBot = peakRadius * 0.45
  const subSnowTop = subSnowBot * 0.3
  const subSnowDome = subSnowTop * 0.5
  const subSnowGeo = new THREE.CylinderGeometry(subSnowTop, subSnowBot, subSnowHeight, 8, 5)
  const subSnowPosAttr = subSnowGeo.attributes.position
  for (let i = 0; i < subSnowPosAttr.count; i++) {
    const x = subSnowPosAttr.getX(i)
    const y = subSnowPosAttr.getY(i)
    const z = subSnowPosAttr.getZ(i)
    const h = (y + subSnowHeight / 2) / subSnowHeight
    const big = Math.sin(x * 0.4 + subPhaseX) * Math.cos(z * 0.4 + subPhaseZ)
    const small = Math.sin(x * 1.3 + subPhaseX) * Math.cos(z * 1.1 + subPhaseZ) * 0.5
    const noise = (big + small) * subNoiseAmp * (0.4 + h * 0.6) * scale
    subSnowPosAttr.setX(i, x * (1 + noise))
    subSnowPosAttr.setZ(i, z * (1 + noise))
    if (y > subSnowHeight / 2 - 0.1) {
      const dx = x - subDomeOffX
      const dz = z - subDomeOffZ
      const r = Math.sqrt(dx * dx + dz * dz)
      const ratio = Math.min(1, r / subSnowTop)
      const lift = subSnowDome * Math.sqrt(Math.max(0, 1 - ratio * ratio))
      subSnowPosAttr.setY(i, y + lift)
    }
  }
  subSnowPosAttr.needsUpdate = true
  subSnowGeo.computeVertexNormals()
  const subSnow = new THREE.Mesh(subSnowGeo, snowMat)
  subSnow.position.set(peakRadius * 0.9, peakHeight * 0.52, -peakRadius * 0.5)
  group.add(subSnow)

  group.position.set(posX, getTerrainHeight(posX, posZ), posZ)
  // 随机轻微倾斜，让每座山朝向不同
  group.rotation.set(
    (Math.random() - 0.5) * 0.18,
    Math.random() * Math.PI * 2,
    (Math.random() - 0.5) * 0.18
  )
  scene.add(group)
  mountains.push(group)
}

function createMountains() {
  // 雪山围绕场景边缘均匀分布（地面半径150，boundX=115）
  // 雪山放在 boundX 之外、地面边缘之内，避免阻挡玩家活动又不会越出地图
  const count = SNOW_CONFIG.mountainCount
  const baseRadius = 132
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.2
    const radius = baseRadius + (Math.random() - 0.5) * 10
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const scale = 0.7 + Math.random() * 0.5
    createMountain(x, z, scale)
  }
}

// ===================== 篝火（含粒子火焰） =====================
function createCampfire(posX, posZ, scale = 1) {
  const group = new THREE.Group()

  // 石头围圈（围住篝火）
  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0x5a5a5a,
    roughness: 0.95,
    flatShading: true,
    emissive: 0x0a0a0a,
    emissiveIntensity: 0.05
  })
  const stoneCount = 6
  for (let i = 0; i < stoneCount; i++) {
    const a = (i / stoneCount) * Math.PI * 2
    const stoneGeo = new THREE.DodecahedronGeometry(0.4 * scale, 0)
    const stone = new THREE.Mesh(stoneGeo, stoneMat)
    stone.position.set(
      Math.cos(a) * 0.9 * scale,
      0.2 * scale,
      Math.sin(a) * 0.9 * scale
    )
    stone.rotation.set(Math.random(), Math.random(), Math.random())
    stone.castShadow = true
    group.add(stone)
  }

  // 木柴堆（交叉的圆柱）
  const logMat = new THREE.MeshStandardMaterial({
    color: 0x3a2010,
    roughness: 0.95,
    emissive: 0x0a0402,
    emissiveIntensity: 0.08
  })
  for (let i = 0; i < 3; i++) {
    const logGeo = new THREE.CylinderGeometry(0.08 * scale, 0.08 * scale, 1.4 * scale, 6)
    const log = new THREE.Mesh(logGeo, logMat)
    log.rotation.z = Math.PI / 2
    log.rotation.y = (i / 3) * Math.PI
    log.position.y = 0.2 * scale
    log.castShadow = true
    group.add(log)
  }

  // 火堆光晕（中心发光球，emissive 持续发光）
  const coreGeo = new THREE.SphereGeometry(0.3 * scale, 10, 8)
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0xff8030,
    emissive: 0xff6020,
    emissiveIntensity: 2.5,
    transparent: true,
    opacity: 0.9
  })
  const core = new THREE.Mesh(coreGeo, coreMat)
  core.position.y = 0.4 * scale
  group.add(core)

  // 点光源：照亮周围雪地
  const fireLight = new THREE.PointLight(0xff8030, 3, 18, 2)
  fireLight.position.set(0, 1 * scale, 0)
  fireLight.castShadow = true
  fireLight.shadow.mapSize.set(512, 512)
  group.add(fireLight)

  // 火焰粒子系统
  const fireParticleCount = 120
  const fireGeo = new THREE.SphereGeometry(0.08, 4, 3)
  const fireMat = new THREE.MeshBasicMaterial({
    color: 0xffaa40,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
  const fireMesh = new THREE.InstancedMesh(fireGeo, fireMat, fireParticleCount)

  // 烟雾粒子（淡灰向上飘）
  const smokeParticleCount = 60
  const smokeGeo = new THREE.SphereGeometry(0.18, 6, 5)
  const smokeMat = new THREE.MeshBasicMaterial({
    color: 0xa0a0a0,
    transparent: true,
    opacity: 0.25,
    depthWrite: false
  })
  const smokeMesh = new THREE.InstancedMesh(smokeGeo, smokeMat, smokeParticleCount)

  // 初始化粒子状态
  const fireParticles = []
  const dummy = new THREE.Object3D()
  for (let i = 0; i < fireParticleCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const r = Math.random() * 0.3 * scale
    fireParticles.push({
      x: Math.cos(angle) * r,
      y: Math.random() * 0.6 * scale,
      z: Math.sin(angle) * r,
      vx: (Math.random() - 0.5) * 0.4,
      vy: 0.8 + Math.random() * 1.2,
      vz: (Math.random() - 0.5) * 0.4,
      life: Math.random(),
      maxLife: 0.8 + Math.random() * 0.5,
      scale: 0.5 + Math.random() * 0.8
    })
    dummy.position.set(fireParticles[i].x, fireParticles[i].y, fireParticles[i].z)
    dummy.scale.setScalar(0)
    dummy.updateMatrix()
    fireMesh.setMatrixAt(i, dummy.matrix)
  }
  fireMesh.instanceMatrix.needsUpdate = true
  fireMesh.position.y = 0.4 * scale
  group.add(fireMesh)

  const smokeParticles = []
  for (let i = 0; i < smokeParticleCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const r = Math.random() * 0.25 * scale
    smokeParticles.push({
      x: Math.cos(angle) * r,
      y: 0.4 * scale + Math.random() * 0.4 * scale,
      z: Math.sin(angle) * r,
      vx: (Math.random() - 0.5) * 0.2,
      vy: 0.6 + Math.random() * 0.6,
      vz: (Math.random() - 0.5) * 0.2,
      life: Math.random(),
      maxLife: 1.5 + Math.random() * 0.8,
      scale: 0.3 + Math.random() * 0.6
    })
    dummy.position.set(smokeParticles[i].x, smokeParticles[i].y, smokeParticles[i].z)
    dummy.scale.setScalar(0)
    dummy.updateMatrix()
    smokeMesh.setMatrixAt(i, dummy.matrix)
  }
  smokeMesh.instanceMatrix.needsUpdate = true
  group.add(smokeMesh)

  // 保存粒子状态与中心点用于动画
  group.userData = {
    core,
    fireLight,
    fireMesh,
    fireParticles,
    smokeMesh,
    smokeParticles,
    scale,
    flickerPhase: Math.random() * Math.PI * 2,
    isLit: true
  }

  group.position.set(posX, getTerrainHeight(posX, posZ), posZ)
  scene.add(group)
  campfires.push(group)
}

function createCampfires() {
  for (let i = 0; i < SNOW_CONFIG.campfireCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 12 + Math.random() * 75
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const scale = 0.8 + Math.random() * 0.5
    createCampfire(x, z, scale)
  }
}

// ===================== 篝火点燃/熄灭交互 =====================
function findNearestCampfire() {
  if (!playerBody) return null
  const px = playerBody.position.x
  const pz = playerBody.position.z
  let best = null
  let bestDist = 4.0 * 4.0  // 交互范围 4 米
  for (const camp of campfires) {
    const dx = camp.position.x - px
    const dz = camp.position.z - pz
    const d = dx * dx + dz * dz
    if (d < bestDist) { bestDist = d; best = camp }
  }
  return best
}

function toggleCampfire(camp) {
  const ud = camp.userData
  ud.isLit = !ud.isLit
  if (ud.isLit) {
    ud.fireLight.visible = true
    ud.core.visible = true
    ud.fireMesh.visible = true
    ud.smokeMesh.visible = true
    console.log('🔥 点燃篝火')
  } else {
    ud.fireLight.visible = false
    ud.core.visible = false
    ud.fireMesh.visible = false
    ud.smokeMesh.visible = false
    console.log('💨 熄灭篝火')
  }
}

function updateCampfires(delta) {
  const dummy = new THREE.Object3D()
  campfires.forEach((camp) => {
    const ud = camp.userData
    if (!ud.isLit) return  // 熄灭的篝火不更新火焰
    const s = ud.scale

    // 火光闪烁
    ud.flickerPhase += delta * 8
    const flicker = 0.85 + Math.sin(ud.flickerPhase) * 0.1 + Math.sin(ud.flickerPhase * 2.3) * 0.05
    ud.fireLight.intensity = 3 * flicker
    ud.core.material.emissiveIntensity = 2.5 * flicker

    // 更新火焰粒子
    const fp = ud.fireParticles
    for (let i = 0; i < fp.length; i++) {
      const p = fp[i]
      p.life += delta
      if (p.life >= p.maxLife) {
        // 重生
        const a = Math.random() * Math.PI * 2
        const r = Math.random() * 0.3 * s
        p.x = Math.cos(a) * r
        p.y = 0
        p.z = Math.sin(a) * r
        p.vy = 0.8 + Math.random() * 1.2
        p.life = 0
        p.maxLife = 0.8 + Math.random() * 0.5
        p.scale = 0.5 + Math.random() * 0.8
      }
      p.x += p.vx * delta * 0.5
      p.y += p.vy * delta
      p.z += p.vz * delta * 0.5
      // 颜色随生命周期渐变（橙→红→暗）通过缩放与位置体现
      const t = p.life / p.maxLife
      const curScale = p.scale * (1 - t) * s
      dummy.position.set(p.x, p.y, p.z)
      dummy.scale.setScalar(Math.max(0, curScale))
      dummy.updateMatrix()
      ud.fireMesh.setMatrixAt(i, dummy.matrix)
    }
    ud.fireMesh.instanceMatrix.needsUpdate = true

    // 更新烟雾粒子
    const sp = ud.smokeParticles
    for (let i = 0; i < sp.length; i++) {
      const p = sp[i]
      p.life += delta
      if (p.life >= p.maxLife) {
        const a = Math.random() * Math.PI * 2
        const r = Math.random() * 0.25 * s
        p.x = Math.cos(a) * r
        p.y = 0.4 * s
        p.z = Math.sin(a) * r
        p.vy = 0.6 + Math.random() * 0.6
        p.life = 0
        p.maxLife = 1.5 + Math.random() * 0.8
        p.scale = 0.3 + Math.random() * 0.6
      }
      p.x += p.vx * delta
      p.y += p.vy * delta
      p.z += p.vz * delta
      // 烟雾上升时膨胀并淡出
      const t = p.life / p.maxLife
      const curScale = (p.scale + t * 1.5) * s
      dummy.position.set(p.x, p.y, p.z)
      dummy.scale.setScalar(curScale)
      dummy.updateMatrix()
      ud.smokeMesh.setMatrixAt(i, dummy.matrix)
      // 通过设置 opacity 不可行（InstancedMesh 共享材质），改用缩放衰减体现淡出
    }
    ud.smokeMesh.instanceMatrix.needsUpdate = true
  })
}

// ===================== 云朵（灰白色低云） =====================
function createCloud(x, z, baseHeight) {
  const cloudGroup = new THREE.Group()
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xd8d8e0,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
    emissive: 0xc0c0c8,
    emissiveIntensity: 0.1
  })

  const puffCount = 8
  for (let i = 0; i < puffCount; i++) {
    const radius = 4 + Math.random() * 8
    const puffGeo = new THREE.SphereGeometry(radius, 10, 7)
    const puff = new THREE.Mesh(puffGeo, cloudMat.clone())
    puff.material.opacity = 0.5 + Math.random() * 0.25
    puff.scale.set(
      1.2 + Math.random() * 0.8,
      0.5 + Math.random() * 0.3,
      1.0 + Math.random() * 0.6
    )
    puff.position.set(
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 4,
      (Math.random() - 0.5) * 12
    )
    puff.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI)
    cloudGroup.add(puff)
  }

  cloudGroup.position.set(x, baseHeight, z)
  cloudGroups.push(cloudGroup)
  scene.add(cloudGroup)
}

function createClouds() {
  const [minH, maxH] = [35, 90]
  for (let i = 0; i < SNOW_CONFIG.cloudCount; i++) {
    const x = (Math.random() - 0.5) * 400
    const z = (Math.random() - 0.5) * 300
    const height = minH + Math.random() * (maxH - minH)
    createCloud(x, z, height)
  }
}

// ===================== 飘雪粒子 =====================
function createSnowParticles() {
  const count = SNOW_CONFIG.snowParticleCount
  const geo = new THREE.SphereGeometry(0.08, 4, 3)
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.85
  })
  const instMesh = new THREE.InstancedMesh(geo, mat, count)

  const dummy = new THREE.Object3D()
  snowVelocities = []

  for (let i = 0; i < count; i++) {
    dummy.position.set(
      (Math.random() - 0.5) * 250,
      Math.random() * 60 + 5,
      (Math.random() - 0.5) * 250
    )
    const s = 0.5 + Math.random() * 1.2
    dummy.scale.setScalar(s)
    dummy.updateMatrix()
    instMesh.setMatrixAt(i, dummy.matrix)

    snowVelocities.push({
      vx: (Math.random() - 0.5) * 0.04,
      vy: -0.05 - Math.random() * 0.08,
      vz: (Math.random() - 0.5) * 0.04,
      swayPhase: Math.random() * Math.PI * 2,
      swayAmp: 0.02 + Math.random() * 0.03
    })
  }

  snowParticles = instMesh
  scene.add(instMesh)
}

function updateSnowParticles(delta) {
  if (!snowParticles || !snowVelocities) return
  const dummy = new THREE.Object3D()
  const total = snowParticles.count

  for (let i = 0; i < total; i++) {
    snowParticles.getMatrixAt(i, dummy.matrix)
    dummy.matrix.decompose(dummy.position, dummy.rotation, dummy.scale)

    const v = snowVelocities[i]
    // 横向飘移加正弦摆动
    dummy.position.x += v.vx + Math.sin(v.swayPhase) * v.swayAmp
    dummy.position.y += v.vy
    dummy.position.z += v.vz + Math.cos(v.swayPhase) * v.swayAmp
    v.swayPhase += delta * 2

    // 落地或低于地面时重置到高空
    const groundY = getTerrainHeight(dummy.position.x, dummy.position.z)
    if (dummy.position.y < groundY) {
      dummy.position.set(
        (Math.random() - 0.5) * 250,
        55 + Math.random() * 10,
        (Math.random() - 0.5) * 250
      )
    }

    dummy.updateMatrix()
    snowParticles.setMatrixAt(i, dummy.matrix)
  }
  snowParticles.instanceMatrix.needsUpdate = true
}

// ===================== 玩家小人（冬装版） =====================
function createPlayer() {
  const group = new THREE.Group()

  // 身体：厚冬衣
  const bodyGeo = new THREE.CapsuleGeometry(0.4, 0.7, 4, 12)
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x1a5276, // 深蓝冬装
    roughness: 0.8,
    metalness: 0.05
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

  // 毛线帽（半球 + 顶球）
  const hatGeo = new THREE.SphereGeometry(0.32, 12, 8, 0, Math.PI * 2, 0, Math.PI / 1.6)
  const hatMat = new THREE.MeshStandardMaterial({
    color: 0xc0392b,
    roughness: 0.9,
    flatShading: true
  })
  const hat = new THREE.Mesh(hatGeo, hatMat)
  hat.position.y = 1.78
  hat.castShadow = true
  group.add(hat)
  // 帽顶毛球
  const pomGeo = new THREE.SphereGeometry(0.1, 8, 6)
  const pom = new THREE.Mesh(pomGeo, hatMat)
  pom.position.y = 2.05
  group.add(pom)

  // 围巾
  const scarfGeo = new THREE.TorusGeometry(0.32, 0.1, 6, 16)
  const scarfMat = new THREE.MeshStandardMaterial({
    color: 0xe74c3c,
    roughness: 0.85
  })
  const scarf = new THREE.Mesh(scarfGeo, scarfMat)
  scarf.position.y = 1.5
  scarf.rotation.x = Math.PI / 2
  group.add(scarf)

  // 手臂
  const armGeo = new THREE.CapsuleGeometry(0.12, 0.55, 4, 8)
  const armMat = new THREE.MeshStandardMaterial({ color: 0x1a5276, roughness: 0.8 })
  const armL = new THREE.Mesh(armGeo, armMat)
  armL.position.set(-0.5, 0.8, 0)
  armL.castShadow = true
  group.add(armL)
  const armR = new THREE.Mesh(armGeo, armMat)
  armR.position.set(0.5, 0.8, 0)
  armR.castShadow = true
  group.add(armR)

  // 腿（厚裤子）
  const legGeo = new THREE.CapsuleGeometry(0.14, 0.45, 4, 8)
  const legMat = new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.85 })
  const legL = new THREE.Mesh(legGeo, legMat)
  legL.position.set(-0.16, 0.2, 0)
  legL.castShadow = true
  group.add(legL)
  const legR = new THREE.Mesh(legGeo, legMat)
  legR.position.set(0.16, 0.2, 0)
  legR.castShadow = true
  group.add(legR)

  // 朝向指示（鼻子）
  const noseGeo = new THREE.SphereGeometry(0.05, 6, 4)
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xd0a070 })
  const nose = new THREE.Mesh(noseGeo, noseMat)
  nose.position.set(0, 1.7, 0.28)
  group.add(nose)

  group.userData = { armL, armR, legL, legR }
  playerMesh = group
  scene.add(playerMesh)

  // 物理体
  playerBody = new CANNON.Body({
    mass: 5,
    fixedRotation: true,
    material: new CANNON.Material({ friction: 0.0 })
  })
  playerBody.addShape(new CANNON.Sphere(0.4))
  playerBody.position.set(0, 2, 0)
  playerBody.linearDamping = 0.2
  playerBody.allowSleep = false
  playerBody.ccdSpeedThreshold = 0.5
  playerBody.ccdMotionThreshold = 0.5
  world.addBody(playerBody)
}

// ===================== 玩家移动 + 摄像机 =====================
function updatePlayer(delta) {
  if (!playerBody || !playerMesh) return

  const moveSpeed = playerKeys.shift ? 13 : 7.5 // 雪地略慢
  const forward = new THREE.Vector3(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw))
  const right = new THREE.Vector3(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw))

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
    const accel = 0.25
    playerBody.velocity.x += (moveX - playerBody.velocity.x) * accel
    playerBody.velocity.z += (moveZ - playerBody.velocity.z) * accel
    playerBody.wakeUp()

    const targetRot = Math.atan2(moveX, moveZ)
    let diff = targetRot - playerMesh.rotation.y
    while (diff > Math.PI) diff -= Math.PI * 2
    while (diff < -Math.PI) diff += Math.PI * 2
    playerMesh.rotation.y += diff * 0.2
  } else {
    playerBody.velocity.x *= 0.7
    playerBody.velocity.z *= 0.7
  }

  // 地形跟随
  const terrainY = getTerrainHeight(playerBody.position.x, playerBody.position.z)
  const targetY = terrainY + 0.4
  playerBody.position.y += (targetY - playerBody.position.y) * 0.3
  playerBody.velocity.y = 0

  // 同步 mesh
  const prevRotY = playerMesh.rotation.y
  playerMesh.position.copy(playerBody.position)
  playerMesh.position.y += 0.2
  playerMesh.rotation.y = prevRotY

  // 边界检测：走出雪原半径时传送回森林
  const px = playerBody.position.x
  const pz = playerBody.position.z
  const distFromCenter = Math.sqrt(px * px + pz * pz)
  if (distFromCenter > SNOW_CONFIG.boundX) {
    if (onTeleportCallback) {
      onTeleportCallback()
      return
    }
  }

  // 跑动动画
  const limbs = playerMesh.userData
  if (limbs) {
    if (isMoving) {
      playerAnimTime += delta * (playerKeys.shift ? 15 : 10)
      const swing = Math.sin(playerAnimTime) * 0.5
      limbs.armL.rotation.x = swing
      limbs.armR.rotation.x = -swing
      limbs.legL.rotation.x = -swing * 0.8
      limbs.legR.rotation.x = swing * 0.8
    } else {
      limbs.armL.rotation.x *= 0.8
      limbs.armR.rotation.x *= 0.8
      limbs.legL.rotation.x *= 0.8
      limbs.legR.rotation.x *= 0.8
    }
  }

  // 第三人称摄像机
  const camDist = 6
  const camOffset = new THREE.Vector3(
    Math.sin(cameraYaw) * camDist * Math.cos(cameraPitch),
    Math.sin(cameraPitch) * camDist + 3,
    Math.cos(cameraYaw) * camDist * Math.cos(cameraPitch)
  )
  camera.position.copy(playerMesh.position).add(camOffset)
  camera.lookAt(
    playerMesh.position.x,
    playerMesh.position.y + 1.2,
    playerMesh.position.z
  )
}

// ===================== 渲染循环 =====================
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

  // 飘雪
  updateSnowParticles(delta)

  // 篝火粒子与火光
  updateCampfires(delta)

  // 松树随风轻摆
  pineTrees.forEach((tree) => {
    tree.rotation.z = Math.sin(wind.time + tree.position.x * 0.1) * 0.015
  })

  // 云朵漂移
  cloudGroups.forEach((cloud) => {
    cloud.position.x += 0.006
    if (cloud.position.x > 220) cloud.position.x = -220
    cloud.children.forEach((piece) => {
      piece.rotation.y = Math.sin(wind.time * 0.7 + piece.position.z) * 0.02
    })
  })

  composer.render()
}
