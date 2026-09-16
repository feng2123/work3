import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js'
import { Water } from 'three/addons/objects/Water.js'
import { Sky } from 'three/addons/objects/Sky.js'
import * as CANNON from 'cannon-es'
import { setActiveScene, createMoon, computeDaylight } from './envManager.js'
import { createCarController } from './carController.js'
import { createBackpack, createSpotMarker, createBeachChairModel, findClearSpots, updateMarkerPulse } from './buildables.js'
import { showHint, hideHint } from './interactHud.js'
import { playMusic, stopMusic } from './musicManager.js'
// ===================== 沙滩场景配置 =====================
const BEACH_CONFIG = {
  groundSize: 300,        // 沙滩大小
  oceanSize: 10000,       // 海洋大小（延伸至地平线）
  boundX: 115,            // 玩家走出此半径将传送回森林
  fogColor: 0xc8d8e8,
  fogNear: 100,
  fogFar: 350,
  sunPos: new THREE.Vector3(-60, 85, 50),
  sunColor: 0xfff5d8,
  sunIntensity: 1.4,
  palmCount: 28,
  rockCount: 22,
  cloudCount: 30,
  umbrellaCount: 6,
  starfishCount: 18,
  // 海水参数
  waterColor: 0x004868,
  waterAlpha: 0.40,
  distortionScale: 0.18,
  sunWaterColor: 0xe6a850,
  // 渔船
  boatCount: 12,
  boatMinDist: 130,        // 渔船距沙滩最小距离（拉近使其更明显）
  boatMaxDist: 220         // 渔船距沙滩最大距离
}
// ===================== 全局变量 =====================
let scene, camera, renderer, controls, clock
let world, composer, sunLight
let ambientLight, hemiLight
let playerMesh, playerBody
let water, sky, waterTime = 0
let sandMesh
let rainPoints = null
let moon = null
let carController = null
// 钓鱼交互
let isFishing = false
let fishingRod = null
let fishingBuoy = null
// —— 沙滩椅系统 ——
let chairParts = false         // 是否已取出沙滩椅零件
let chairBackpack = null       // 背上的沙滩椅背包
let chairSpots = []            // 海边搭建点 {x, z, y, marker}
let beachChair = null          // 已搭建沙滩椅 {group, seatX, seatY, seatZ}
let onChair = false            // 玩家是否坐在椅上
let chairSeatRef = null        // 椅座引用（移动起身用）
const palmTrees = []
const cloudGroups = []
const boats = []
const sceneBodyList = []
let animationFrameId = null
let onTeleportCallback = null
let eventAbortController = null
const textureLoader = new THREE.TextureLoader()
// 玩家输入与摄像机控制
const playerKeys = { w: false, a: false, s: false, d: false, shift: false }
let cameraYaw = 0
let cameraPitch = 0.25
let isOrbitMode = false
let playerAnimTime = 0
const wind = { time: 0, strength: 0.05, speed: 0.6 }

// ===================== 纹理加载工具 =====================
function createTex(path, repeatX = 20, repeatZ = 20, isNormalDX = false) {
  const tex = textureLoader.load(
    `texture/${path}`,
    () => console.log(`✅ 沙滩贴图加载: texture/${path}`),
    undefined,
    () => console.warn(`❌ 沙滩贴图缺失: texture/${path}`)
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
// 复用森林场景的纹理资源（岩石、树皮）
const rockColorTex = createTex('Rock060_1K-JPG/Rock060_1K-JPG_Color.jpg', 2, 2)
const rockRoughTex = createTex('Rock060_1K-JPG/Rock060_1K-JPG_Roughness.jpg', 2, 2)
const rockNormalDXTex = createTex('Rock060_1K-JPG/Rock060_1K-JPG_NormalDX.jpg', 2, 2, true)
const barkColorTex = createTex('Bark012_1K-JPG/Bark012_1K-JPG_Color.jpg', 3, 6)
const barkRoughTex = createTex('Bark012_1K-JPG/Bark012_1K-JPG_Roughness.jpg', 3, 6)
const sandgroundColorTex = createTex('Ground080_1K-JPG/Ground080_1K-JPG_Color.jpg', 30, 30)
const sandgroundRoughTex = createTex('Ground080_1K-JPG/Ground080_1K-JPG_Roughness.jpg', 30, 30)
const sandgroundNormalDXTex = createTex('Ground080_1K-JPG/Ground080_1K-JPG_NormalDX.jpg', 30, 30, true)

// 云朵、镜头光晕在线贴图
const cloudTex = textureLoader.load('https://threejs.org/examples/textures/lensflare/cloud.png')
const flareTex0 = textureLoader.load('https://threejs.org/examples/textures/lensflare/lensflare0.png')
const flareTex1 = textureLoader.load('https://threejs.org/examples/textures/lensflare/lensflare1.png')
// 海水法线贴图（用于波纹反射折射）
const waterNormalsTex = textureLoader.load(
  'https://threejs.org/examples/textures/waternormals.jpg',
  (t) => {
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
  }
)
// ===================== 雨滴粒子（雨天） =====================
function createRainParticles() {
  const count = 6000
  const positions = new Float32Array(count * 3)
  const velocities = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 220
    positions[i * 3 + 1] = Math.random() * 60
    positions[i * 3 + 2] = (Math.random() - 0.5) * 220
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
      pos[i * 3 + 1] = 60
      pos[i * 3] = (Math.random() - 0.5) * 220
      pos[i * 3 + 2] = (Math.random() - 0.5) * 220
    }
  }
  rainPoints.geometry.attributes.position.needsUpdate = true
}

// ===================== 环境应用（昼夜 / 晴雨） =====================
function applyEnvironment(state) {
  if (!scene || !renderer) return
  const dl = computeDaylight(state.timeProgress)
  const isRainy = state.weather === 'rainy'

  // —— 自动昼夜：日出/白天/日落/黑夜连续插值 ——
  if (sky) {
    const skyU = sky.material.uniforms
    // 太阳随光照因子升降：夜里落到地平线下，白天高悬
    skyU['sunPosition'].value.set(0.5, -0.6 + 1.5 * dl.sunFactor, 0.8)
    skyU['turbidity'].value = 2 + 2.2 * (1 - dl.sunFactor)
    skyU['rayleigh'].value = 0.3 + 0.6 * (1 - dl.sunFactor)
    skyU['mieCoefficient'].value = 0.003 + 0.008 * (1 - dl.sunFactor)
    skyU['mieDirectionalG'].value = 0.75
  }
  scene.fog.color.copy(dl.bgColor)
  ambientLight.color.set(0xfaf0d8)
  ambientLight.intensity = 0.85 * dl.ambFactor
  hemiLight.color.set(0x88ccff)
  hemiLight.groundColor.set(0xffddaa)
  hemiLight.intensity = 0.65 * dl.ambFactor
  sunLight.color.copy(dl.sunColor)
  sunLight.intensity = BEACH_CONFIG.sunIntensity * 0.7 * dl.sunFactor
  renderer.toneMappingExposure = 0.6 * dl.exposure
  if (moon) { moon.mesh.visible = dl.moonVisible; moon.light.visible = dl.moonVisible }
  if (water) {
    const dayWater = new THREE.Color(BEACH_CONFIG.waterColor)
    const nightWater = new THREE.Color(0x001828)
    water.material.uniforms['waterColor'].value.copy(dayWater.lerp(nightWater, 1 - dl.sunFactor))
    const daySunW = new THREE.Color(BEACH_CONFIG.sunWaterColor)
    const nightSunW = new THREE.Color(0x334466)
    water.material.uniforms['sunColor'].value.copy(daySunW.lerp(nightSunW, 1 - dl.sunFactor))
  }

  // —— 晴雨 ——
  if (isRainy) {
    scene.fog.near = 20
    scene.fog.far = 120
    sunLight.intensity *= 0.4
    ambientLight.intensity *= 0.65
    hemiLight.intensity *= 0.6
    if (rainPoints) rainPoints.visible = true
  } else {
    scene.fog.near = BEACH_CONFIG.fogNear
    scene.fog.far = BEACH_CONFIG.fogFar
    if (rainPoints) rainPoints.visible = false
  }
}

// ===================== 对外接口 =====================
export function initBeach(opts = {}) {
  onTeleportCallback = opts.onTeleport || null
  initThree()
  initPhysics()
  initPostProcess()
  createSandGround()
  createOcean()
  createPalmTrees()
  createBeachRocks()
  createBeachUmbrellas()
  createStarfish()
  createBoats()
  createClouds()
  createRainParticles()
  setupChairSpots()
  moon = createMoon(scene)
  createPlayer()
  // 车辆控制器
  carController = createCarController({
    scene,
    world,
    getPlayerMesh: () => playerMesh,
    getPlayerBody: () => playerBody,
    getTerrainHeight,
    boundX: BEACH_CONFIG.boundX,
    onTeleport: () => onTeleportCallback && onTeleportCallback(),
    camera,
    getCameraYaw: () => cameraYaw,
    getCameraPitch: () => cameraPitch,
    playerKeys
  })
  carController.create()
  // 播放沙滩地图背景音乐（切图时 musicManager 自动切换曲目）
  playMusic('assets/Emil Negri - Sand Time.ogg')
  // 注册环境 GUI，沙滩支持 晴/雨
  setActiveScene(applyEnvironment, ['sunny', 'rainy'])
  animate()
  console.log('🏖️ 沙滩场景已启动')
}
export function disposeBeach() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }
  if (eventAbortController) {
    eventAbortController.abort()
    eventAbortController = null
  }
  // 释放物理世界
  if (world) {
    world.bodies.slice().forEach((b) => world.removeBody(b))
  }
  // 释放水面与天穹资源
  if (water) {
    water.geometry?.dispose()
    water.material?.dispose()
    water = null
  }
  if (sky) {
    sky.geometry?.dispose()
    sky.material?.dispose()
    sky = null
  }
  // 释放渲染器
  if (renderer) {
    renderer.dispose()
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
    renderer.forceContextLoss?.()
  }
  // 清空集合
  palmTrees.length = 0
  cloudGroups.length = 0
  boats.length = 0
  sceneBodyList.length = 0
  moon = null
  isFishing = false
  fishingRod = null
  if (fishingBuoy) { scene.remove(fishingBuoy); fishingBuoy = null }
  // 清理沙滩椅系统
  chairSpots.forEach((s) => { if (s.marker) scene.remove(s.marker) })
  chairSpots = []
  if (beachChair) { scene.remove(beachChair.group); beachChair = null }
  chairParts = false
  if (chairBackpack && playerMesh) playerMesh.remove(chairBackpack)
  chairBackpack = null
  onChair = false
  chairSeatRef = null
  hideHint()
  if (carController) { carController.dispose(); carController = null }
  // 停止沙滩地图背景音乐（下一张地图的 init 会播放自己的曲目）
  stopMusic()
  console.log('🧹 沙滩场景已卸载')
}
// ===================== 初始化 Three 渲染 =====================
function initThree() {
  eventAbortController = new AbortController()
  const { signal } = eventAbortController
  scene = new THREE.Scene()
  scene.background = null // Sky 天穹将作为背景
  scene.fog = new THREE.Fog(BEACH_CONFIG.fogColor, BEACH_CONFIG.fogNear, BEACH_CONFIG.fogFar)
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 20000)
  camera.position.set(0, 8, 14)
  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.6
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
    // 按 E：坐椅钓鱼/收竿/钓鱼 或 靠近车辆时切换人物与车辆
    if (k === 'e') {
      if (carController && carController.isCarMode()) {
        carController.toggleMode()
      } else if (onChair) {
        // 坐在沙滩椅上：E 键切换钓鱼/收竿
        if (isFishing) {
          stopFishing()
        } else {
          startFishing()
        }
      } else if (isFishing) {
        stopFishing()
      } else if (beachChair && nearChairSeat()) {
        sitOnChair()
      } else if (isNearWater()) {
        startFishing()
      } else if (carController && carController.isNearCar()) {
        carController.toggleMode()
      }
    }
    // 按 F：靠近车辆取出沙滩椅零件 / 在海边处搭建沙滩椅
    if (k === 'f') {
      if (carController && carController.isCarMode()) return
      if (!chairParts && !beachChair && carController && carController.isNearCar()) {
        chairParts = true
        chairBackpack = createBackpack('chair')
        playerMesh.add(chairBackpack)
        console.log('🎒 取出沙滩椅零件，去海边搭建吧')
      } else if (chairParts && !beachChair) {
        const spot = findNearestChairSpot()
        if (spot) buildChair(spot)
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
  // 暖色环境光，模拟海边漫反射
  ambientLight = new THREE.AmbientLight(0xfaf0d8, 0.85)
  scene.add(ambientLight)
  // 半球光：天空蓝 + 沙地暖色
  hemiLight = new THREE.HemisphereLight(0x88ccff, 0xffddaa, 0.65)
  scene.add(hemiLight)
  // 太阳光
  sunLight = new THREE.DirectionalLight(BEACH_CONFIG.sunColor, BEACH_CONFIG.sunIntensity * 0.7)
  sunLight.position.copy(BEACH_CONFIG.sunPos)
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
    0.01,
    0.12,
    0.92
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
// ===================== 沙滩地形高度 =====================
function getTerrainHeight(x, z) {
  const n1 = Math.sin(x * 0.04) * Math.cos(z * 0.035) * 0.5
  const n2 = Math.sin(x * 0.09 + z * 0.07) * 0.25
  const dist = Math.sqrt(x * x + z * z)
  const slope = Math.max(0, (dist - 70) / 50) * 1.2
  return n1 + n2 - slope
}
// ===================== 沙滩地面 =====================
function createSandGround() {
  const size = BEACH_CONFIG.groundSize
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
  const mat = new THREE.MeshStandardMaterial({
    color: 0xe8d4a0,
    map:sandgroundColorTex ,
    roughnessMap:sandgroundRoughTex ,
    normalMap: sandgroundNormalDXTex,
    roughness: 0.96,
    metalness: 0,
    emissive: 0x2a2008,
    emissiveIntensity: 0.04,
    flatShading: false
  })
  sandMesh = new THREE.Mesh(geo, mat)
  sandMesh.receiveShadow = true
  scene.add(sandMesh)
  const wetSandGeo = new THREE.CircleGeometry(150, 64)
  wetSandGeo.rotateX(-Math.PI / 2)
  const wetPosAttr = wetSandGeo.attributes.position
  for (let i = 0; i < wetPosAttr.count; i++) {
    const wx = wetPosAttr.getX(i)
    const wz = wetPosAttr.getZ(i)
    wetPosAttr.setY(i, getTerrainHeight(wx, wz) - 0.02)
  }
  wetPosAttr.needsUpdate = true
  wetSandGeo.computeVertexNormals()
  const wetSandMat = new THREE.MeshStandardMaterial({
    color: 0x9a8458,
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: 0.6
  })
  const wetSand = new THREE.Mesh(wetSandGeo, wetSandMat)
  wetSand.position.y = -0.02
  wetSand.receiveShadow = true
  scene.add(wetSand)
}
// ===================== 海洋 =====================
function createOcean() {
  const sunDirection = BEACH_CONFIG.sunPos.clone().normalize()
  sky = new Sky()
  sky.scale.setScalar(15000)
  scene.add(sky)
  const skyU = sky.material.uniforms
  skyU['turbidity'].value = 3.2
  skyU['rayleigh'].value = 0.9
  skyU['mieCoefficient'].value = 0.003
  skyU['mieDirectionalG'].value = 0.75
  skyU['sunPosition'].value.copy(sunDirection)

  const waterGeo = new THREE.PlaneGeometry(BEACH_CONFIG.oceanSize, BEACH_CONFIG.oceanSize)
  water = new Water(waterGeo, {
    textureWidth: 1024,
    textureHeight: 1024,
    waterNormals: waterNormalsTex,
    sunDirection: sunDirection,
    sunColor: BEACH_CONFIG.sunWaterColor,
    waterColor: BEACH_CONFIG.waterColor,
    distortionScale: BEACH_CONFIG.distortionScale,
    alpha: BEACH_CONFIG.waterAlpha
  })
  water.rotation.x = -Math.PI / 2
  water.position.y = -0.6
  water.material.transparent = true
  scene.add(water)

  scene.fog.color.set(0xb8d0e0)
}
function updateOcean(delta) {
  waterTime += delta
  if (water) {
    water.material.uniforms['time'].value += delta * 0.6
  }
}
// ===================== 椰树 =====================
function createPalmTree(posX, posZ, scale = 1) {
  const group = new THREE.Group()
  const trunkHeight = 7 * scale
  const trunkGeo = new THREE.CylinderGeometry(0.25 * scale, 0.45 * scale, trunkHeight, 8, 6)
  const posAttr = trunkGeo.attributes.position
  for (let i = 0; i < posAttr.count; i++) {
    const y = posAttr.getY(i)
    const t = (y + trunkHeight / 2) / trunkHeight
    const bend = Math.sin(t * Math.PI * 0.5) * 0.6 * scale
    posAttr.setX(i, posAttr.getX(i) + bend)
  }
  posAttr.needsUpdate = true
  trunkGeo.computeVertexNormals()
  const trunkMat = new THREE.MeshStandardMaterial({
    color: 0x9a7b4a,
    roughness: 0.95,
    map: barkColorTex,
    roughnessMap: barkRoughTex,
    emissive: 0x1a1208,
    emissiveIntensity: 0.04
  })
  const trunk = new THREE.Mesh(trunkGeo, trunkMat)
  trunk.position.y = trunkHeight / 2
  trunk.castShadow = true
  trunk.receiveShadow = true
  group.add(trunk)
  const topGeo = new THREE.SphereGeometry(0.4 * scale, 8, 6)
  const topMat = new THREE.MeshStandardMaterial({ color: 0x6b5530, roughness: 0.9 })
  const top = new THREE.Mesh(topGeo, topMat)
  top.position.y = trunkHeight
  group.add(top)
  const frondCount = 8
  for (let i = 0; i < frondCount; i++) {
    const angle = (i / frondCount) * Math.PI * 2
    const frondGeo = new THREE.SphereGeometry(0.5 * scale, 8, 4)
    frondGeo.scale(4, 0.18, 1.4)
    const frondMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(0.25 + Math.random() * 0.05, 0.55, 0.32 + Math.random() * 0.1),
      roughness: 0.7,
      side: THREE.DoubleSide,
      flatShading: true,
      emissive: 0x082008,
      emissiveIntensity: 0.05
    })
    const frond = new THREE.Mesh(frondGeo, frondMat)
    frond.position.x = 2 * scale
    frond.castShadow = true
    const frondGroup = new THREE.Group()
    frondGroup.add(frond)
    frondGroup.position.set(
      Math.cos(angle) * 0.5 * scale,
      trunkHeight + 0.2,
      Math.sin(angle) * 0.5 * scale
    )
    frondGroup.rotation.y = angle
    frondGroup.rotation.z = -0.35 - Math.random() * 0.2
    group.add(frondGroup)
  }
  const cocoCount = 2 + Math.floor(Math.random() * 3)
  for (let i = 0; i < cocoCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const cocoGeo = new THREE.SphereGeometry(0.22 * scale, 8, 6)
    const cocoMat = new THREE.MeshStandardMaterial({
      color: 0x5a3a1a,
      roughness: 0.8
    })
    const coco = new THREE.Mesh(cocoGeo, cocoMat)
    coco.position.set(
      Math.cos(angle) * 0.4 * scale,
      trunkHeight - 0.3,
      Math.sin(angle) * 0.4 * scale
    )
    coco.castShadow = true
    group.add(coco)
  }
  group.position.set(posX, getTerrainHeight(posX, posZ), posZ)
  group.rotation.y = Math.random() * Math.PI * 2
  scene.add(group)
  palmTrees.push(group)
  const trunkBody = new CANNON.Body({ mass: 0 })
  trunkBody.addShape(new CANNON.Cylinder(0.3 * scale, 0.5 * scale, trunkHeight, 8))
  trunkBody.position.set(posX, getTerrainHeight(posX, posZ) + trunkHeight / 2, posZ)
  world.addBody(trunkBody)
  sceneBodyList.push(trunkBody)
}
function createPalmTrees() {
  for (let i = 0; i < BEACH_CONFIG.palmCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 15 + Math.random() * 80
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const scale = 0.8 + Math.random() * 0.6
    createPalmTree(x, z, scale)
  }
}


// ===================== 海滩岩石 =====================
function createBeachRock(posX, posZ, size) {
  const rockGeo = new THREE.DodecahedronGeometry(size, 0)
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x8a8a8a,
    emissive: 0x111111,
    emissiveIntensity: 0.04,
    map: rockColorTex,
    roughnessMap: rockRoughTex,
    normalMap: rockNormalDXTex,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.95
  })
  const rockMesh = new THREE.Mesh(rockGeo, rockMat)
  rockMesh.position.set(posX, getTerrainHeight(posX, posZ) + size * 0.4, posZ)
  rockMesh.rotation.set(Math.random(), Math.random(), Math.random())
  rockMesh.castShadow = true
  rockMesh.receiveShadow = true
  scene.add(rockMesh)
  const rockBody = new CANNON.Body({ mass: 0 })
  rockBody.addShape(new CANNON.Sphere(size * 0.8))
  rockBody.position.set(posX, getTerrainHeight(posX, posZ) + size * 0.5, posZ)
  world.addBody(rockBody)
  sceneBodyList.push(rockBody)
}
function createBeachRocks() {
  for (let i = 0; i < BEACH_CONFIG.rockCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 10 + Math.random() * 90
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const size = 0.6 + Math.random() * 1.5
    createBeachRock(x, z, size)
  }
}
// ===================== 沙滩遮阳伞 =====================
function createBeachUmbrella(posX, posZ) {
  const group = new THREE.Group()
  const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, 3.2, 8)
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.5, metalness: 0.3 })
  const pole = new THREE.Mesh(poleGeo, poleMat)
  pole.position.y = 1.6
  pole.castShadow = true
  group.add(pole)
  const colors = [0xe74c3c, 0x3498db, 0xf39c12, 0x9b59b6, 0x2ecc71]
  const segCount = 8
  for (let s = 0; s < segCount; s++) {
    const segGeo = new THREE.CircleGeometry(2.2, 8, (s / segCount) * Math.PI * 2, (Math.PI * 2) / segCount)
    segGeo.rotateX(-Math.PI / 2)
    const segMat = new THREE.MeshStandardMaterial({
      color: colors[s % colors.length],
      roughness: 0.6,
      side: THREE.DoubleSide,
      flatShading: true
    })
    const seg = new THREE.Mesh(segGeo, segMat)
    seg.position.y = 3.2
    seg.rotation.z = -0.08
    seg.castShadow = true
    group.add(seg)
  }
  const tipGeo = new THREE.ConeGeometry(0.15, 0.5, 8)
  const tipMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.6 })
  const tip = new THREE.Mesh(tipGeo, tipMat)
  tip.position.y = 3.6
  group.add(tip)
  const chairGeo = new THREE.BoxGeometry(1.2, 0.15, 2)
  const chairMat = new THREE.MeshStandardMaterial({
    color: 0xf0e0c0,
    roughness: 0.8
  })
  const chair = new THREE.Mesh(chairGeo, chairMat)
  chair.position.set(0, 0.3, 1.6)
  chair.castShadow = true
  chair.receiveShadow = true
  group.add(chair)
  for (let lx of [-0.5, 0.5]) {
    for (let lz of [0.8, 2.4]) {
      const legGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.3, 5)
      const leg = new THREE.Mesh(legGeo, chairMat)
      leg.position.set(lx, 0.15, lz)
      group.add(leg)
    }
  }
  group.position.set(posX, getTerrainHeight(posX, posZ), posZ)
  group.rotation.y = Math.random() * Math.PI * 2
  scene.add(group)
}
function createBeachUmbrellas() {
  for (let i = 0; i < BEACH_CONFIG.umbrellaCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 12 + Math.random() * 60
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    createBeachUmbrella(x, z)
  }
}
// ===================== 海星装饰 =====================
function createSingleStarfish(posX, posZ) {
  const group = new THREE.Group()
  const colors = [0xe74c3c, 0xe67e22, 0x9b59b6, 0xf1c40f]
  const baseColor = colors[Math.floor(Math.random() * colors.length)]
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2
    const armGeo = new THREE.SphereGeometry(0.2, 6, 4)
    armGeo.scale(1, 0.3, 2.4)
    const armMat = new THREE.MeshStandardMaterial({
      color: baseColor,
      roughness: 0.7,
      flatShading: true,
      emissive: baseColor,
      emissiveIntensity: 0.05
    })
    const arm = new THREE.Mesh(armGeo, armMat)
    arm.position.x = Math.cos(angle) * 0.3
    arm.position.z = Math.sin(angle) * 0.3
    arm.rotation.y = -angle
    group.add(arm)
  }
  const centerGeo = new THREE.SphereGeometry(0.25, 8, 6)
  centerGeo.scale(1, 0.4, 1)
  const centerMat = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness: 0.7,
    flatShading: true
  })
  const center = new THREE.Mesh(centerGeo, centerMat)
  center.position.y = 0.05
  group.add(center)
  group.position.set(posX, getTerrainHeight(posX, posZ) + 0.05, posZ)
  group.rotation.y = Math.random() * Math.PI * 2
  scene.add(group)
}
function createStarfish() {
  for (let i = 0; i < BEACH_CONFIG.starfishCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const radius = 30 + Math.random() * 70
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    createSingleStarfish(x, z)
  }
}
// ===================== 云朵 =====================
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
  const puffCount = 8
  for (let i = 0; i < puffCount; i++) {
    const radius = 4 + Math.random() * 8
    const puffGeo = new THREE.SphereGeometry(radius, 10, 7)
    const puff = new THREE.Mesh(puffGeo, cloudMat.clone())
    puff.material.opacity = 0.55 + Math.random() * 0.25
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
  cloudGroup.userData.originX = x
  cloudGroups.push(cloudGroup)
  scene.add(cloudGroup)
}
function createClouds() {
  const [minH, maxH] = [40, 100]
  for (let i = 0; i < BEACH_CONFIG.cloudCount; i++) {
    const x = (Math.random() - 0.5) * 400
    const z = (Math.random() - 0.5) * 300
    const height = minH + Math.random() * (maxH - minH)
    createCloud(x, z, height)
  }
  for (let i = 0; i < 10; i++) {
    const x = (Math.random() - 0.5) * 500
    const z = -180 - Math.random() * 120
    const height = 70 + Math.random() * 50
    createCloud(x, z, height)
  }
}
// ===================== 远处渔船 =====================
function createBoat(posX, posZ, scale = 1) {
  const group = new THREE.Group()

  // 船体（梯形棱柱状）—— 鲜艳红色使远处也醒目
  const hullGeo = new THREE.BoxGeometry(2.4 * scale, 0.6 * scale, 1.0 * scale)
  const hullMat = new THREE.MeshStandardMaterial({
    color: 0xc0392b, // 鲜红船体
    roughness: 0.7,
    flatShading: true,
    emissive: 0x2a0a04,
    emissiveIntensity: 0.1
  })
  const hull = new THREE.Mesh(hullGeo, hullMat)
  hull.position.y = 0.3 * scale
  hull.castShadow = true
  group.add(hull)

  // 船舷上沿（白色装饰带）
  const trimGeo = new THREE.BoxGeometry(2.5 * scale, 0.08 * scale, 1.05 * scale)
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xf0e8d0,
    roughness: 0.7
  })
  const trim = new THREE.Mesh(trimGeo, trimMat)
  trim.position.y = 0.62 * scale
  group.add(trim)

  // 船舱小屋
  const cabinGeo = new THREE.BoxGeometry(1.0 * scale, 0.7 * scale, 0.8 * scale)
  const cabinMat = new THREE.MeshStandardMaterial({
    color: 0xf5f0e0,
    roughness: 0.8,
    flatShading: true
  })
  const cabin = new THREE.Mesh(cabinGeo, cabinMat)
  cabin.position.set(-0.3 * scale, 0.95 * scale, 0)
  cabin.castShadow = true
  group.add(cabin)

  // 船舱屋顶（梯形扁块）
  const roofGeo = new THREE.BoxGeometry(1.1 * scale, 0.08 * scale, 0.9 * scale)
  const roofMat = new THREE.MeshStandardMaterial({
    color: 0x8b4513,
    roughness: 0.9
  })
  const roof = new THREE.Mesh(roofGeo, roofMat)
  roof.position.set(-0.3 * scale, 1.34 * scale, 0)
  group.add(roof)

  // 桅杆
  const mastHeight = 3.2 * scale
  const mastGeo = new THREE.CylinderGeometry(0.04 * scale, 0.05 * scale, mastHeight, 6)
  const mastMat = new THREE.MeshStandardMaterial({
    color: 0x4a3018,
    roughness: 0.95
  })
  const mast = new THREE.Mesh(mastGeo, mastMat)
  mast.position.set(0.6 * scale, 0.6 * scale + mastHeight / 2, 0)
  mast.castShadow = true
  group.add(mast)

  // 三角帆 —— 米色带红条纹，远处更醒目
  const sailGeo = new THREE.PlaneGeometry(1.4 * scale, 1.8 * scale)
  // 用 canvas 生成条纹纹理
  const sailCanvas = document.createElement('canvas')
  sailCanvas.width = 64
  sailCanvas.height = 64
  const sctx = sailCanvas.getContext('2d')
  sctx.fillStyle = '#faf2dc'
  sctx.fillRect(0, 0, 64, 64)
  sctx.fillStyle = '#c0392b'
  for (let y = 0; y < 64; y += 16) {
    sctx.fillRect(0, y, 64, 6)
  }
  const sailTex = new THREE.CanvasTexture(sailCanvas)
  const sailMat = new THREE.MeshStandardMaterial({
    map: sailTex,
    color: 0xffffff,
    roughness: 0.9,
    side: THREE.DoubleSide,
    flatShading: true,
    emissive: 0x100c04,
    emissiveIntensity: 0.04
  })
  const sail = new THREE.Mesh(sailGeo, sailMat)
  sail.position.set(0.6 * scale - 0.7 * scale, 0.6 * scale + mastHeight * 0.55, 0)
  sail.rotation.y = Math.PI / 2
  group.add(sail)

  // 渔灯（暖色发光球，远处可见亮点）
  const lampGeo = new THREE.SphereGeometry(0.15 * scale, 10, 8)
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xffd070,
    emissive: 0xffb040,
    emissiveIntensity: 2.5
  })
  const lamp = new THREE.Mesh(lampGeo, lampMat)
  lamp.position.set(0.6 * scale, 0.6 * scale + mastHeight * 0.95, 0)
  group.add(lamp)

  // 记录摇摆参数
  group.userData = {
    swayPhase: Math.random() * Math.PI * 2,
    swayAmp: 0.03 + Math.random() * 0.03,
    swaySpeed: 0.6 + Math.random() * 0.6
  }

  group.position.set(posX, -0.55, posZ)
  group.rotation.y = Math.random() * Math.PI * 2
  scene.add(group)
  boats.push(group)
}

function createBoats() {
  for (let i = 0; i < BEACH_CONFIG.boatCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const minD = BEACH_CONFIG.boatMinDist
    const maxD = BEACH_CONFIG.boatMaxDist
    const radius = minD + Math.random() * (maxD - minD)
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const scale = 1.4 + Math.random() * 0.8 // 增大渔船尺寸使其更显眼
    createBoat(x, z, scale)
  }
}
// ===================== 玩家小人 =====================
function createPlayer() {
  const group = new THREE.Group()
  const bodyGeo = new THREE.CapsuleGeometry(0.35, 0.8, 4, 12)
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xc0392b,
    roughness: 0.7,
    metalness: 0.1
  })
  const body = new THREE.Mesh(bodyGeo, bodyMat)
  body.position.y = 0.75
  body.castShadow = true
  group.add(body)
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
  const hairGeo = new THREE.SphereGeometry(0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI / 1.8)
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 })
  const hair = new THREE.Mesh(hairGeo, hairMat)
  hair.position.y = 1.75
  group.add(hair)
  const hatBrimGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.04, 16)
  const hatBrimMat = new THREE.MeshStandardMaterial({ color: 0xf5e6c8, roughness: 0.7 })
  const hatBrim = new THREE.Mesh(hatBrimGeo, hatBrimMat)
  hatBrim.position.y = 1.95
  hatBrim.castShadow = true
  group.add(hatBrim)
  const hatTopGeo = new THREE.ConeGeometry(0.25, 0.4, 16)
  const hatTop = new THREE.Mesh(hatTopGeo, hatBrimMat)
  hatTop.position.y = 2.15
  group.add(hatTop)
  const armGeo = new THREE.CapsuleGeometry(0.1, 0.6, 4, 8)
  const armMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.7 })
  const armL = new THREE.Mesh(armGeo, armMat)
  armL.position.set(-0.45, 0.8, 0)
  armL.castShadow = true
  group.add(armL)
  const armR = new THREE.Mesh(armGeo, armMat)
  armR.position.set(0.45, 0.8, 0)
  armR.castShadow = true
  group.add(armR)
  const legGeo = new THREE.CapsuleGeometry(0.12, 0.5, 4, 8)
  const legMat = new THREE.MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.8 })
  const legL = new THREE.Mesh(legGeo, legMat)
  legL.position.set(-0.15, 0.2, 0)
  legL.castShadow = true
  group.add(legL)
  const legR = new THREE.Mesh(legGeo, legMat)
  legR.position.set(0.15, 0.2, 0)
  legR.castShadow = true
  group.add(legR)
  const noseGeo = new THREE.SphereGeometry(0.05, 6, 4)
  const noseMat = new THREE.MeshStandardMaterial({ color: 0xd0a070 })
  const nose = new THREE.Mesh(noseGeo, noseMat)
  nose.position.set(0, 1.7, 0.28)
  group.add(nose)
  group.userData = { armL, armR, legL, legR }
  playerMesh = group
  scene.add(playerMesh)
  playerBody = new CANNON.Body({
    mass: 5,
    fixedRotation: true,
    material: new CANNON.Material({ friction: 0.0 })
  })
  playerBody.addShape(new CANNON.Sphere(0.4))
  playerBody.collisionFilterGroup = 4 // 玩家专用碰撞组：与车辆（组2）互不碰撞
  playerBody.collisionFilterMask = -1 // 与静态障碍物（组1）正常碰撞
  playerBody.position.set(0, 2, 0)
  playerBody.linearDamping = 0.2
  playerBody.allowSleep = false
  playerBody.ccdSpeedThreshold = 0.5
  playerBody.ccdMotionThreshold = 0.5
  world.addBody(playerBody)
}

// ===================== 钓鱼交互 =====================
const WATER_LEVEL = -0.6  // 水面高度（与 water.position.y 一致）

function isNearWater() {
  if (!playerBody) return false
  // 只有当地形高度降到接近水面（-0.6）时，才认为到达了海水最边缘
  const h = getTerrainHeight(playerBody.position.x, playerBody.position.z)
  return h < -0.35
}

function createFishingRod() {
  const group = new THREE.Group()
  // 钓竿主体（细长圆柱）
  const rodGeo = new THREE.CylinderGeometry(0.025, 0.04, 3.2, 8)
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1a, roughness: 0.6 })
  const rod = new THREE.Mesh(rodGeo, rodMat)
  rod.position.y = 1.6
  group.add(rod)
  // 钓线（细线）
  const lineGeo = new THREE.CylinderGeometry(0.005, 0.005, 2.5, 4)
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const line = new THREE.Mesh(lineGeo, lineMat)
  line.position.set(0, 3.1, 0)
  group.add(line)
  // 鱼钩/浮漂
  const floatGeo = new THREE.SphereGeometry(0.06, 8, 6)
  const floatMat = new THREE.MeshStandardMaterial({ color: 0xff3030 })
  const float = new THREE.Mesh(floatGeo, floatMat)
  float.position.set(0, 1.85, 0)
  group.add(float)
  // 挂在右手位置
  group.position.set(0.45, 0.8, 0.3)
  group.rotation.z = -0.5
  group.visible = false
  return group
}

function createFishingBuoy() {
  const group = new THREE.Group()
  // 浮标主体（上红下白的经典浮漂）
  const topGeo = new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)
  const topMat = new THREE.MeshStandardMaterial({ color: 0xff3020, roughness: 0.5, emissive: 0x551008, emissiveIntensity: 0.3 })
  const top = new THREE.Mesh(topGeo, topMat)
  top.position.y = 0.09
  group.add(top)
  const botGeo = new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)
  const botMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 })
  const bot = new THREE.Mesh(botGeo, botMat)
  bot.position.y = -0.09
  group.add(bot)
  // 顶部小杆
  const stickGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6)
  const stick = new THREE.Mesh(stickGeo, new THREE.MeshStandardMaterial({ color: 0x333333 }))
  stick.position.y = 0.3
  group.add(stick)
  group.visible = false
  return group
}

function startFishing() {
  if (!playerMesh) return
  if (!fishingRod) {
    fishingRod = createFishingRod()
    playerMesh.add(fishingRod)
  }
  if (!fishingBuoy) {
    fishingBuoy = createFishingBuoy()
    scene.add(fishingBuoy)
  }
  isFishing = true
  fishingRod.visible = true
  updateBuoyPosition()
  fishingBuoy.visible = true
  // 钓鱼姿势：右手举起
  const limbs = playerMesh.userData
  if (limbs) {
    limbs.armR.rotation.x = -1.2
    limbs.armL.rotation.x = -0.3
  }
  console.log('🎣 开始钓鱼')
}

function stopFishing() {
  isFishing = false
  if (fishingRod) fishingRod.visible = false
  if (fishingBuoy) fishingBuoy.visible = false
  const limbs = playerMesh.userData
  if (limbs) {
    limbs.armR.rotation.x = 0
    limbs.armL.rotation.x = 0
  }
  console.log('🎣 收起钓竿')
}

// 浮标跟随玩家前方水面，并轻微上下浮动
function updateBuoyPosition() {
  if (!fishingBuoy || !playerBody) return
  const p = playerBody.position
  // 浮标放在玩家面朝方向前方约 4 米的水面上
  const dirX = -Math.sin(playerMesh.rotation.y)
  const dirZ = -Math.cos(playerMesh.rotation.y)
  const bx = p.x - dirX * 4
  const bz = p.z - dirZ * 4
  const bob = Math.sin(performance.now() * 0.003) * 0.06
  fishingBuoy.position.set(bx, WATER_LEVEL + bob, bz)
}

// ===================== 玩家移动 + 摄像机 =====================
function updatePlayer(delta) {
  if (!playerBody || !playerMesh) return
  // 坐在沙滩椅上：有移动输入自动起身，否则锁定在椅位
  if (onChair) {
    const wantMove = playerKeys.w || playerKeys.a || playerKeys.s || playerKeys.d
    if (wantMove) {
      standFromChair()
    } else {
      playerBody.velocity.set(0, 0, 0)
      playerBody.position.set(chairSeatRef.x, chairSeatRef.y, chairSeatRef.z)
      playerMesh.position.copy(playerBody.position)
      playerMesh.position.y += 0.2
      return
    }
  }
  const moveSpeed = playerKeys.shift ? 14 : 8
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
  const terrainY = getTerrainHeight(playerBody.position.x, playerBody.position.z)
  const targetY = terrainY + 0.4
  playerBody.position.y += (targetY - playerBody.position.y) * 0.3
  playerBody.velocity.y = 0
  const prevRotY = playerMesh.rotation.y
  playerMesh.position.copy(playerBody.position)
  playerMesh.position.y += 0.2
  playerMesh.rotation.y = prevRotY
  const px = playerBody.position.x
  const pz = playerBody.position.z
  const distFromCenter = Math.sqrt(px * px + pz * pz)
  if (distFromCenter > BEACH_CONFIG.boundX) {
    if (onTeleportCallback) {
      onTeleportCallback()
      return
    }
  }
  const limbs = playerMesh.userData
  if (limbs) {
    if (isFishing) {
      // 钓鱼时锁定手臂姿势，仅腿部可摆动
      if (isMoving) {
        playerAnimTime += delta * (playerKeys.shift ? 16 : 11)
        const swing = Math.sin(playerAnimTime) * 0.5
        limbs.legL.rotation.x = -swing * 0.8
        limbs.legR.rotation.x = swing * 0.8
      } else {
        limbs.legL.rotation.x *= 0.8
        limbs.legR.rotation.x *= 0.8
      }
    } else if (isMoving) {
      playerAnimTime += delta * (playerKeys.shift ? 16 : 11)
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
  if (carController) carController.updateDoors(delta)
  updateHints()
  updateChairSystem(delta)
  if (controls.enabled) {
    controls.update()
  } else if (carController && carController.isCarMode()) {
    carController.update(delta)
  } else {
    updatePlayer(delta)
  }
  if (isFishing) updateBuoyPosition()
  wind.time += delta * wind.speed
  if (water) updateOcean(delta)
  updateRainParticles()
  palmTrees.forEach((tree) => {
    tree.rotation.z = Math.sin(wind.time + tree.position.x * 0.1) * 0.025
  })
  // 渔船在海浪上轻摇
  boats.forEach((boat) => {
    const ud = boat.userData
    ud.swayPhase += delta * ud.swaySpeed
    boat.rotation.z = Math.sin(ud.swayPhase) * ud.swayAmp
    boat.rotation.x = Math.cos(ud.swayPhase * 0.8) * ud.swayAmp * 0.6
    boat.position.y = -0.55 + Math.sin(ud.swayPhase * 1.3) * 0.12
  })
  cloudGroups.forEach((cloud) => {
    cloud.position.x += 0.008
    if (cloud.position.x > 220) cloud.position.x = -220
    cloud.children.forEach((piece) => {
      piece.rotation.y = Math.sin(wind.time * 0.7 + piece.position.z) * 0.03
    })
  })
  composer.render()
}

// ===================== 沙滩：沙滩椅搭建系统 =====================
function setupChairSpots() {
  chairSpots = findClearSpots(sceneBodyList, {
    count: 2,
    radius: 118,
    minClear: 6,
    flatness: 0.3,
    terrainHeight: getTerrainHeight,
    terrainFilter: (h) => h > -0.58 && h < -0.38 // 海边近水线处的沙滩（浮标落在水面）
  })
  // 找不到时回退到近水线方向的固定点
  if (chairSpots.length === 0) {
    for (const ang of [0.6, -1.2]) {
      const x = Math.cos(ang) * 105
      const z = Math.sin(ang) * 105
      chairSpots.push({ x, z, y: getTerrainHeight(x, z) })
    }
  }
  chairSpots.forEach((s) => {
    const marker = createSpotMarker(0xffb36b)
    marker.position.set(s.x, s.y, s.z)
    scene.add(marker)
    s.marker = marker
  })
  console.log('🏖️ 海边搭建点就绪', chairSpots.map((s) => [s.x, s.z].join(',')).join(' / '))
}

function findNearestChairSpot() {
  if (!playerBody) return null
  const px = playerBody.position.x
  const pz = playerBody.position.z
  let best = null
  let bestD = 3.5 * 3.5
  for (const s of chairSpots) {
    const dx = s.x - px
    const dz = s.z - pz
    const d = dx * dx + dz * dz
    if (d < bestD) { bestD = d; best = s }
  }
  return best
}

function buildChair(spot) {
  if (!scene) return
  const c = createBeachChairModel()
  c.position.set(spot.x, spot.y, spot.z)
  scene.add(c)
  beachChair = {
    group: c,
    seatX: spot.x,
    seatY: spot.y + c.userData.seat.y,
    seatZ: spot.z
  }
  if (chairBackpack && playerMesh) playerMesh.remove(chairBackpack)
  chairBackpack = null
  chairParts = false
  if (spot.marker) { scene.remove(spot.marker); spot.marker = null }
  console.log('🪑 沙滩椅搭建完成！')
}

function nearChairSeat() {
  if (!beachChair || !playerBody) return false
  const px = playerBody.position.x
  const pz = playerBody.position.z
  const dx = beachChair.seatX - px
  const dz = beachChair.seatZ - pz
  return dx * dx + dz * dz < 3.2 * 3.2
}

function sitOnChair() {
  if (!beachChair) return
  onChair = true
  chairSeatRef = { x: beachChair.seatX, y: beachChair.seatY, z: beachChair.seatZ }
  playerBody.position.set(chairSeatRef.x, chairSeatRef.y, chairSeatRef.z)
  playerBody.velocity.set(0, 0, 0)
  playerMesh.rotation.y = cameraYaw
  const limbs = playerMesh.userData
  if (limbs) {
    limbs.legL.rotation.x = -1.1
    limbs.legR.rotation.x = -1.1
    limbs.armL.rotation.x = 0.5
    limbs.armR.rotation.x = 0.5
  }
  console.log('🪑 坐上沙滩椅（E 钓鱼 / WASD 起身）')
}

function standFromChair() {
  if (isFishing) stopFishing()
  onChair = false
  chairSeatRef = null
  const limbs = playerMesh.userData
  if (limbs) {
    limbs.legL.rotation.x = 0
    limbs.legR.rotation.x = 0
    limbs.armL.rotation.x = 0
    limbs.armR.rotation.x = 0
  }
}

function updateChairSystem(delta) {
  chairSpots.forEach((s) => { if (s.marker) updateMarkerPulse(s.marker, delta) })
}

function updateHints() {
  if (!playerBody || !playerMesh) return
  if (carController && carController.isCarMode()) { hideHint(); return }
  const lines = []
  if (onChair) {
    lines.push({ key: 'E', text: isFishing ? '收竿' : '开始钓鱼' })
    lines.push({ key: 'WASD', text: '起身' })
  } else {
    if (!chairParts && !beachChair && carController && carController.isNearCar()) lines.push({ key: 'F', text: '取出沙滩椅零件' })
    if (chairParts && !beachChair && findNearestChairSpot()) lines.push({ key: 'F', text: '搭建沙滩椅' })
    if (beachChair && nearChairSeat()) lines.push({ key: 'E', text: '坐下' })
    if (isNearWater()) lines.push({ key: 'E', text: '钓鱼' })
    if (carController && carController.isNearCar()) lines.push({ key: 'E', text: '上车' })
  }
  if (lines.length) showHint(lines); else hideHint()
}