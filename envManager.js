import * as THREE from 'three'
import { playWeatherSound, stopWeatherSound } from './musicManager.js'

// ===================== 全局环境状态（跨场景持久化） =====================
export const envState = {
  weather: 'sunny',    // 'sunny' | 'rainy' | 'snowy'
  timeProgress: 0.25   // 0~1 循环，0 = 0:00 午夜；0.25 = 6:00 日出
}

// ===================== 天气音效（雨天雨声 / 雪天雪声，叠加在背景音乐之上） =====================
const WEATHER_SOUNDS = {
  rainy: 'assets/weather-rain.wav',
  snowy: 'assets/weather-snow.wav'
}
let activeWeatherSound = null   // 当前已播放音效对应的天气（null = 无音效）

// 天气切换时同步音效：只在天气值变化时触发一次，避免每帧重复调用
function syncWeatherSound() {
  const w = envState.weather
  if (w === activeWeatherSound) return
  activeWeatherSound = w
  const url = WEATHER_SOUNDS[w]
  if (url) playWeatherSound(url)
  else stopWeatherSound()
}

// ===================== 自动时间系统（日出 → 白天 → 日落 → 黑夜） =====================
// 每现实秒推进的游戏时间比例：TIME_SPEED = 1/600 → 24 小时 ≈ 10 分钟走完一昼夜
const TIME_SPEED = 1 / 600
const PHASE_LABEL = { dawn: '🌅 日出', day: '☀️ 白天', dusk: '🌇 日落', night: '🌙 黑夜' }

// 光照关键帧：[timeProgress, sunFactor, ambFactor, sunColor, bgColor, moonVisible, exposure]
// sunFactor / ambFactor 为 0~1 因子，场景用各自的基准强度相乘
const KEYFRAMES = [
  [0.0, 0.12, 0.30, 0x6688cc, 0x0b1226, true,  0.5],  // 0:00 午夜
  [0.21, 0.12, 0.30, 0x6688cc, 0x0b1226, true,  0.5],  // 5:00 夜末
  [0.25, 0.42, 0.55, 0xffb36b, 0x3a4a6a, false, 0.85], // 6:00 日出
  [0.29, 1.0,  1.0,  0xffffff, 0x8bb8d8, false, 1.0],  // 7:00 白天
  [0.71, 1.0,  1.0,  0xffffff, 0x8bb8d8, false, 1.0],  // 17:00 白天末
  [0.75, 0.48, 0.58, 0xff9a5c, 0x6a5a78, false, 0.85], // 18:00 日落
  [0.79, 0.12, 0.30, 0x6688cc, 0x0b1226, true,  0.5],  // 19:00 入夜
  [1.0,  0.12, 0.30, 0x6688cc, 0x0b1226, true,  0.5]   // 24:00 午夜
]

let activeApplier = null   // 当前场景的环境应用函数 (state) => void
let rafId = null
let lastTs = 0
let clockStarted = false

function notify() {
  syncWeatherSound()
  if (typeof activeApplier === 'function') activeApplier(envState)
  updatePhaseBadge()
}

export function phaseOf(tp) {
  const h = tp * 24
  if (h >= 5 && h < 7) return 'dawn'
  if (h >= 7 && h < 17) return 'day'
  if (h >= 17 && h < 19.5) return 'dusk'
  return 'night'
}

/**
 * 由时间进度计算当前光照参数（线性插值关键帧）。
 * @param {number} tp 0~1
 */
export function computeDaylight(tp) {
  let i = 0
  while (i < KEYFRAMES.length - 2 && KEYFRAMES[i + 1][0] <= tp) i++
  const [t0, s0, a0, c0, b0, m0, e0] = KEYFRAMES[i]
  const [t1, s1, a1, c1, b1, m1, e1] = KEYFRAMES[i + 1]
  const span = t1 - t0 || 1e-6
  const k = Math.min(1, Math.max(0, (tp - t0) / span))
  return {
    sunFactor: s0 + (s1 - s0) * k,
    ambFactor: a0 + (a1 - a0) * k,
    sunColor: new THREE.Color(c0).lerp(new THREE.Color(c1), k),
    bgColor: new THREE.Color(b0).lerp(new THREE.Color(b1), k),
    moonVisible: k < 0.5 ? m0 : m1,
    exposure: e0 + (e1 - e0) * k,
    phase: phaseOf(tp),
    hour: tp * 24
  }
}

// 时间自动推进（与渲染无关，独立 rAF 循环）
function tick(ts) {
  if (lastTs) {
    const dt = (ts - lastTs) / 1000
    envState.timeProgress = (envState.timeProgress + dt * TIME_SPEED) % 1
    notify()
  }
  lastTs = ts
  rafId = requestAnimationFrame(tick)
}
function startClock() {
  if (clockStarted) return
  clockStarted = true
  lastTs = 0
  rafId = requestAnimationFrame(tick)
}

// ===================== 时段指示（右上角徽章） =====================
function updatePhaseBadge() {
  const badge = document.getElementById('phase-badge')
  if (!badge) return
  const dl = computeDaylight(envState.timeProgress)
  const hh = Math.floor(dl.hour)
  const mm = Math.floor((dl.hour - hh) * 60)
  badge.textContent = `${PHASE_LABEL[dl.phase]} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

// ===================== 天气调整按钮（右上角，自定义美化） =====================
const WEATHER_LABELS = { sunny: '☀️ 晴', rainy: '🌧️ 雨', snowy: '❄️ 雪' }
let weatherOptions = ['sunny', 'rainy']

function syncWeatherButtons() {
  const bar = document.getElementById('weather-bar')
  if (!bar) return
  bar.querySelectorAll('.weather-btn').forEach((btn) => {
    const w = btn.dataset.weather
    const available = weatherOptions.includes(w)
    btn.hidden = !available
    btn.classList.toggle('active', w === envState.weather)
  })
}

function bindWeatherButtons() {
  const bar = document.getElementById('weather-bar')
  if (!bar || bar.dataset.bound) return
  bar.dataset.bound = '1'
  bar.querySelectorAll('.weather-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      envState.weather = btn.dataset.weather
      syncWeatherButtons()
      notify()
    })
  })
}

// ===================== 对外接口 =====================
/**
 * 场景初始化时调用：注册本场景的环境应用函数，并声明可用天气选项。
 * 调用后会立即把当前 envState 应用到该场景，并启动自动时间循环。
 */
export function setActiveScene(applier, weatherOptionsList = ['sunny', 'rainy']) {
  weatherOptions = weatherOptionsList
  if (!weatherOptions.includes(envState.weather)) {
    envState.weather = weatherOptions[0]
  }
  activeApplier = applier
  bindWeatherButtons()
  syncWeatherButtons()
  notify()
  startClock()
}

export function getEnvState() {
  return envState
}

// ===================== 月亮（夜空发光 + 月光照明） =====================
/**
 * 在场景中创建一个发光的月亮球体 + 冷色方向光（月光）。
 * 默认不可见，由各场景的 applyEnvironment 在夜间开启。
 */
export function createMoon(scene, position) {
  // 月亮放在高空、略偏前方，保证进入场景时抬头可见
  const moonPos = position || new THREE.Vector3(40, 150, -110)

  // 发光月体：自发光材质 + 后期 Bloom 形成光晕
  const moonGeo = new THREE.SphereGeometry(12, 32, 32)
  const moonMat = new THREE.MeshStandardMaterial({
    color: 0xf0f0f8,
    emissive: 0xeaf0ff,
    emissiveIntensity: 3.0,
    roughness: 1,
    metalness: 0
  })
  const moonMesh = new THREE.Mesh(moonGeo, moonMat)
  moonMesh.position.copy(moonPos)
  moonMesh.visible = false
  scene.add(moonMesh)

  // 月光：冷蓝色方向光，照亮夜空下的场景
  const moonLight = new THREE.DirectionalLight(0xaec4ff, 0.9)
  moonLight.position.copy(moonPos)
  moonLight.visible = false
  moonLight.castShadow = false
  scene.add(moonLight)

  return { mesh: moonMesh, light: moonLight }
}
