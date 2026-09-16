import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as CANNON from 'cannon-es'
/**
 * 创建可骑乘车辆控制器（人物 / 车 切换操控）。
 * 适配BMW X3中文命名轮胎：前胎右、前胎左、后胎右、后胎左
 * 控制器负责车模型加载、移动、车轮旋转、相机跟随与边界传送。
 * ✅ 修改：上下车自动驱动车门动画，E键只做上下车，移除独立手动开关门
 * ✅ 车辆行为符合现实车辆：
 *   - 前轮转向动画：转向由前轮偏转角（steeringAngle）驱动，松开方向键自动回正
 *   - 车身偏航由「速度 × 转向角」积分，倒车时转向方向自动反向（符合真实倒车）
 *   - 轮子只沿车头方向滚动，速度带符号（倒车轮子反转）
 *   - 车门按「左前/左后/右前/右后」分组，绕铰链轴（门前端边缘）旋转开合
 *
 * @param {object} cfg
 * @param {THREE.Scene} cfg.scene
 * @param {CANNON.World} [cfg.world]         场景物理世界（传入后为车辆挂载碰撞体积，防止穿模）
 * @param {() => THREE.Object3D} cfg.getPlayerMesh
 * @param {() => CANNON.Body} cfg.getPlayerBody
 * @param {(x:number,z:number) => number} cfg.getTerrainHeight
 * @param {number} cfg.boundX            场景边界半径
 * @param {() => void} [cfg.onTeleport]  飞出边界时的回调
 * @param {THREE.Camera} cfg.camera
 * @param {() => number} cfg.getCameraYaw
 * @param {() => number} cfg.getCameraPitch
 * @param {{w:boolean,a:boolean,s:boolean,d:boolean,shift:boolean,e:boolean}} cfg.playerKeys
 * @param {number} [cfg.flyHeight=0]   车离地高度
 */
export function createCarController({
  scene,
  world,
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
  let carMesh = null
  let carModel = null
  let carMixer = null
  let carMode = false
  let carBody = null          // 车辆碰撞代理刚体（防止穿过树木/岩石等场景物体）

  // 碰撞代理用常量（避免每帧分配）
  const Y_AXIS = new CANNON.Vec3(0, 1, 0)

  // 车轮组（DEF-Wheel.*）：滚动绕局部 x 轴
  let wheelGroups = []
  // 前轮转向 pivot（绕竖直轴偏转）
  let frontSteerPivots = []
  // 车门：单一旋转方案 —— 不重挂 mesh、不烘焙四元数，
  // 每帧在世界空间把门部件绕「门前端竖直铰链」旋转，写回局部变换
  let doorHinges = []       // { isLeft, hingeLocal:Vector3, meshes:Mesh[], angle:number }
  let doorOpenTarget = 0    // 0关闭 / doorMaxAngle 打开
  let doorTimer = 0         // 开门后延时自动关门计时（秒）
  const doorMaxAngle = Math.PI / 2.2
  const doorTweenSpeed = 3.5 // 开门动画快慢，越大越快

  // ========== 车辆动力学状态（现实车辆行为） ==========
  let carYaw = 0            // 车头朝向角：车头方向 = (sin carYaw, cos carYaw)
  let speed = 0             // 带符号车速（+前进 / -倒车）
  let steeringAngle = 0     // 当前前轮转向角（rad），左正右负
  const MAX_STEER = 0.5            // 最大转向角 ≈ 28.6°
  const STEER_RESPONSE = 4.0       // 转向响应速度（打轮/回正快慢）
  const ACCEL_RESPONSE = 2.0       // 加减速响应速度
  const YAW_FACTOR = 0.32          // 偏航率 = speed * steeringAngle * YAW_FACTOR

  // ---------- 名称清洗：与 GLTFLoader 的 PropertyBinding.sanitizeNodeName 一致 ----------
  // GLTFLoader 加载时会把节点名中的空格替换为 _，并移除保留字符 . [ ] : /，
  // 例如 'DEF-Wheel.Ft.L' → 'DEF-WheelFtL'、'BMW X3 car' → 'BMW_X3_car'。
  // 因此按名称查找时，候选名必须做同样的清洗后才能与实际节点名匹配。
  function sanitizeName(name) {
    return name.replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '')
  }

  // ---------- 按名称递归查找子物体（兼容清洗后的节点名） ----------
  function findChild(root, ...names) {
    const wanted = names.map(sanitizeName)
    let found = null
    root.traverse((obj) => {
      if (!found && wanted.includes(obj.name)) found = obj
    })
    return found
  }

  // ---------- 车门分组匹配 ----------
  // 返回 0:左前 1:左后 2:右前 3:右后，-1 表示不是车门
  function doorGroupOf(name) {
    if (name === 'leftdoor1' || name.includes('左前门')) return 0
    if (name === 'leftdoor2' || name.includes('左后门')) return 1
    if (name === 'rightdoor1' || name.includes('右前门')) return 2
    if (name === 'rightdoor2' || name.includes('右后门')) return 3
    return -1
  }

  // ---------- 加载车辆模型（阴影 + 匹配中文轮胎名称） ----------
  function create() {
    const loader = new GLTFLoader()
    loader.load(
      './car/car.glb',
      (gltf) => {
        carMesh = new THREE.Group()
        carModel = gltf.scene
        carModel.scale.multiplyScalar(1.2)
        carModel.rotation.y = 0

        // 遍历模型子物体，开启阴影，修复贴图色彩空间；并加入 layer 1
        // （layer 1 供车辆专属补光使用：补光只照 layer 1 物体，不影响场景其他模型）
        carModel.traverse((child) => {
          if (child.isMesh && child.material) {
            child.castShadow = true
            child.receiveShadow = true
            child.layers.enable(1)
            if (Array.isArray(child.material)) {
              child.material.forEach((mat) => {
                if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace
              })
            } else {
              if (child.material.map) child.material.map.colorSpace = THREE.SRGBColorSpace
            }
          }
        })

        // ===== 1. 前轮转向：把 DEF-Wheel.Ft.L / Ft.R 挂到独立 pivot 下 =====
        // pivot 保持原位置、无旋转，因此局部 y 轴 = 世界竖直轴，
        // 旋转 pivot.rotation.y 即让前轮绕竖直轴偏转（转向动画）；
        // 滚动仍在 DEF-Wheel 自身局部 x 轴上进行，转向后滚动轴随前轮朝向联动。
        frontSteerPivots = []
        const flWheel = findChild(carModel, 'DEF-Wheel.Ft.L')
        const frWheel = findChild(carModel, 'DEF-Wheel.Ft.R')
        if (flWheel && frWheel) {
          ;[flWheel, frWheel].forEach((wheel) => {
            const pivot = new THREE.Group()
            pivot.name = 'frontSteerPivot'
            pivot.position.copy(wheel.position)
            const parent = wheel.parent
            parent.remove(wheel)
            wheel.position.set(0, 0, 0)
            pivot.add(wheel)
            parent.add(pivot)
            frontSteerPivots.push(pivot)
          })
        } else {
          console.warn('未找到前轮组 DEF-Wheel.Ft.L/Ft.R，前轮转向动画不可用')
        }

        // ===== 2. 车轮组：DEF-Wheel.* 整体滚动（胎 + 轮毂一起滚） =====
        wheelGroups = []
        const wheelNames = ['DEF-Wheel.Ft.L', 'DEF-Wheel.Ft.R', 'DEF-Wheel.Bk.L', 'DEF-Wheel.Bk.R']
        for (const wn of wheelNames) {
          const w = findChild(carModel, wn)
          if (w) wheelGroups.push(w)
        }

        // ===== 3. 车门：记录门前端竖直铰链（不重挂 mesh，动画时做世界空间单一旋转） =====
        doorHinges = []
        const doorMeshes = [[], [], [], []]
        carModel.traverse((child) => {
          if (!child.isMesh) return
          const g = doorGroupOf(child.name)
          if (g >= 0) doorMeshes[g].push(child)
        })
        doorMeshes.forEach((group, gi) => {
          if (group.length === 0) return
          // 计算车门组的世界包围盒，铰链取门前端边缘（z 最大侧）
          carModel.updateMatrixWorld(true)
          const box = new THREE.Box3()
          group.forEach((m) => box.expandByObject(m))
          if (box.isEmpty()) return
          const center = box.getCenter(new THREE.Vector3())
          const hingeWorld = new THREE.Vector3(center.x, center.y, box.max.z)
          const hingeLocal = carModel.worldToLocal(hingeWorld)
          // 记录铰链点（车模型局部坐标，随车移动仍正确）与该组全部门部件
          doorHinges.push({ isLeft: gi < 2, hingeLocal, meshes: group.slice(), angle: 0 })
        })

        carMesh.add(carModel)
        // ===== 4. 车辆专属补光：跟随车辆的泛光灯（仅照亮车辆自身） =====
        // 车辆漆面材质对漫反射响应较低，且太阳方向固定时车身常处于背光面。
        // 通过 three.js 图层隔离：补光只存在于 layer 1，只有车辆 mesh 加入 layer 1，
        // 因此补光只作用于车辆，场景中其他模型（树/草/人物/沙滩等）不受影响；
        // 车辆同时保留默认 layer 0，相机仍可见。
        const carFillLight = new THREE.PointLight(0xffffff, 9.0, 16, 1)
        carFillLight.position.set(0, 3.2, 0)
        carFillLight.layers.set(1)
        carMesh.add(carFillLight)
        const p = getPlayerBody().position
        const terrainY = getTerrainHeight(p.x + 2, p.z)
        carMesh.position.set(p.x + 2, terrainY + flyHeight, p.z)
        // 初始车头朝向 = 玩家面朝方向（玩家 face = (-sin y, -cos y)，故 +π）
        carYaw = getPlayerMesh().rotation.y + Math.PI
        carMesh.rotation.y = carYaw
        scene.add(carMesh)

        // ===== 5. 车辆碰撞体积：物理代理刚体，防止车体穿过树木/岩石等场景物体 =====
        // 方案：动态刚体（质量很大）作为碰撞代理，运动学逻辑每帧设置其速度，
        // 场景 physics step 在积分位移的同时求解碰撞——车体被障碍物挡住时沿切向
        // 滑行、不会穿入，网格每帧回写物理校正后的位置。
        // 碰撞分组：车辆 = 组2，掩码排除组4（玩家），因此不改变原有的玩家-车交互；
        // 与默认组1的静态障碍物（树干/岩石/山丘/枯木等）正常碰撞。
        if (world) {
          // 临时摆正车头再求模型包围盒（加载阶段无可见帧，不会闪烁）
          const savedRotY = carMesh.rotation.y
          carMesh.rotation.y = 0
          carMesh.updateMatrixWorld(true)
          const carBox = new THREE.Box3().setFromObject(carModel)
          carMesh.rotation.y = savedRotY
          const size = carBox.getSize(new THREE.Vector3())
          const center = carBox.getCenter(new THREE.Vector3()).sub(carMesh.position)
          // 碰撞盒略小于模型（留合理容差），避免贴边行驶时"擦到就停"
          const shrink = 0.9
          const halfW = size.x * 0.5 * shrink
          const halfH = size.y * 0.5 * shrink
          const halfL = size.z * 0.5 * shrink
          carBody = new CANNON.Body({
            mass: 1000,              // 大质量动态体：被静态障碍物阻挡，且不会被玩家推动
            type: CANNON.Body.DYNAMIC,
            position: new CANNON.Vec3(carMesh.position.x, carMesh.position.y, carMesh.position.z),
            collisionFilterGroup: 2, // 车辆专用碰撞组
            collisionFilterMask: ~4  // 与除玩家（组4）外的所有物体碰撞
          })
          carBody.allowSleep = false
          // 形状相对车体原点偏移到模型包围盒中心（模型原点通常在地面附近）
          carBody.addShape(
            new CANNON.Box(new CANNON.Vec3(halfW, halfH, halfL)),
            new CANNON.Vec3(center.x, center.y, center.z)
          )
          world.addBody(carBody)
          console.log(`🚗 车辆碰撞体积已挂载：${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)}m`)
        }

        if (gltf.animations && gltf.animations.length > 0) {
          carMixer = new THREE.AnimationMixer(carModel)
          carMixer.clipAction(gltf.animations[0]).play()
        }
      },
      undefined,
      (err) => console.error('车辆模型加载失败：', err)
    )
  }

  // ---------- 网格位置/朝向同步到碰撞代理体（上下车等直接改网格位置的场景） ----------
  // 同时清空速度/角速度：下车后 update() 不再驱动，避免车辆带着残余速度漂移
  function syncBodyFromMesh() {
    if (!carBody) return
    carBody.position.set(carMesh.position.x, carMesh.position.y, carMesh.position.z)
    carBody.quaternion.setFromAxisAngle(Y_AXIS, carYaw)
    carBody.velocity.set(0, 0, 0)
    carBody.angularVelocity.set(0, 0, 0)
  }

  // ---------- 切换人物 / 车 操控【上下车，自动驱动车门开-关动画】 ----------
  function toggleMode() {
    if (!carMesh) return
    const playerMesh = getPlayerMesh()
    const playerBody = getPlayerBody()
    if (!carMode) {
      // 人 → 上车：车门先打开，短暂延时后自动关闭（完整开关动画）
      doorOpenTarget = doorMaxAngle
      doorTimer = 0.9
      playerMesh.visible = false
      const p = playerBody.position
      carMesh.position.set(p.x, getTerrainHeight(p.x, p.z) + flyHeight, p.z)
      // 保持当前车头朝向：上车前后车头朝向不变（不再与人物朝向对齐）
      carMesh.rotation.y = carYaw
      syncBodyFromMesh()
      speed = 0
      carMode = true
    } else {
      // 下车 → 人：车门打开，人物走出，短暂延时后自动关门
      doorOpenTarget = doorMaxAngle
      doorTimer = 1.2
      const b = carMesh.position
      const terrainY = getTerrainHeight(b.x, b.z)
      playerBody.position.set(b.x, terrainY + 0.4, b.z)
      playerBody.velocity.set(0, 0, 0)
      playerMesh.position.copy(playerBody.position)
      playerMesh.position.y += 0.2
      playerMesh.visible = true
      syncBodyFromMesh() // 清空刚体残余速度，防止停车后漂移
      carMode = false
    }
  }

  // ---------- 车门动画：独立于车辆操控，每帧由场景无条件调用 ----------
  // 实现：不在模型树上做任何重挂/烘焙，只对门部件做「世界空间单一旋转」——
  // 每帧把门绕「门前端竖直铰链（世界竖直轴）」旋转一个增量角，
  // 位置与朝向由父节点矩阵逆变换写回局部，铰链随车移动仍正确。
  function updateDoors(delta) {
    if (!carModel || doorHinges.length === 0) return
    // 开门后延时自动关门（上车短暂开、下车开久一点再关）
    if (doorTimer > 0) {
      doorTimer -= delta
      if (doorTimer <= 0) doorOpenTarget = 0
    }
    // 车当前变换（位置/朝向/缩放）最新化，供世界→局部换算
    carMesh.updateMatrixWorld(true)
    const axis = new THREE.Vector3(0, 1, 0) // 世界竖直铰链轴
    const hingeWorld = new THREE.Vector3()
    const deltaQ = new THREE.Quaternion()
    const vRel = new THREE.Vector3()
    const vWorld = new THREE.Vector3()
    const vLocal = new THREE.Vector3()
    const qWorld = new THREE.Quaternion()
    const qLocal = new THREE.Quaternion()
    const mInv = new THREE.Matrix4()
    const qParentWorld = new THREE.Quaternion()
    const qParentInv = new THREE.Quaternion()
    for (const d of doorHinges) {
      // 目标角：模型车门铰链位于门板靠车身中心一侧、门板在外侧，
      // 因此左门绕竖直轴负角把门板向外（+x，远离车中心）摆，右门正角向外（-x）
      const target = d.isLeft ? -doorOpenTarget : doorOpenTarget
      const step = (target - d.angle) * Math.min(1, doorTweenSpeed * delta)
      if (Math.abs(step) < 1e-6) {
        d.angle = target
        continue
      }
      d.angle += step
      // 世界铰链点（随车移动）
      hingeWorld.copy(d.hingeLocal).applyMatrix4(carModel.matrixWorld)
      deltaQ.setFromAxisAngle(axis, step)
      for (const m of d.meshes) {
        // 1) 世界位置绕铰链旋转
        m.getWorldPosition(vWorld)
        vRel.copy(vWorld).sub(hingeWorld).applyAxisAngle(axis, step).add(hingeWorld)
        // 2) 父节点矩阵逆 → 写回局部位置
        mInv.copy(m.parent.matrixWorld).invert()
        vLocal.copy(vRel).applyMatrix4(mInv)
        m.position.copy(vLocal)
        // 3) 世界旋转叠加增量 → 写回局部四元数
        //    父节点世界四元数用 getWorldQuaternion 链乘取得（matrixWorld 含 1.2 缩放，
        //    setFromRotationMatrix 会提取出非单位四元数导致漂移，必须避免）
        m.getWorldQuaternion(qWorld)
        qLocal.copy(deltaQ).multiply(qWorld)
        m.parent.getWorldQuaternion(qParentWorld)
        qParentInv.copy(qParentWorld).invert()
        m.quaternion.copy(qParentInv.multiply(qLocal))
      }
    }
  }

  // ---------- 车的移动 + 前轮转向 + 车轮旋转 + 相机 ----------
  function update(delta) {
    if (!carMesh) return
    delta = Math.min(delta, 0.05)

    // ========== 1. 转向输入：A 左转 / D 右转，平滑打轮与回正 ==========
    const steerInput = (playerKeys.a ? 1 : 0) - (playerKeys.d ? 1 : 0)
    const steerTarget = steerInput * MAX_STEER
    steeringAngle += (steerTarget - steeringAngle) * Math.min(1, STEER_RESPONSE * delta)
    for (const pivot of frontSteerPivots) {
      pivot.rotation.y = steeringAngle
    }

    // ========== 2. 油门 / 刹车：W 前进 / S 倒车，平滑加减速 ==========
    const throttle = (playerKeys.w ? 1 : 0) - (playerKeys.s ? 1 : 0)
    const maxSpeed = playerKeys.shift ? 20 : 12
    const targetSpeed = throttle * maxSpeed
    speed += (targetSpeed - speed) * Math.min(1, ACCEL_RESPONSE * delta)

    // ========== 3. 车身偏航：偏航率 = 速度 × 转向角（倒车自动反向） ==========
    if (Math.abs(speed) > 0.01) {
      carYaw += speed * steeringAngle * YAW_FACTOR * delta
    }
    carMesh.rotation.y = carYaw

    // ========== 4. 沿车头方向移动（车辆不可横向平移） ==========
    // 有碰撞代理体时以速度驱动：physics step 在积分位移的同时求解碰撞，
    // 车体被障碍物挡住时沿切向滑行、不会穿入，网格每帧回写物理位置；
    // 模型未加载完（无碰撞体）时退化为直接移动网格
    const fx = Math.sin(carYaw)
    const fz = Math.cos(carYaw)
    if (carBody) {
      carBody.velocity.set(fx * speed, 0, fz * speed)
    } else {
      carMesh.position.x += fx * speed * delta
      carMesh.position.z += fz * speed * delta
    }

    // ========== 5. 车轮滚动（速度带符号：倒车反转） ==========
    const roll = speed * delta * 9
    for (const w of wheelGroups) {
      w.rotation.x += roll
    }

    // ========== 6. 车门动画由 updateDoors(delta) 独立驱动 ==========
    //    （场景侧无条件每帧调用，下车后 carMode=false 时动画仍继续播放）

    // ========== 7. 上下车由场景按键（E）统一处理，此处无需重复检测 ==========

    // ========== 8. 跟随地形高度 + 碰撞代理回写 ==========
    const terrainY = getTerrainHeight(carMesh.position.x, carMesh.position.z)
    const targetY = terrainY + flyHeight
    if (carBody) {
      // 垂直方向不做物理积分（无地面刚体），直接按地形高度平滑贴合
      carBody.position.y += (targetY - carBody.position.y) * 0.08
      // 朝向始终由车辆动力学决定（接触求解产生的微小旋转角被覆盖）
      carBody.quaternion.setFromAxisAngle(Y_AXIS, carYaw)
      carBody.angularVelocity.set(0, 0, 0)
      // 物理代理体位置（已由本帧 physics step 做碰撞校正）回写网格
      carMesh.position.copy(carBody.position)
    } else {
      carMesh.position.y += (targetY - carMesh.position.y) * 0.08
    }

    if (carMixer) carMixer.update(delta * (Math.abs(speed) > 0.5 ? 1.2 : 0.6))

    // ========== 9. 第三人称相机跟随车 ==========
    const yaw = getCameraYaw()
    const pitch = getCameraPitch()
    const camDist = 7
    const camOffset = new THREE.Vector3(
      Math.sin(yaw) * camDist * Math.cos(pitch),
      Math.sin(pitch) * camDist + 3,
      Math.cos(yaw) * camDist * Math.cos(pitch)
    )
    camera.position.copy(carMesh.position).add(camOffset)
    camera.lookAt(carMesh.position.x, carMesh.position.y + 0.5, carMesh.position.z)

    // ========== 10. 边界传送 ==========
    const bx = carMesh.position.x
    const bz = carMesh.position.z
    if (Math.sqrt(bx * bx + bz * bz) > boundX) {
      onTeleport && onTeleport()
    }
  }

  function dispose() {
    // 从物理世界移除车辆碰撞代理体（场景卸载时防御性清理）
    if (carBody && world) {
      world.removeBody(carBody)
      carBody = null
    }
    carMesh = null
    carModel = null
    carMixer = null
    carMode = false
    wheelGroups = []
    frontSteerPivots = []
    doorHinges = []
    doorOpenTarget = 0
    doorTimer = 0
  }

  function isCarMode() { return carMode }

  // ---------- 检测玩家是否靠近车 ----------
  function isNearCar(range = 4.5) {
    if (!carMesh || !getPlayerBody()) return false
    const p = getPlayerBody().position
    const dx = carMesh.position.x - p.x
    const dz = carMesh.position.z - p.z
    return (dx * dx + dz * dz) < range * range
  }

  return {
    create,
    update,
    updateDoors,
    toggleMode,
    dispose,
    isCarMode,
    isNearCar,
    reset: () => { carMode = false }
  }
}
