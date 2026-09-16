// ===================== 全局音乐管理器 =====================
// 三张地图各播各的曲目：森林 Patience / 沙滩 Sand Time / 雪原 White Garden
// 切图时由各场景 init 调用 playMusic() 自动切换，dispose 调用 stopMusic()
// 播放链路：Web Audio 解码循环播放（主），<audio> 元素兜底（file:// 或解码失败时）
// 浏览器自动播放限制：模块加载时注册一次全局交互监听，首次点击/按键后自动解锁
// 快速切图竞态：加载带代次令牌，过期加载结果直接丢弃，不会出现"旧曲子晚到"串台

let audioCtx = null          // Web Audio 上下文
let audioBuffer = null       // 当前曲目的解码缓冲
let audioSource = null       // 当前音频源节点
let audioGain = null         // 音量增益节点
let audioElement = null      // 兜底 <audio>
let audioUnlocked = false    // 是否已解锁 <audio> 播放
let pendingUrl = null        // 最近一次请求的曲目 URL
let lastGoodUrl = null       // 本次曲目成功取到的 URL（兜底用）
let failedUrl = null         // 最近加载失败的 URL（交互后重试）
let loadToken = 0            // 加载代次：快速切图时丢弃过期加载结果
let loading = false          // 是否正在加载
let volume = 0.25          // 当前音量 0~1（封面可调）

// 为同一个音频生成多个候选路径，兼容不同项目布局
function candidatesFor(url) {
  return [url, `./${url}`, `../${url}`]
}

// 依次尝试候选路径，返回第一个可用的 ArrayBuffer
async function fetchAudioBuffer(url) {
  for (const candidate of candidatesFor(url)) {
    try {
      const response = await fetch(candidate)
      if (response.ok) {
        lastGoodUrl = candidate
        return await response.arrayBuffer()
      }
    } catch (e) { /* 该路径不可用，尝试下一个 */ }
  }
  throw new Error(`音频文件不存在（已尝试多个路径）：${url}，请确认文件已放入 assets/ 目录`)
}

// 停止当前 Web Audio 播放节点（保留缓冲）
function stopSource() {
  if (audioSource) {
    try { audioSource.stop() } catch (e) { /* 已停止则忽略 */ }
    audioSource = null
  }
}

// 用当前缓冲创建新的循环音源
function startSource() {
  if (!audioCtx || !audioBuffer) return
  stopSource()
  audioSource = audioCtx.createBufferSource()
  audioSource.buffer = audioBuffer
  audioSource.loop = true   // 循环播放
  audioGain = audioCtx.createGain()
  audioGain.gain.value = volume
  audioSource.connect(audioGain)
  audioGain.connect(audioCtx.destination)
  audioSource.start()
}

// 对外：播放指定曲目（自动停止上一首；快速切图时旧加载结果会被丢弃）
export function playMusic(url) {
  pendingUrl = url
  failedUrl = null
  lastGoodUrl = null
  // 切换曲目时清理旧兜底元素，避免与 Web Audio 同时出声
  if (audioElement) {
    audioElement.pause()
    audioElement = null
  }
  const token = ++loadToken
  // 首次调用时才创建音频上下文（可能被浏览器挂起，等首次交互解锁）
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    } catch (e) {
      audioCtx = null
    }
  }
  // 立即停止正在播放的旧曲目，避免两首叠播
  stopSource()
  audioBuffer = null
  loadAndPlay(url, token)
}

async function loadAndPlay(url, token) {
  loading = true
  try {
    const arrayBuffer = await fetchAudioBuffer(url)
    if (token !== loadToken || url !== pendingUrl) return // 已切换曲目，丢弃过期结果
    if (!audioCtx) return
    const buffer = await audioCtx.decodeAudioData(arrayBuffer)
    if (token !== loadToken || url !== pendingUrl) return
    audioBuffer = buffer
    startSource()
    unlockMusic() // 若用户已交互过，立即恢复播放
  } catch (e) {
    if (token !== loadToken) return
    failedUrl = url
    console.warn(`音乐加载失败，尝试 <audio> 兜底播放：${url}`, e)
    setupAudioFallback(url)
  } finally {
    loading = false
  }
}

// 兜底：<audio> 元素（file:// 直接打开页面时 fetch 不可用，也能播放）
function setupAudioFallback(url) {
  if (audioElement) { audioElement.pause() }
  audioElement = new Audio(lastGoodUrl || url)
  audioElement.loop = true
  audioElement.volume = volume
  audioElement.preload = 'auto'
  audioUnlocked = false // 新元素需要重新解锁（首次交互后开始播放）
}

// 每次用户交互时调用：解锁/恢复/重试音乐
export function unlockMusic() {
  // 恢复被浏览器挂起的音频上下文（自动播放策略要求）
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {})
  }
  // 兜底 <audio>：首次交互后开始播放
  if (audioElement && !audioUnlocked) {
    audioUnlocked = true
    audioElement.play().catch(() => {})
  }
  // 兜底天气音效 <audio>：首次交互后开始播放
  if (weatherElement && weatherElement.paused) {
    weatherElement.play().catch(() => {})
  }
  // 之前加载失败：借这次交互重试当前曲目
  if (failedUrl && !loading) {
    playMusic(failedUrl)
  }
  // 天气音效之前加载失败：借这次交互重试
  if (weatherFailedUrl && weatherFailedUrl !== weatherUrl) {
    playWeatherSound(weatherFailedUrl)
  }
}

// 对外：调节音量（封面音量滑块调用）
export function setVolume(v) {
  volume = Math.min(1, Math.max(0, v))
  if (audioGain) audioGain.gain.value = volume
  if (audioElement) audioElement.volume = volume
  if (weatherGain) weatherGain.gain.value = volume * WEATHER_VOLUME
  if (weatherElement) weatherElement.volume = volume * WEATHER_VOLUME
}

// 对外：获取当前音量
export function getVolume() {
  return volume
}

// ===================== 天气音效（雨声 / 雪声，叠加在背景音乐之上） =====================
// 天气音效与背景音乐并行播放：天气切换时由 envManager 调用 playWeatherSound / stopWeatherSound
// 播放链路与音乐一致：Web Audio 解码循环（主），<audio> 元素兜底，首次交互后自动解锁
let weatherSource = null      // 天气音效音频源节点
let weatherGain = null        // 天气音效增益节点
let weatherBuffer = null      // 天气音效解码缓冲
let weatherElement = null     // 天气音效 <audio> 兜底
let weatherUrl = null         // 最近一次请求的天气音效 URL
let weatherFailedUrl = null   // 加载失败的天气音效 URL（交互后重试）
let weatherToken = 0          // 加载代次：快速切换天气时丢弃过期加载结果
const WEATHER_VOLUME = 0.8    // 天气音效相对主音量的比例（略低于音乐，作为氛围衬底）

// 停止当前 Web Audio 天气音源（保留缓冲）
function stopWeatherSource() {
  if (weatherSource) {
    try { weatherSource.stop() } catch (e) { /* 已停止则忽略 */ }
    weatherSource = null
  }
}

// 用当前缓冲创建新的循环天气音源
function startWeatherSource() {
  if (!audioCtx || !weatherBuffer) return
  stopWeatherSource()
  weatherSource = audioCtx.createBufferSource()
  weatherSource.buffer = weatherBuffer
  weatherSource.loop = true   // 循环播放
  weatherGain = audioCtx.createGain()
  weatherGain.gain.value = volume * WEATHER_VOLUME
  weatherSource.connect(weatherGain)
  weatherGain.connect(audioCtx.destination)
  weatherSource.start()
}

// 对外：播放天气音效（自动停止上一个天气音效，与背景音乐并行）
export function playWeatherSound(url) {
  weatherUrl = url
  weatherFailedUrl = null
  // 切换音效时清理旧兜底元素，避免与 Web Audio 同时出声
  if (weatherElement) {
    weatherElement.pause()
    weatherElement = null
  }
  const token = ++weatherToken
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    } catch (e) {
      audioCtx = null
    }
  }
  // 立即停止正在播放的旧天气音效，避免叠播
  stopWeatherSource()
  weatherBuffer = null
  loadWeatherAndPlay(url, token)
}

async function loadWeatherAndPlay(url, token) {
  try {
    const arrayBuffer = await fetchAudioBuffer(url)
    if (token !== weatherToken || url !== weatherUrl) return // 已切换天气，丢弃过期结果
    if (!audioCtx) return
    const buffer = await audioCtx.decodeAudioData(arrayBuffer)
    if (token !== weatherToken || url !== weatherUrl) return
    weatherBuffer = buffer
    startWeatherSource()
    unlockMusic() // 若用户已交互过，确保音频上下文处于播放状态
  } catch (e) {
    if (token !== weatherToken) return
    weatherFailedUrl = url
    console.warn(`天气音效加载失败，尝试 <audio> 兜底播放：${url}`, e)
    setupWeatherFallback(url)
  }
}

// 兜底：<audio> 元素播放天气音效（file:// 直接打开页面时也能播放）
function setupWeatherFallback(url) {
  if (weatherElement) { weatherElement.pause() }
  weatherElement = new Audio(url)
  weatherElement.loop = true
  weatherElement.volume = volume * WEATHER_VOLUME
  weatherElement.preload = 'auto'
  weatherElement.play().catch(() => {}) // 受自动播放限制时等首次交互后播放
}

// 对外：停止天气音效（天气切回晴天或场景切换时调用）
export function stopWeatherSound() {
  weatherUrl = null
  weatherFailedUrl = null
  weatherToken++
  stopWeatherSource()
  weatherBuffer = null
  if (weatherElement) {
    weatherElement.pause()
    weatherElement = null
  }
}

// 对外：停止音乐（场景卸载时调用，一并停止天气音效，切图后新场景会重新触发对应音效）
export function stopMusic() {
  stopSource()
  audioBuffer = null
  if (audioElement) {
    audioElement.pause()
    audioElement.currentTime = 0
  }
  stopWeatherSound()
}

// 全局解锁监听：模块加载时注册一次，整个应用生命周期有效
window.addEventListener('pointerdown', unlockMusic)
window.addEventListener('keydown', unlockMusic)
