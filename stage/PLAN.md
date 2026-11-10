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

### 第 4 步 · 情绪端口

- 做：61943 收心情 → 换算成表情/动作计划，带强度；节律摇摆
- 依赖：无外部，但`mood.ps1` 是现成的心情来源
- 验：`sendMood('shy', 0.8)` 她明显害羞；摇摆幅度不抢指针跟随

### 第 5 步 · 托盘与面板

- 做：托盘菜单（开关、退出）、右键菜单、设置面板（端口/路径）、尺寸滑杆
- 依赖：无
- 验：改一项开关立刻生效；关掉面板不丢配置

### 第 6 步 · DSH 桥

- 做：61942 接 DSH，阶段气泡、进度上报、回复钮
- 依赖：DSH 侧插件
- 验：会话里跑长任务，桌宠冒阶段气泡；点回复钮能发消息

### 第 7 步 · 正式替身

- 做：`package.json` 的入口指向 `stage/main.js`，现役那套降级成「回退方案」
- 验：一条命令起桌宠，全功能；把 `src/` 改名仍能跑

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
- 2026-11-10 · 下一步：第 3 步点触记录与反向桥。
