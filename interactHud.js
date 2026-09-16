// ===================== 屏幕右方可交互提示 HUD =====================
// 靠近可交互物时，在屏幕右方显示操作提示（可多行，自动淡入淡出）

let hintEl = null
let lastKey = ''

function ensureEl() {
  if (hintEl) return
  hintEl = document.createElement('div')
  hintEl.id = 'interact-hint'
  hintEl.className = 'hidden'
  document.body.appendChild(hintEl)
}

/**
 * 显示提示行（每帧可调用，内容不变时跳过 DOM 更新）
 * @param {Array<{key:string,text:string}>} lines
 */
export function showHint(lines) {
  const key = lines.map((l) => `${l.key}|${l.text}`).join('__')
  if (key === lastKey) return
  lastKey = key
  ensureEl()
  hintEl.innerHTML = lines
    .map((l) => `<div class="hint-line"><span class="hint-key">${l.key}</span><span class="hint-text">${l.text}</span></div>`)
    .join('')
  hintEl.classList.remove('hidden')
}

export function hideHint() {
  lastKey = ''
  if (hintEl) hintEl.classList.add('hidden')
}
