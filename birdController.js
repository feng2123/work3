import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as CANNON from 'cannon-es'
/**
 * 创建可骑乘车辆控制器（人物 / 车 切换操控）。
 * 适配BMW X3中文命名：轮胎、轮毂、车门。
 * 新增：上车前开门、下车开门延时逻辑
 *
 * @param {object} cfg
 * @param {THREE.Scene} cfg.scene
 * @param {() => THREE.Object3D} cfg.getPlayerMesh
 * @param {() => CANNON.Body} cfg.getPlayerBody
 * @param {(x:number,z:number) => number} cfg.getTerrainHeight
 * @param {number} cfg.boundX            场景边界半径
 * @param {() => void} [cfg.onTeleport]  飞出边界时的回调
 * @param {THREE.Camera} cfg.camera
 * @param {() => number} cfg.getCameraYaw
 * @param {() => number} cfg.getCameraPitch
 * @param {{w:boolean,a:boolean,s:boolean,d:boolean,shift:boolean}} cfg.playerKeys
 * @param {number} [cfg.flyHeight=0.5]   车离地高度
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
  flyHeight = 0.5
}) {
  let birdMesh = null
  let birdModel = null
  let birdMixer = null
  let birdMode = false

  let wheels = []
  let doors = [] // 保存车门对象
  let doorOpenAngle = 0 // 车门当前旋转角度
  const doorMaxAngle = Math.PI / 2.2 // 车门最大打开角度
  let doorAnimTimer = 0
  let doorAnimState = 'closed' // closed / opening / open / closing
  let waitingEnter = false // 是否等待开门完成再上车

  // ---------- 加载车辆模型（阴影 + 轮胎 + 车门） ----------
  function create() {
    const loader = new GLTFLoader()
    loader.load(
      './car/car.glb',
      (gltf) => {
        birdMesh = new THREE.Group()
        birdModel = gltf.scene
        birdModel.scale.multiplyScalar(1.2)
        birdModel.rotation.y = 0

        // 遍历模型子物体
        birdModel.traverse((child) => {
          if(child.isMesh && child.material) {
            // 阴影
            child.castShadow = true;
            child.receiveShadow = true;

            // 贴图色彩修复
            if(Array.isArray(child.material)){
              child.material.forEach(mat=>{
                if(mat.map) mat.map.colorSpace = THREE.SRGBColorSpace
              })
            }else{
              if(child.material.map) child.material.map.colorSpace = THREE.SRGBColorSpace
            }

            // 收集轮胎轮毂
            if(child.name.includes('胎') || child.name.includes('轮毂')){
              wheels.push(child)
            }
            // ✅ 收集车门（名字带【门】）
            if(child.name.includes('门')){
              doors.push(child)
            }
          }
        })

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
      (err) => console.error('车辆模型加载失败：', err)
    )
  }

  // 开门/关门动画更新
  function updateDoorAnimation(delta) {
    const doorSpeed = 1.8
    if(doorAnimState === 'opening'){
      doorOpenAngle += delta * doorSpeed
      if(doorOpenAngle >= doorMaxAngle){
        doorOpenAngle = doorMaxAngle
        doorAnimState = 'open'
      }
      doors.forEach(door=>{
        door.rotation.y = doorOpenAngle
      })
    }
    if(doorAnimState === 'closing'){
      doorOpenAngle -= delta * doorSpeed
      if(doorOpenAngle <= 0){
        doorOpenAngle = 0
        doorAnimState = 'closed'
      }
      doors.forEach(door=>{
        door.rotation.y = doorOpenAngle
      })
    }
  }

  // ---------- 切换人物 / 车（修改为开门延时上车） ----------
  function toggleMode() {
    if (!birdMesh) return
    // 如果正在播放车门动画，直接return，防止重复触发
    if(doorAnimState === 'opening' || doorAnimState === 'closing') return

    const playerMesh = getPlayerMesh()
    const playerBody = getPlayerBody()

    if (!birdMode) {
      // 人 → 上车：先开门，等待开门完成再进入车内
      if(doorAnimState === 'closed'){
        doorAnimState = 'opening'
        waitingEnter = true
        doorAnimTimer = 0
      }
    } else {
      // 下车：开门，延时之后把人物放出来
      if(doorAnimState === 'closed'){
        doorAnimState = 'opening'
        waitingEnter = true
        doorAnimTimer = 0
      }
    }
  }

  // ---------- 车的移动 + 车轮旋转 + 车门动画 + 相机 ----------
  function update(delta) {
    if (!birdMesh) return
    // 更新车门动画
    updateDoorAnimation(delta)

    // 开门完成后等待一小段时间，执行上车/下车
    if(waitingEnter && doorAnimState === 'open'){
      doorAnimTimer += delta
      // 开门后等待0.4秒，再上车
      if(doorAnimTimer > 0.4){
        waitingEnter = false
        if(!birdMode){
          // 执行上车
          const p = playerBody.position
          playerMesh.visible = false
          birdMesh.position.set(p.x, getTerrainHeight(p.x, p.z) + flyHeight, p.z)
          birdMesh.rotation.y = playerMesh.rotation.y
          birdMode = true
          // 上车之后关门
          setTimeout(()=>{
            doorAnimState = 'closing'
          },600)
        }else{
          // 执行下车
          const b = birdMesh.position
          const terrainY = getTerrainHeight(b.x, b.z)
          playerBody.position.set(b.x, terrainY + 0.4, b.z)
          playerBody.velocity.set(0, 0, 0)
          playerMesh.position.copy(playerBody.position)
          playerMesh.position.y += 0.2
          playerMesh.visible = true
          birdMode = false
          // 下车完成关门
          setTimeout(()=>{
            doorAnimState = 'closing'
          },600)
        }
      }
    }

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

    // 轮胎轮毂旋转
    if(wheels.length > 0){
      const wheelRotateSpeed = len * delta * 2.2
      for(const w of wheels){
        w.rotation.x += wheelRotateSpeed
      }
    }

    // 跟随地形高度
    const terrainY = getTerrainHeight(birdMesh.position.x, birdMesh.position.z)
    birdMesh.position.y += (terrainY + flyHeight - birdMesh.position.y) * 0.08

    if (birdMixer) birdMixer.update(delta * (isMoving ? 1.2 : 0.6))

    // 第三人称相机跟随车
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
    wheels = []
    doors = []
  }

  function isBirdMode() { return birdMode }

  // ---------- 检测玩家是否靠近车 ----------
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
