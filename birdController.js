import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/**
 * 创建可骑乘鸟的控制器（人物 / 鸟 切换操控）。
 * 各场景传入所需的上下文引用，控制器负责鸟模型加载、移动、动画、相机跟随与边界传送。
 *
 * @param {object} cfg
 * @param {THREE.Scene} cfg.scene
 * @param {() => THREE.Object3D} cfg.getPlayerMesh
 * @param {() => CANNON.Body} cfg.getPlayerBody
 * @param {(x:number,z:number) => number} cfg.getTerrainHeight
 * @param {number} cfg.boundX            场景边界半径
 * @param {() => void} [cfg.onTeleport]  飞出边界时的回调
 * @param {THREE.Camera} cfg.camera
 * @param {() => number} cfg.getCameraYaw
 * @param {() => number} cfg.getCameraPitch
 * @param {{w:boolean,a:boolean,s:boolean,d:boolean,shift:boolean}} cfg.playerKeys
 * @param {number} [cfg.flyHeight=4]     鸟飞行离地高度
 */
export function createBirdController({
  scene,
  getPlayerMesh,
  getPlayerBody,
  getTerrainHeight,
  boundX,
  onTeleport,
  camera,
  getCameraYaw,
  getCameraPitch,
  playerKeys,
  flyHeight = 4
}) {
  let birdMesh = null
  let birdModel = null
  let birdMixer = null
  let birdMode = false

  // ---------- 加载鸟模型 ----------
  function create() {
    const loader = new GLTFLoader()
    loader.load(
      '/bird_orange/scene.gltf',
      (gltf) => {
        birdMesh = new THREE.Group()
        birdModel = gltf.scene
        birdModel.scale.multiplyScalar(0.7)
        birdModel.rotation.y = Math.PI // GLTF 默认朝 -Z，转正为 +Z
        birdMesh.add(birdModel)

        const p = getPlayerBody().position
        const terrainY = getTerrainHeight(p.x + 2, p.z)
        birdMesh.position.set(p.x + 2, terrainY + flyHeight, p.z)
        scene.add(birdMesh)

        if (gltf.animations && gltf.animations.length > 0) {
          birdMixer = new THREE.AnimationMixer(birdModel)
          birdMixer.clipAction(gltf.animations[0]).play()
        }
      },
      undefined,
      (err) => console.error('鸟模型加载失败：', err)
    )
  }

  // ---------- 切换人物 / 鸟 操控 ----------
  function toggleMode() {
    if (!birdMesh) return
    const playerMesh = getPlayerMesh()
    const playerBody = getPlayerBody()
    if (!birdMode) {
      // 人 → 鸟
      playerMesh.visible = false
      const p = playerBody.position
      birdMesh.position.set(p.x, getTerrainHeight(p.x, p.z) + flyHeight, p.z)
      birdMesh.rotation.y = playerMesh.rotation.y
      birdMode = true
    } else {
      // 鸟 → 人
      const b = birdMesh.position
      const terrainY = getTerrainHeight(b.x, b.z)
      playerBody.position.set(b.x, terrainY + 0.4, b.z)
      playerBody.velocity.set(0, 0, 0)
      playerMesh.position.copy(playerBody.position)
      playerMesh.position.y += 0.2
      playerMesh.visible = true
      birdMode = false
    }
  }

  // ---------- 鸟的移动 + 相机（操作方式与人物一致） ----------
  function update(delta) {
    if (!birdMesh) return
    const yaw = getCameraYaw()
    const moveSpeed = playerKeys.shift ? 20 : 12
    const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw))
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw))

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
      birdMesh.position.x += moveX * delta
      birdMesh.position.z += moveZ * delta
      const targetRot = Math.atan2(moveX, moveZ)
      let diff = targetRot - birdMesh.rotation.y
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2
      birdMesh.rotation.y += diff * 0.25
    }

    // 保持飞行高度（随地形起伏）
    const terrainY = getTerrainHeight(birdMesh.position.x, birdMesh.position.z)
    birdMesh.position.y += (terrainY + flyHeight - birdMesh.position.y) * 0.08

    if (birdMixer) birdMixer.update(delta * (isMoving ? 1.2 : 0.6))

    // 第三人称摄像机跟随鸟
    const pitch = getCameraPitch()
    const camDist = 7
    const camOffset = new THREE.Vector3(
      Math.sin(yaw) * camDist * Math.cos(pitch),
      Math.sin(pitch) * camDist + 3,
      Math.cos(yaw) * camDist * Math.cos(pitch)
    )
    camera.position.copy(birdMesh.position).add(camOffset)
    camera.lookAt(birdMesh.position.x, birdMesh.position.y + 0.5, birdMesh.position.z)

    // 边界传送
    const bx = birdMesh.position.x
    const bz = birdMesh.position.z
    if (Math.sqrt(bx * bx + bz * bz) > boundX) {
      onTeleport && onTeleport()
    }
  }

  function dispose() {
    birdMesh = null
    birdModel = null
    birdMixer = null
    birdMode = false
  }

  function isBirdMode() { return birdMode }

  // ---------- 检测玩家是否靠近鸟 ----------
  function isNearBird(range = 4.5) {
    if (!birdMesh || !getPlayerBody()) return false
    const p = getPlayerBody().position
    const dx = birdMesh.position.x - p.x
    const dz = birdMesh.position.z - p.z
    return (dx * dx + dz * dz) < range * range
  }

  return {
    create,
    update,
    toggleMode,
    dispose,
    isBirdMode,
    isNearBird,
    reset: () => { birdMode = false }
  }
}
