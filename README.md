# whale-pet-shell

把 **鲸语（Jingyu Live2D Agent）** 的 `?stage=1` 舞台变成 Windows 桌面上的透明桌宠外壳。

壳子本身只做「窗口 + 交互 + 玩法」，不做渲染、不带模型：模型、鲸语、Live2D Cubism Core 全部由使用者自备。

```
鲸语舞台（本机 HTTP）  ←  壳子（Electron 透明窗口 / 托盘 / 面板 / 玩法层）
      ↑ 动作执行                    ↓ 情绪、气泡、指针、尺寸
   /api/execute              127.0.0.1:61943
```

## 预览

设置面板（托盘 → 设置…，或 `node cli/pet.mjs panel`）。第一次运行时如果依赖没配好，外壳会直接把这个面板弹出来。

<img src="docs/preview-settings.png" width="396" alt="设置面板：尺寸滑杆、鲸语/模型/Python 路径、互动开关、舞台帧率、可选集成">

> 截图里只有外壳自己的界面。角色和模型不在本仓库内，也不提供。

## 它提供什么

- **透明无边框窗口**：置顶、点透明处穿透到下层窗口、点角色身上可交互，按住 `Alt + 左键` 拖动
- **像素级智能穿透**：只认角色像素，靠 `preserveDrawingBuffer` + 命中框实现（需要补丁，见下）
- **托盘菜单**：显示/隐藏、置顶、穿透、近景/全身、尺寸、气泡位置、开机自启、设置
- **尺寸面板**：滑杆实时预览，比例锁定；也可 `Ctrl + 滚轮` 在角色身上调
- **帧率可调**：设置面板「性能」里 30 / 60 / 90 / 自定义（0 = 不限）。高刷屏不锁帧会按刷新率满跑，实测 CPU 差三倍
- **指针追踪**：全局鼠标位置持续喂给模型（着头/上身/前探/侧移），窗口穿透或指针在窗口外也有效
- **绕圈生气**：围着她的头部转满一圈 → 眩晕 → 嫌弃 → 黑脸 + 手放胸前，进冷却
- **分区互动**：点是哪就反应哪（头发 / 脑袋 / 脖子 / 胸口 / 腰 / 裙摆 / 腿 / 脚），台词与情绪分池；同一处连点三下会翻脸
- **点触事件反推**：每次点击都落盘 `data/touch.jsonl`，并可选 POST 给外部桥（`bridgeUrl`），用来唤醒别的进程
- **情绪端口**：`POST 127.0.0.1:61943/mood {"emotion":"shy","intensity":0.8}`，12 种情绪映射成鲸语 plan
- **气泡**：`POST /say {"text":"…"}` 出对话气泡，可选接自己的 TTS
- **CLI**：`cli/pet.mjs` 把上面这些都包成命令行

可选集成（默认关闭）：DSH 会话联动 `integ/dsh-watch.mjs`，把会话状态（读文件/写文件/跑命令/子代理）演成动作。

## 前置条件（不提供，需自行获取）

| 依赖 | 说明 |
|---|---|
| **鲸语 Jingyu Live2D Agent** | 舞台和动作编译器。本外壳适配 `1.4.0-beta.2`，需要 `web/app.mjs`、`web/engine.mjs` |
| **Live2D 模型** | 你自己的 `.model3.json` + moc3 + 贴图 + 物理。**本仓库不含任何模型** |
| **Live2D Cubism Core** | 从官方 SDK 获取 `live2dcubismcore.min.js`，按 Live2D 许可放进鲸语的 `web/vendor/`。**本仓库不含** |
| **Node.js ≥ 20** | 跑 Electron 外壳和 CLI |
| **Python 3.10+** | 鲸语自己的依赖，按鲸语 README 装 |

## 安装

```powershell
git clone <this-repo> whale-pet-shell
cd whale-pet-shell
npm install                      # 装 Electron（约 250MB）

# 给鲸语打舞台补丁（仓库外的那份鲸语）
node patch/apply-jingyu.mjs --repo "D:/path/to/jingyu-live2d-agent"
node patch/apply-jingyu.mjs --repo "D:/path/to/jingyu-live2d-agent" --check
```

补丁只做五处最小插入，幂等、自动备份 `.whale-pet-bak`，可 `--revert` 还原：

1. `app.mjs`：`?stage=1` 舞台模式判定
2. `app.mjs`：`preserveDrawingBuffer`（像素级穿透要读 canvas alpha）
3. `app.mjs`：锁帧（默认 60fps，`?fps=0` 不限）—— 高刷屏不锁帧会跟着 144/165Hz 满跑，白烧 CPU
4. `app.mjs`：暴露 `window.__stageEngine / __stageModel`、订阅壳子送来的指针、定时写 `#scene[data-hit]` 命中框
5. `engine.mjs`：新增 `pointer` 驱动阶段（优先级 15），把指针映射到 `AngleX/AngleY/AngleZ/LeanInput/PositionX`

> 找不到锚点会直接报错、不写入。鲸语改版后锚点可能变，那时按报错手改，或对照本仓库 `patch/apply-jingyu.mjs` 里的插入内容。

## 配置

双击 `start-pet.cmd`（或 `npm start`）。**配置文件不完整时只弹设置面板**，填完保存会自动重启：

| 字段 | 含义 |
|---|---|
| `jingyuRepo` | 鲸语仓库目录（含 `server.py`） |
| `modelDir` | 模型目录（含 `*.model3.json`）；留空默认取 `<jingyuRepo>/model/DeepSeek` |
| `pythonPath` | Python 解释器；留空用 PATH 里的 `python` |
| `stagePort` / `moodPort` | 鲸语端口（默认 61942）/ 本外壳控制端口（默认 61943） |
| `dshWatch` + `dshSessionsDir` | 可选：DSH 会话联动 |
| `moodJson` | 可选：外部心情文件（有就同步情绪） |
| `voicePrepare` + `voiceWavDir` | 可选：外部 TTS 桥脚本与音频目录 |
| `bridgeUrl` | 可选：点触事件 POST 到哪里（反向桥，例如 `http://127.0.0.1:61944/event`） |
| `stageFps` | 舞台帧率上限，默认 60（`0` = 不限）。高刷屏不锁帧会按显示器刷新率满跑，CPU 翻三倍 |
| `dock` | 启动时贴到哪：`none`（默认，记住上次位置）/ `left` / `right` |
| `dockTitle` | 要贴的那个窗口，填它标题里的一段（比如浏览器标签页标题里的项目名）；**留空 = 不贴**，默认就是空 |
| `dockGap` | 和目标窗口之间留多少像素，默认 8 |

配置存在 `data/config.json`，日志在 `data/pet.log`。

## 控制接口（61943）

```
GET  /status                    情绪列表、音量、最近一次说话
POST /mood    {emotion, intensity}
POST /say     {text, emotion?, gesture?, voice?, early?}
POST /dock    {mode: "left"|"right"|"none", title?}   贴到窗口旁边（默认按标题找 DSH）
POST /size    {width, height}
POST /fit     {fit: "portrait"|"full"}
POST /cursor  {on?, spin?, reset?}
GET  /cursor                    窗口位置、鼠标、调戏区、绕圈阶段
GET  /bubble  POST /bubble      气泡文本与位置
POST /sway    {on, phys, tilt, period}   GET /sway
POST /touch   {zone, nx?, ny?}   模拟一次点触（zone: hair/head/neck/chest/waist/skirt/leg/foot/body）
GET  /touches?limit=20           最近的点触记录
GET  /fps  POST /fps {fps}       舞台帧率上限（0 = 不限），改完自动重载舞台
```

情绪：`happy shy excited thinking sleepy proud sad annoyed surprised greeting playful neutral`

## CLI

```powershell
node cli/pet.mjs state
node cli/pet.mjs say "主人回来啦" --emotion happy
node cli/pet.mjs expr 脸红 --and look=down
node cli/pet.mjs gesture hand_on_chest
node cli/pet.mjs sway --phys 0.2 --tilt 0.6 --period 4.0
node cli/pet.mjs touch head
node cli/pet.mjs touches 20
node cli/pet.mjs fps 30            # 舞台帧率上限（0 = 不限）
```

端口会读 `data/config.json`，也可用 `WHALE_PET_STAGE_PORT` / `WHALE_PET_MOOD_PORT` 覆盖。

## 可选：DSH 会话联动

`integ/dsh-watch.mjs` 读 DSH 会话事件流，把「读文件 / 写文件 / 跑命令 / 网页 / 子代理 / 卡住 / 报错 / 答完」演成动作。默认关闭，在设置面板勾上并填会话目录即可。

## 可选：反向桥（把她变成输入设备）

她不只是被指挥，也可以反过来叫醒别的进程。填了 `bridgeUrl` 之后，每一次点触都会 POST 到那个地址：

```json
{"ts":"2026-11-01T07:15:04.608Z","seq":4,"zone":"head","nx":0.501,"ny":0.2}
```

这条线可以单独关掉：`config.bridge`（托盘「互动 ▸ 模型桥接」/ 设置面板「互动」里的第二个勾选框 / `node cli/pet.mjs bridge off` / `POST :61943/bridge {"on":false}`）。关掉后表情、台词、`touch.jsonl` 全都照旧，只是不再叫醒会话——适合想自己逗她玩、又不想每摸一下都烧一次模型的时候。它和 `interactive` 是两层开关：`interactive` 关了是连本地反应都没有。

同一份数据也会追加进 `data/touch.jsonl`（超过 256KB 自动轮转成 `touch.jsonl.1`），随时可以 `GET /touches` 或 `node cli/pet.mjs touches` 回看主人都点了哪儿。

DSH 这边的接法是 `bridge/dsh-pet-bridge/` 这个插件：收到事件后按 `sessionController.resolveAgent → agent.followup → sessions.flush` 投一条 user 消息，于是「摸头」真的会触发一次模型调用。它带同部位 2.5 秒合并、每分钟 8 条上限，避免连点刷屏。

**默认投专用会话，不碰主会话**（`mode: pet`）：第一次点触时它会 `sessionController.create()` 建一个固定会话（自动改名「桌宠互动」，用 `bigfish` 预设，所以人设跟主会话一致），之后所有点触都投那儿。这样正在写代码的主会话不会被「主人刚刚碰了你的胸口」插进等候区。会话 id 落在 `$DSH_HOME/pet-bridge.json`，重启沿用；`POST :61944/reset-pet-session` 换一个干净的；把 `mode` 改成 `main` 就退回旧行为（投最近活跃会话）。

**回复回流成气泡**（`echoToPet`，默认开）：那个会话里我一旦说话，桥就等到这一轮结束，把最后一段文本洗掉 markdown / 贴纸 / 代码块、截到 `echoMaxChars`，再 `POST` 回 `:61943/say`——于是桌面真的会出现气泡 + 口型，而不是只躺在聊天窗口里。一轮多条只出最后一条；被打断的残句不播。

**语音**（`echoVoice`，默认关）：打开后只念 `echoVoiceMaxChars`（默认 40）以内的短回复。合成期间气泡停在三个点，合成好之后正文、口型、声音同帧一起出；`early: true` 只让表情和手势提前摆好，正文不会提前漏。改配置要重启 DSH。

**顺带控制表情和手势**：投给桌宠会话的消息后面会附一句口径（一句、20~40 字、别排版），并允许模型在最前面写 `[emotion:shy]` / `[gesture:hand_on_chest]`，桥把这俩摘出来交给 `/say`，标记不进气泡；认不出的名字直接忽略、正文照留。

安装（DSH 侧）：

```powershell
# 1. 插件必须放在 profile 的 node_modules 里：cordis 以 profile 目录为基准解析包名，放别处会静默跳过
Copy-Item -Recurse bridge/dsh-pet-bridge "$env:DSH_HOME/profiles/web/node_modules/dsh-pet-bridge"
# 2. 用 overlay 注册（别写进会被热重载的 cordis.patch.yml），启动时加 --patch
#    - insert:
#        - id: pet-bridge
#          name: dsh-pet-bridge
#          config: { port: 61944, mode: pet }
# 3. 重启 DSH，GET http://127.0.0.1:61944/health 应返回 mode / sessionId / petSessionId
```

自带冒烟测试（用假 ctx 跑真代码，不需要装 DSH）：`node bridge/dsh-pet-bridge/test/smoke.mjs`。

### 分区坐标怎么调

`zoneOf`（`src/preload.js`）里的比例是按这只模型（3749×7697 全身立绘）的透明轮廓量出来的。换模型后，最省事的做法是先 `node cdp.mjs shot` 截一张，再按「头发顶端 / 下巴 / 肩 / 胸 / 腰 / 裙摆 / 膝 / 脚踝」在图上量百分比，改那几行阈值即可。

⚠️ 里面的表情名（`眯眼`、`加载`、`圈圈眼`、`黑脸`、`hand_on_chest`…）按某个特定模型写死，换模型要在文件顶部的表情表里换成你自己模型 `Exp3/`、`Animation/` 里的名字，否则会被引擎拒收。

## 已知限制

- 只适配 **鲸语 1.4.0-beta.2** 的 `web/app.mjs` / `web/engine.mjs` 结构
- 只在 **Windows**（双 2560×1440、缩放 100%）实测过；透明窗口用 `WS_EX_LAYERED`，全屏独占游戏会盖住她
- 侧身弯腰受模型参数限制：能改 `AngleX / AngleZ / PositionX`，真正折腰要看模型有没有可写的髋/腰参数
- 不随仓库分发模型与 Cubism Core，见 `THIRD-PARTY.txt`

## 许可

本仓库代码 MIT。第三方组件与素材的版权归各自作者，详见 `THIRD-PARTY.txt`。
