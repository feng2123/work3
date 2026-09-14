import GUI from 'lil-gui'
import * as THREE from 'three'

// ===================== 全局环境状态（跨场景持久化） =====================
export const envState = {
  time: 'day',        // 'day' | 'night'
  weather: 'sunny'    // 'sunny' | 'rainy' | 'snowy'
}

const TIME_LABELS = { day: '白天', night: '黑夜' }
const WEATHER_LABELS = { sunny: '晴天', rainy: '雨天', snowy: '雪天' }

let gui = null
let timeController = null
let weatherController = null
let activeApplier = null   // 当前场景的环境应用函数 (state) => void

function notify() {
  if (typeof activeApplier === 'function') activeApplier(envState)
}

// 注入样式：让 GUI 小巧、半透明、不抢眼
function injectStyle() {
  if (document.getElementById('env-gui-style')) return
  const style = document.createElement('style')
  style.id = 'env-gui-style'
  style.textContent = `
    .lil-gui.root {
      --width: 180px;
      --widget-height: 18px;
      --font-size: 11px;
      --padding: 6px;
      --spacing: 4px;
      --background-color: rgba(22, 24, 32, 0.55);
      --text-color: #e6e6ee;
      --title-background-color: rgba(30, 32, 42, 0.65);
      --title-text-color: #d8d8e2;
      --widget-color: rgba(60, 64, 78, 0.45);
      --hover-color: rgba(84, 90, 108, 0.6);
      --focus-color: rgba(108, 116, 138, 0.7);
      --number-color: #8fd0d0;
      --string-color: #c8e0a8;
      --knob-color: #9ec;
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 1000;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 18px rgba(0,0,0,0.28);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      transition: opacity 0.2s ease;
    }
    .lil-gui.root .title {
      cursor: pointer;
    }
  `
  document.head.appendChild(style)
}

export function initEnvGUI() {
  if (gui) return gui
  injectStyle()
  gui = new GUI({ title: '环境', width: 180 })

  const timeOpt = {}
  Object.keys(TIME_LABELS).forEach(k => { timeOpt[TIME_LABELS[k]] = k })
  timeController = gui.add(envState, 'time', timeOpt).name('时间').onChange(notify)

  // 天气控件按场景动态重建
  rebuildWeatherController(['sunny', 'rainy'])

  // 默认收起，只露出标题栏，保持低调
  gui.close()
  return gui
}

function rebuildWeatherController(options) {
  if (!gui) return
  if (weatherController) {
    weatherController.destroy()
    weatherController = null
  }
  if (!options.includes(envState.weather)) {
    envState.weather = options[0]
  }
  const optMap = {}
  options.forEach(w => { optMap[WEATHER_LABELS[w] || w] = w })
  weatherController = gui.add(envState, 'weather', optMap).name('天气').onChange(notify)
}

/**
 * 场景初始化时调用：注册本场景的环境应用函数，并声明可用天气选项。
 * 调用后会立即把当前 envState 应用到该场景。
 * @param {(state: {time:string,weather:string}) => void} applier
 * @param {string[]} weatherOptions
 */
export function setActiveScene(applier, weatherOptions = ['sunny', 'rainy']) {
  if (!gui) initEnvGUI()
  activeApplier = applier
  rebuildWeatherController(weatherOptions)
  notify()
}

export function getEnvState() {
  return envState
}

// ===================== 月亮（夜空发光 + 月光照明） =====================
/**
 * 在场景中创建一个发光的月亮球体 + 冷色方向光（月光）。
 * 默认不可见，由各场景的 applyEnvironment 在夜间开启。
 * @param {THREE.Scene} scene
 * @param {THREE.Vector3} [position] 月亮位置（高空）
 * @returns {{mesh: THREE.Mesh, light: THREE.DirectionalLight}}
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
