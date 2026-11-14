# 接入计划：把外壳那套成果搬进自建舞台

> 这份文件是**给未来的我看的路线图**。新会话只读这一份 + `README.md` 就能接上。
> 每完成一步就在下面那一步打勾，并补一句「怎么验的」。
> 最后更新：2026-11-10

## 为什么有两套

`src/` 是现役桌宠的外壳（Electron + 鲸语 1.4 舞台 + 四个补丁）。补丁一碰上游升级就失效，所以长线要挪到自建舞台 `stage/`。

`stage/` **不许 import `src/` 的任何东西**。搬过来的做法是「看懂再自己写一遍」，只有纯数学模块（`drag.js`）原样复制并注明出处。目的是：现役桌宠在 `stage/` 出错时照常能跑。

## 现在 `stage/` 已经有什么

| 能力 | 文件 | 状态 |
|---|---|---|
| 透明无边框窗、`pet://stage` 单源协议 | `main.js` `index.html` | 好 |
| 参数驱动：待机 / 眨眼 / 指针 / 口型 / 动作 | `engine.js` | 好 |
| 穿透 / 分区点触 / Alt 拖动 / Ctrl 滚轮 / 悬停光标 | `interact.js` `drag.js` | 好 |
| 控制口 61945 + 命令行 | `main.js` `cli.mjs` | 好 |
| **指针手感细节**：绕头转圈三节、静止丢失追踪、离屏回正、死区 | `gaze.js` | 好 |

`engine.js` 是**唯一**的参数写入口。任何新功能要动参数，都走它的 `set` 通道，不许别处直接写 core。

## 外壳那边还有哪些东西没搬

按 `src/main.js` 里的函数清单整理，括号里是原来的函数名。

1. **气泡与台词**（`say` `petTick` `syncTickBubble` `compactBubble` `applyBubblePos`）——气泡贴着她的头，逐字出水，自适应宽度，可换位置
2. **语音**（`speakCached` `playVoiceAligned` `prepareAndSay` `wavEnvelope` `warmVoices` `keepAliveTick`）——TTS 预合成缓存、按波形包络驱动口型、保活
3. **点触记录与亲密度**（`handleTouch` `recordTouch` `appendTouch` `forwardTouch` `affinityInfo`）——`data/touch.jsonl`、亲密度分级、POST 给反向桥
4. **情绪系统**（`sendMood` `moodPlan` `runPlan` `startMoodServer` `startSway`）——61943 收心情，换算成动作计划；节律摇摆
5. **托盘与面板**（`Tray` `createWindow` 里的菜单、`panel.html` `panel.js`、尺寸面板）——开关、填值、拖滑杆
6. **DSH 桥**（`startWatcher` `ensureServerThenLoad` `reqPetReply`、61942）——会话联动、阶段气泡、回复钮
7. **杂项**：贴窗口（`applyDock`）、部署体检（`deployCheck`）、帧率上限（`applyStageFps`）、换装复原（`resetOutfit`）

## 接入顺序

一步一验，每步都能单独跑起来。**别跳步**：后一步都建立在前一步上。

### 第 1 步 · 气泡 + 文字 + 口型

- 做：页面里加气泡层（DOM），`/say` 进来 → 气泡贴上她的头、逐字出水、按长度算停留时间、到点淡出；同时 `engine.talk()` 开口型
- 依赖：无
- 验：`node stage\cli.mjs say "主人回来啦"` 出气泡；长句子不会撑爆窗口；气泡跟着头动
- 状态：**已完成**（`bubble.js`，提交见进展记录）

### 第 2 步 · 语音

- 做：接 TTS 桥（`voicePrepare` + `voiceWavDir`），wav 进来后用 `wavEnvelope` 的方式取包络驱动口型，音频和气泡对齐
- 依赖：外部 TTS 服务；冷启动第一句要 27 秒，别当坏
- 验：`cli.mjs say "..." --voice`，有声、嘴型跟得上、气泡和声音对齐
- 状态：**已完成**（`voice.js`）

### 第 3 步 · 点触记录与反向桥

- 做：点她 → 追加 `data/touch.jsonl`、算亲密度、POST 到 `bridgeUrl`；本地反应保留
- 依赖：`dsh-pet-bridge` 在 61944 跑着
- 验：`node cli\pet.mjs touches 20` 能看到记录；DSH 会话被唤醒
- 状态：**已完成**（2026-11-11 晚）。`stage/touch.js` 独立模块：`decide()` 纯函数、`createTouchBook()` 记账；跟外壳同一份 `data/touch.jsonl` / `touch-stats.json`，老账不清零；控制口加 `/touches` `/affinity`，命令行 `touches` / `affinity`；表情改由主进程统一定（部位 + 黏人/一惊一乍/翻脸三种语境），页面只做点头摇头；反向桥默认开，`stage-config.json` 的 `bridge` / `bridgeUrl` 能关

### 第 4 步 · 情绪端口

- 做：61943 收心情 → 换算成表情/动作计划，带强度；节律摇摆
- 依赖：无外部，但`mood.ps1` 是现成的心情来源
- 验：`sendMood('shy', 0.8)` 她明显害羞；摇摆幅度不抢指针跟随
- 状态：**已完成**（2026-11-11 晚）。心情来源改成 `persona\mood.ps1` 那七种中文心情（恬静/开心/害羞/撒娇/担心/认真/困），
  `stage/mood.js` 翻成表情 + 小动作 + 待机摆动偏置；`engine.setMood()` 负责淡入淡出，`/mood` 不给参数时读 `mood.json`；
  命令行 `mood [心情] [--intensity]` / `moods`。实测 `困` 强度 1 的摆幅是基线的 0.65 倍，跟表里一致

### 第 5 步 · 托盘与面板

- 做：托盘菜单（开关、外观、舞台、退出）、右键菜单、设置面板（尺寸滑杆 / 帧率 / 摆动 / 圈数 / 开关）
- 依赖：无
- 验：改一项开关立刻生效；关掉面板不丢配置
- 状态：**已完成**（2026-11-11）。`stage/config.js` 存 `data/stage-config.json`；`panel.html/js/panel-preload.js` 是设置面板；`main.js` 里 `applySize / applyConfig` 是唯一真源，托盘、右键、面板、控制口四条入口都走它们

### 第 6 步 · DSH 桥

- 做：61942 接 DSH，阶段气泡、进度上报、回复钮
- 依赖：DSH 侧插件
- 验：会话里跑长任务，桌宠冒阶段气泡；点回复钮能发消息
- 状态：**已完成**（2026-11-11 晚）。控制口同时监听 61945 / 61942 / 61943（桥里写死的是后两个，桥不用改配置），
  收 GET 查询串和 POST JSON 两种；`/tick` 阶段气泡、`/reply` 回复钮与输入卡、`/api/execute` 执行桥砸过来的 plan
  （只认 expression / motion / gesture，其余如实回报 skipped）；命令行 `tick` / `reply` / `status`。
  实测整条闭环：`reply "测试一下"` → 桥投进桌宠会话 → 她回话 → 桥回流 → 舞台气泡出现回话

### 第 7 步 · 正式替身

- 做：`package.json` 的入口指向 `stage/main.js`，现役那套降级成「回退方案」
- 验：一条命令起桌宠，全功能；把 `src/` 改名仍能跑
- 状态：**已完成**（2026-11-11）。`main` 指向 `stage/main.js`，`npm run start:legacy` 起外壳老版本；`pet-autostart.ps1` / `aux-services.ps1` / `pet-stop.ps1` 的健康端口统一改到 **61945**，实测 stop → autostart 一秒内就绪

## 通用约定

- **端口**：自建舞台控制口 **61945**；现役的 61942 / 61943 / 9333、反向桥 61944 不要占
- **模型与 Core 不进仓库**：模型在 `F:\DaFeiYu\tools\jingyu\model\DeepSeek`；Core 从鲸语 1.4 的 `web/vendor/` 拿来用
- **分支**：一律 `dev`；主人说封版才合 `main`
- **验证手法**：能数字化的就数字化的（`/state`、`/zones`、`/taps`、逐像素比对），别用肉眼比图
- **临时文件**：`F:\DaFeiYu\tmp\<日期>-<事项>\`，收工删；证据留 `F:\DaFeiYu\out\stage\`

## 进展记录

- 2026-11-10 · 第 1 步完成：`bubble.js` 气泡层。三个要点记一笔：
  - 气泡位置每帧从剪影算，锚点是「剪影最顶那一行」的 y + 「顶下 3% 那一行」的左右中点做 x。
    试过「最上面 12% 里最宽的一行」，那是头发最蓬的地方，比头顶低一大截；也试过包围盒中心，
    尾巴往右伸会把 x 拉偏 64px。
  - 字号按窗口宽度算 `W * 0.032`，窗口小的时候 22px 会顶掉半个身子。
  - 泡是 `pointer-events:none`，绝不挡点击。
  - 配套：控制口 `/say` 现在发 `{type:'say', text, ms}`，口型时长按字数估；新增 `/wait`、`/bubble?hide=1`，命令行 `wait` / `hide`。
- 2026-11-10 · 第 2 步完成：`voice.js` 语音链路。要点：
  - TTS 桥沿用外壳那份协议（`SAY_TEXT` 进、stdout 一行 `{job_id, duration}` 出、wav 落在 `VOICE_DIR/<job_id>.wav`），主进程 `spawn('node', [脚本])` 调，不重写。
  - wav 由 `pet://stage/voice/<job_id>.wav` 喂给页面，走同源，不走 file://。
  - 包络在页面里算：`decodeAudioData` 解码后每 1/60 秒取 RMS，归一化乘 1.6（不抬的话正常说话口型只有一半大）。逐帧 `engine.setVoice(v, ms)`，引擎在 `applyMouth` 里优先用包络，没语音才回落到合成张合。
  - 气泡逐字速度由 `reveal` 控制，有语音时按音频时长摊平，字和声音才对得上。
  - `/say?voice=1` 立刻返回 `queued`，先冒等待泡，TTS 好了再一起出场。失败回落到纯文字并报错。
  - 实测：TTS 热态 9 秒出声，口型 `ParamMouthOpenY` 打到 0.73，播完自动归零。
- 2026-11-10 晚 · **指针手感细节搬过来了**（`stage\gaze.js`，不是七步里的一步，是主人点名的「之前花了功夫的小细节」）：
  - 主进程那 33ms 轮询从 `main.js` 里抽成独立模块，`main.js` 只留一句创建 + 绕圈之后长什么样（`SPIN_REACT`）。
  - 三节：转够 6 圈 → 圈圈眼（挂 3.6s 不看鼠标）→ 屑屑眼（4s）→ 黑脸 + HandRaise（26s 冷却，冷却完复原）。
  - 静止丢失追踪：鼠标停 10 秒不再送位置，她视线自然回正；一动立刻恢复。离开本屏同理，回到屏幕立刻跟手。
  - 正中心 ±0.04 死区（手停在窗口正中不左右抖）。
  - **新加一条外壳没有的防护**：一帧转角 > 1.2 弧度（≈69°）当成瞬移，不算转角也不翻方向。以前鼠标跨屏跳两下就可能凑出一圈「发晕」。
  - 圆心用**剪影头顶**（`interact.js` 的 `reportHead()` 报 `{x, top, span}` 给主进程），兜底才是外壳那两个写死比例。
  - 验证：`node scripts/test-gaze.mjs` 31 条纯数学用例（`npm test` 已带上）；实机用 `node stage\cli.mjs gaze circle 2` 跑真实的判定和反应（不挪真鼠标），三节依次触发、`/state` 里 emotion 依次是 圈圈眼 / 屑屑眼 / 黑脸。
  - 演示可以临时把一节改成 2 圈：启动前 `$env:WHALE_SPIN_TURNS='2'`，正常是 6。
- 2026-11-10 深夜 · 主人试了三个问题，一并修：
  - **「一直转没触发」**：两条原因叠在一起。①`zoneR` 只有 0.27 倍窗高（319px），绕着整个身子转会被判出区；②贴着头心（<55px）直接 `spinClear`，可越靠近圆心角速度越快，一次就丢掉大半圈。现在**只要指针在她窗口里就累计**，离开窗口才清零；半径不设下限。
  - **眼睛不回正**：`engine.pointer(null)` 只清 `pointerInput` 没清 `gaze`，身子回正了眼睛还黏着。现在一起清。
  - **头发物理不如鲸语**：模型更新走 `PIXI.Ticker.shared`，只锁 `app.ticker` 没用（实测还是 160+ 帧），两个都锁到 60；顺便摘掉 pixi 自带的 `eyeBlink / breath / updateFocus`（鲸语也这么干，避免和我们的驱动每帧互相覆盖）；待机摆动放大到 1.6 倍（`--sway=` 可调），头发有了输入才动得起来。
  - 验证：`npm test` 71+33 全绿；`/state` 里 tick 率 59.3 次/秒、`stats.maxFps` 60；`gaze?track=0` 之后 `pointer=null`、`eye={0,0}`；`gaze circle 6` 触发第一节。
- 2026-11-10 深夜第二轮（主人再提三条）：
  - 一节 **6 圈改成 4 圈**（6 圈转得太累）。
  - 第二节不再抬手（只 `屑屑眼`）。
  - 第三节的手「抬一下就弹回去」：`engine.motion(name, {hold:true})` 演完停在最后一帧，
    黑脸挂 6.5 秒，提前 1 秒播模型自带的 `HandLower`，1.017 秒刚好在表情复原那一刻放完。
    实测时间线：0~1.1s 抬手 → 1.13s 冻住按在胸口约 4.4 秒 → 5.5s 开始放 → 6.5s 表情和手一起复原。
  - 新口子：`/motion?hold=1`、`/motion-stop`，命令行 `motion HandRaise --hold`、`motion stop`。
- 2026-11-11 18:3x · 第 5 步 + 第 7 步完成（主人下班回来点的）：
  - `config.js` 管 `data/stage-config.json`（互动 / 追踪 / 置顶 / 帧率 / 摆动 / 圈数）。
  - 托盘（`tray-32.png`）+ 右键她弹同一套菜单；菜单口径照外壳那条硬规矩：**状态写进组名，组里只放能点的**
    （`帧率 · 60 fps`、`待机摆动 · 1.6 倍`、`绕圈发晕 · 4 圈`）。
  - 设置面板 `panel.html`：尺寸滑杆（拖的时候实时改、松手落盘，锚底部中心）、帧率、摆动、圈数、三个开关。
  - 唯一真源：`applySize / applyConfig`，托盘、右键、面板、控制口 `/config`、`/window` 全走它，
    所以命令行改和手点改结果一定一致。
  - 控制口新增 `/panel`、`/config`、`/menu`（菜单拍平成文字，方便远程确认勾选状态），命令行同名。
  - 入口切到 `stage/main.js`：`main` 改了，`npm run start:legacy` 起老外壳；加了单实例锁
    （开机自启和手动启动撞车时不会再起第二只）。`pet-autostart.ps1` / `aux-services.ps1` / `pet-stop.ps1`
    的健康端口统一 61943 → **61945**，实测 stop → autostart 1 秒内就绪。
  - 踩到的坑：**`stage` 里别用 `Set-Content` 批量改 UTF-8 文件**——PowerShell 5 没有 BOM 时按 ANSI 读，
    整份中文会变乱码（这次 `gaze.js` 被打花过一遍，靠 `git checkout` 救回来的）。改文件只用编辑工具，别用 shell 写。
- 2026-11-11 19:0x · 主人反馈「摆动没生效」+「拖尺寸乱闪」，查清了：
  - 摆动**是真在动，但幅度 1~3 度、周期 11~17 秒**，人眼根本看不出「在晃」。而且原来只驱动头角，
    裙摆/蕾丝/缎带的物理（吃 `ParamBodyAngleX/Z`）一点输入都没拿到。
  - 现在：头角 + 身体角一起摆，幅度拉到 3~8 度、周期压到 4~7 秒。实测 `--sway=1.0` 时 `AngleX` ±3 度，
    `1.6` 时 ±6.6 度、`ParamBodyAngleX` ±8 度。**别再把幅度调回 1 度级**，那不是"含蓄"，是看不见。
  - 拖尺寸闪：`resizeTo: window` 每来一次 resize 就重建缓冲区，还叠着每次重算 fit + 重扫剪影（同步读整张画布），
    拖动时几十个扫描排队 → 卡 + 闪。改成自己按 25fps 节流 `renderer.resize`，剪影只在停手 200ms 后扫一次，
    扫描定时器同一时刻只留一个。
- 2026-11-11 18:5x · 第 3 步点触账本接完（主人说「先继续，细节后面再优化」）：
  - 新模块 `stage/touch.js`：`decide()` 是纯函数（部位 × 连击数 × 亲密度 × 语境 → 表情 + 台词），
    `createTouchBook()` 只管落盘。`scripts/test-touch.mjs` 61 条单测，`npm test` 现在 71 + 33 + 61。
  - **跟外壳共用同一份账**：`data/touch.jsonl` 流水、`data/touch-stats.json` 统计，所以以前那 67 下、
    连 7 天、最爱被摸头这些都还在，没清零。
  - 语境三条照搬：隔 6 小时没摸 → 第一下一惊一乍（`流冷汗` + `呀…`）；今天被摸 15 下以上 → 第一下黏人
    （`脸红` + `嘿嘿…`）；同部位连击到 3 下翻脸（`＞＜` + `呃…`），亲密度 Lv.4 / Lv.6 把阈值抬到 4 / 5 下。
    第二下只换表情不出声，连点不刷气泡。
  - 表情**只由主进程定**，`interact.js` 里的 `REACTION` 删掉 emotion 只留点头摇头。两边同时改表情会互相打，
    表现是表情闪一下又回去。
  - 控制口加 `/touches?n=` `/affinity`，命令行 `touches [n]` / `affinity`；反向桥默认开
    （`stage-config.json` 的 `bridge` / `bridgeUrl`，61944 不在只记一次日志）。
  - 实测：连点三下 → `眯眼`+`唔…` → 只有 `眯眼` → `＞＜`+`呃…`；`/affinity` 回 `total 69 / today 3 / streak 7 / Lv.2`。
- 2026-11-11 19:0x · 第 4 步心情端口接完：
  - 心情只用 persona 那七种（恬静/开心/害羞/撒娇/担心/认真/困），不含外壳那套 15 种英文情绪。
  - `stage/mood.js` 是纯函数翻译器：表情 + 小动作 + 摆动偏置（幅度倍数 / 重心前倾 / 歪头），强度只放大偏离量。
  - `engine.setMood()` 接偏置：**淡入 0.8 秒、末尾 1.5 秒淡出**，直接切换会像卡帧。
  - `/mood` 不给参数就读 `persona/mood.json`（mood.ps1 的落盘），命令行 `mood` / `moods`。
  - 实测：`困` 强度 1 的 `AngleX` 摆幅 / 基线 = 0.65（表里就是 0.65）；`害羞` 挂 `脸红`；41 条单测。
- 2026-11-11 19:1x · 第 6 步 DSH 桥接完，七步全通：
  - 端口：主口 61945 + 别名 61942 / 61943（`--alias-ports` 可改）。桥里写死 `petSayUrl=61943/say`、`petStageUrl=61942`，
    靠别名口连上，桥那边一行配置都没动。端口被占只记日志，不影响其它口。
  - 请求：GET 查询串和 POST JSON 都收，参数合并规则「体里有就用体的」。桥全程 POST JSON。
  - `/tick` 阶段气泡：新做的小泡，从肩线往外飘、2~4 秒淡掉，同时最多 4 颗；跟正文气泡分开，
    正文是「她在说话」，这个是「进度」。`tickBubble` 开关在托盘/面板/`/tick {"on":false}` 三处都能拨。
  - `/reply` 回复钮 + 输入卡：跟随气泡（说完话亮起来，气泡走了再留 2.4 秒）或常驻；回车发、Esc 收、中文输入法选词时回车不算发送。
    **钮和卡不在剪影里**，所以给 `interact.js` 加了额外热区（`addHitTest`），否则鼠标压上去判穿透、点不着；
    卡开着时强制整窗吃鼠标（`setForceEat`）。
  - `/api/execute`：`stage/plan.js` 纯函数把 plan 翻成指令，只认 expression / motion / gesture；pose / trajectory
    跳过并如实写进 `skipped`。`gesture` 映射：hand_on_chest→HandRaise、point→FingerShow、grass→GrassOn。
  - 实测：tick 泡显示正确中文；plan → `脸红` + `FingerShow`；said → 回复钮亮；卡打开时 `ignored=false`；
    提交后冒「已送到她那儿」；桥日志 `delivered zone=- target=pet` → `echoed to pet (18 chars, moves=2)`，
    舞台气泡出现她的回话。`npm test` 71 + 33 + 61 + 41 + 20 全绿。
- 2026-11-11 · 七步接完。剩收尾：换装表情持久性没验、语音起点差 50~100ms、心情要不要改成自动推。
- 2026-11-11 20:0x · 补「给别人下载也要看得懂」的那批开关，顺手挖出一个大 bug：
  - **表情一直是假的**。这个 vendor 构建的 `model.expression()` 只设 currentExpression，每帧没人把 exp3 的参数写进
    coreModel，所以爱心眼不红、眯眼不眯、换装也穿不上；之前只看 `state().emotion` 这个字符串，没看画面。
    现在引擎自己解析 exp3、每帧最后一层按 Add/Multiply/Overwrite 叠上去，淡入 0.15s、末尾 0.2s 淡出。
    验法：`emotion 爱心眼` 后读 `key4` 从 0 涨到 1，截图眼睛变色。
  - **复原服装**（`engine.resetOutfit()`、`/outfit/reset`、菜单项）：`Clothes1..8` 摁回默认档 + 清表情；
    构造时就登记 `Clothes1..8`，不依赖某个换装表情先被点过。
  - 菜单补：点触叫醒 DSH 会话、智能穿透（`interact.setSmart`，关掉=整窗吃鼠标）、
    窥屏（开关/四档性子/立刻瞄一眼）、主动开口浓度（安静~不拦着 / 现在让她说一句）。
    桥那几项是**弹菜单前现问一次桥**的（`/health` + `/mood`），桥没跑就灰掉并写「桥没在跑，得装 dsh-pet-bridge」；
    开关全部转发给桥，舞台不留副本。面板补了智能穿透、点触桥两个勾。
- 2026-11-11 20:2x · 主人说「听不到语音了」，查出是静音 bug，顺手把 TTS 保活补上：
  - **根因**：`stage.js` 写 `volume: Number(qs.get('volume'))`。URL 没这个参数时 `qs.get` 是 null，
    `Number(null)` 是 0 → 页面一开局音量 0，全静音；口型照张、气泡照冒，所以看着像「放了但没声」。
    之前加音量时只验了「拖着滑杆能改」，没验「重启后还有没有声」。
  - 三处都补：`stageUrl()` 把音量写进 URL；页面 `volRaw === null` 交默认值；`voice.js` 非数一律 0.6（传 0 才是真静音）。
    另加 `voice.gain` / `voice.ctxState` 两个读数，以后查「没声音」先看这两个，别拿 `volume` 当证据。
  - **TTS 保活**（`stage/keepalive.js`）：每 5 分钟探 `/health`；不通就跑 `gateway/start.ps1`，起来后用一句「嗯」
    把模型顶进显存（wav 立刻删）；自己说过话就不重复热身。拉起脚本顶不住就走第二条路——让 TTS 桥自己起服务。
  - **坑**：`spawn(..., {detached:true, stdio:'pipe'})` 在 Windows 上拿不到任何输出、子进程 exit 0 空串，
    看着像「脚本什么都没干」。别 detached，保持管道，stderr 尾巴留在 `/keepalive` 的 `startLog`。
  - 入口三处：面板「语音」节（开关 + 间隔 + 说人话的状态）、菜单「语音服务」、`cli keepalive [now|warm|on|off|分钟]`。
  - 实测：停服务后 `keepalive?now=1` → 拉起 3 秒通、热身 19.7 秒；已热再热身 5.4 秒；一句话从请求到出声 7.5 秒；
    `npm test` 71 + 33 + 61 + 41 + 20 + 13 全绿。
- 2026-11-11 · 下一步：等主人挑还缺什么（气泡位置、换装持久性复验、语音起点差）。
