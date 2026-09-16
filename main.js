// 场景模块（模块顶层自行初始化对应场景）
import './forestScene.js'
import './beachScene.js'
import './snowScene.js'
// 音乐与音量控制
import { setVolume, getVolume, unlockMusic } from './musicManager.js'

// ===================== 封面：开始键 + 音量设置 =====================
const cover = document.getElementById('cover')
const startBtn = document.getElementById('start-btn')
const volumeSlider = document.getElementById('volume-slider')
const volumePct = document.getElementById('volume-pct')

// 音量滑块与音乐管理器同步（默认 25%）
volumeSlider.value = Math.round(getVolume() * 100)
volumePct.textContent = volumeSlider.value + '%'
volumeSlider.addEventListener('input', () => {
  setVolume(volumeSlider.value / 100)
  volumePct.textContent = volumeSlider.value + '%'
})

// 开始键：解锁音频（浏览器自动播放策略）并淡出封面
startBtn.addEventListener('click', () => {
  unlockMusic()
  cover.classList.add('hidden')
  setTimeout(() => cover.remove(), 700)
})

// ===================== 操作指南：折叠/展开 =====================
const helpPanel = document.getElementById('help-panel')
helpPanel.querySelector('.help-title').addEventListener('click', () => {
  helpPanel.classList.toggle('collapsed')
})
