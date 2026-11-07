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
- **分区互动**：点是哪就反应哪（头发 / 脑袋 / 脖子 / 胸口 / 腰 / 裙摆 / 腿 / 脚），分区只带情绪、台词一律是语气词（呃…／呜…／嘿嘿…／呀…）；同一处连点三下会翻脸
- **点触事件反推**：每次点击都落盘 `data/touch.jsonl`，并可选 POST 给外部桥（`bridgeUrl`），用来唤醒别的进程
- **亲密度记忆**：点触会聚合进 `data/touch-stats.json`（累计几下、今天几下、最常摸哪、连着几天），反应跟着变——累计越多越耐摸（同部位连击阈值从三下抬到四下、五下），隔六小时以上没摸第一下会一惊一乍，当天已经被摸十五下以上第一下会黏人。不联网、不依赖 TTS，删掉文件就当清零
- **情绪端口**：`POST 127.0.0.1:61943/mood {"emotion":"shy","intensity":0.8}`，12 种情绪映射成鲸语 plan
- **气泡**：`POST /say {"text":"…"}` 出对话气泡，可选接自己的 TTS
- **阶段气泡**：`POST /tick {"text":"看 main.js","ms":3000}` 在她上半身随机位置冒一颗圆泡（头边 / 肩 / 胸口 / 手臂都可能），边往上飘边左右晃、边淡，单颗 2~4 秒、最多同时 5 颗；新泡会自动避开正在飘的旧泡，正脸也让开（联动用它说「在想 / 跑命令 / 看文件」，面板里能关）
- **气泡回复**：她说完话，气泡角上挂一个小蓝钮；鼠标靠近气泡就先不淡，点开就能在桌宠窗口里直接打字，回车把这句话投给桌宠专用会话（要先填 `bridgeUrl`），她的回话再以气泡回流
- **CLI**：`cli/pet.mjs` 把上面这些都包成命令行

可选集成（默认关闭）：DSH 会话联动 `integ/dsh-watch.mjs`，把会话状态（读文件/写文件/跑命令/子代理/卡住/报错）演成**表情 + 上半身的上浮小气泡**，不再推她的头。

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
npm install                      # 装 Electron（约 250MB，版本已锁 45.2.1：作者只在这一版上验过透明窗口和音频）

# 给鲸语打舞台补丁（仓库外的那份鲸语）
node patch/apply-jingyu.mjs --repo "D:/path/to/jingyu-live2d-agent"
node patch/apply-jingyu.mjs --repo "D:/path/to/jingyu-live2d-agent" --check

# 装完先自检一遍，出问题把这段输出贴给作者（没有隐私，只有版本 / 缩放 / 路径 / 日志尾巴）
npm run doctor        # 显示器与缩放、Electron 版本、补丁状态、端口、TTS、最近几次说话的时序
npm test              # 口型帧表 + 拖动数学的自检（71 条）
```

> **别人的机器上出问题，十有八九不是代码逻辑，而是机器差异**：缩放比例、显示器数量、Electron 版本、鲸语有没有打补丁、端口被占。`npm run doctor` 就是为这个准备的。

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
| `voiceKeepAlive` | 每 15 分钟打一次声（默认开）：顺手把 TTS 服务热着，最近没人理她就真说一句短招呼 |
| `bridgeUrl` | 可选：点触事件 POST 到哪里（反向桥，例如 `http://127.0.0.1:61944/event`） |
| `stageFps` | 舞台帧率上限，默认 60（`0` = 不限）。高刷屏不锁帧会按显示器刷新率满跑，CPU 翻三倍 |
| `dock` | 启动时贴到哪：`none`（默认，记住上次位置）/ `left` / `right` |
| `dockTitle` | 要贴的那个窗口，填它标题里的一段（比如浏览器标签页标题里的项目名）；**留空 = 不贴**，默认就是空 |
| `dockGap` | 和目标窗口之间留多少像素，默认 8 |

配置存在 `data/config.json`，日志在 `data/pet.log`。

### 语音：仓库里一个音频文件都没有

台词**只有文字**，声音全靠使用者自己的 TTS（`voicePrepare` 接一个把文本合成 wav 的脚本，`voiceWavDir` 是它输出的目录）。本仓库不附带、也不上传任何语音成品：合成出来的 wav、预合成缓存 `data/voice-cache.json`、以及任何克隆音色的样本都不在版本库里，`data/` 与 `*.wav / *.mp3 / audio/` 都在 `.gitignore` 里。

想让她出声就自己准备音色——用你自己的 TTS 或自己克隆的声音，别把成品公开发布。

**TTS 完全可选**：不填 `voicePrepare` / `voiceWavDir` 就是个哑巴桌宠——气泡、口型、点触、回复钮全都照常，只是不出声。`/say {voice:true}` 会直接当普通气泡处理并回 `{ok:true, queued:false, noTts:true}`，不会排三个点、也不会报错；预合成、保活、音量菜单这些跟声音有关的东西一律自动跳过。

**TTS 保活**（`voiceKeepAlive`，默认开）：本地 TTS 服务空闲久了第一句要 20~27 秒合成，中间气泡只能停在三个点。所以每 15 分钟打一次声——最近 15 分钟有人在动，就安静地合成一句随即扔掉的短句把服务热着（不出声、不进缓存、产物删掉）；真闲下来了才说一句短招呼（气泡 / 口型 / 声音同帧），两声招呼之间至少隔 45 分钟，只在 8~24 点之间开这个口。启动 90 秒后也会先热一次，省得开工第一句干等。手动触发：`POST :61943/keepalive {"mode":"greet"|"ping"}`。

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
POST /tick    {text, ms?}       阶段气泡（圆泡、上半身随机、往上飘带左右晃、2~4 秒消失）   GET /tick 看当前那条
POST /reply   {text} | {open}   在主人在桌宠里打的那句话投给桌宠专用会话；{open:true/false} 开关输入卡（调试用）
GET  /reply                     回复钮状态：开着没、输入卡开着没、当前文字
POST /sway    {on, phys, tilt, period}   GET /sway
POST /touch   {zone, nx?, ny?}   模拟一次点触（zone: hair/head/neck/chest/waist/skirt/leg/foot/body），可带 {"reset":true} 清零亲密度
GET  /touches?limit=20           最近的点触记录
GET  /affinity                   亲密度：等级、累计、今天几下、连续天数、最常摸哪、距上次多久
GET  /fps  POST /fps {fps}       舞台帧率上限（0 = 不限），改完自动重载舞台
```

情绪：`happy shy excited thinking sleepy proud sad annoyed surprised greeting playful neutral`

## CLI

```powershell
node cli/pet.mjs state
node cli/pet.mjs say "主人回来啦" --emotion happy
node cli/pet.mjs reply "在吗，我看到气泡了"   # 替主人回她一句（走桌宠专用会话）
node cli/pet.mjs expr 脸红 --and look=down
node cli/pet.mjs gesture hand_on_chest
node cli/pet.mjs sway --phys 0.2 --tilt 0.6 --period 4.0
node cli/pet.mjs touch head
node cli/pet.mjs touches 20
node cli/pet.mjs fps 30            # 舞台帧率上限（0 = 不限）
```

端口会读 `data/config.json`，也可用 `WHALE_PET_STAGE_PORT` / `WHALE_PET_MOOD_PORT` 覆盖。

## 可选：情绪层（她会记仇，也会自己消气）

默认关。`dsh-pet-bridge` 配置里 `mood: true` 打开，桌宠那条会话就开始有情绪了：被冷落会攒委屈，冷落久了会真的生气，你一句话又能把账清了。

不是一个心情变量加个强度——那样最多让嘴角变一下。做的是三样东西：

- **一本账**：谁、因为什么、什么时候记了一笔。`因为好久没人理`、`因为看见他在玩` 都不是硬编码的台词，是规则命中的结果
- **会自己走**：每种情绪有自己的半衰期。开心两小时，委屈六小时，感动十二小时，亲近十天。没人碰也会消
- **影响行为**：不只是语气。冷战时她真的可能不理你

生气有前因，不是随机抽风：委屈得先攒过线，隔了一夜还没人理才会转成气。看见你在打游戏不会动这本账——那是「此刻」层的事，见下一段。

```bash
node cli/pet.mjs mood          # 她现在什么心情、因为什么
node cli/pet.mjs mood reset    # 一键哄好
curl 127.0.0.1:61944/mood      # 同上，JSON
```

投递时会拼一段情绪卡给模型，平静时是空串不占 token：

```text
（你现在是真的在生气，因为看见他在玩、好久没人理。只回极短的一句，不主动示好，被追问也冷着，别解释为什么生气。）
```

**扩展性是这一层的设计目标**：`lib/mood/` 里 `profile.js` 是纯数据，`engine.js` 是纯函数且不认识任何具体情绪名。想加「吃醋」，往 profile 里加一条情绪加一条规则就行，零行逻辑代码。加一个新信号源，写个适配器就够，核心一行不用改。细节和扩展示例在 **[docs/mood.md](docs/mood.md)**。

#### 窥屏只留「此刻」，不改这本账

看见你在打游戏、在写代码、凌晨还没睡——这些是观察，不是关系。所以它们不进账本，只留一条带 TTL 的余温，十分钟到半小时自己消失。

一句话：**观察改此刻，互动改关系。**

账本只由你对她做的事驱动：摸、说话、长时间不理。窥屏再多也推不动档位，不会因为你玩了半天游戏就进入冷战。

余温只影响下一句话的味道。账本平静的时候情绪卡本来是空串，有余温时会多一句：

```text
（刚才瞄到一眼，Visual Studio Code，这会儿有点心疼。语气软一点，愿意多说两句。）
```

托盘标签把它挂在最前面，`node cli/pet.mjs mood` 单独打一行还带剩余时间。你只要开口说一句话，余温当场清空。

### 再进一步：让她自己开口

光有情绪还是被动的——生气要等你碰她一下才发作，桌宠看着还是死的。`moodUrge: true` 打开第二层：**情绪够了她自己把话送到桌面上**。

- **说的是一阵，不是一句**。真生气会连着怼三句、越说越硬、最后不说话了；真开心会连发两条然后自己去干活。所以每档配一串按时间排好的话，两阵之间才隔一阵
- **你一回应就散场**。被摸一下或者回一句话，这一阵剩下的几句立刻不补
- 六档开口理由，顺序即优先级：不痛快轻戳两句 → 说满两句没人理就硬起来、最后一句带哭腔 → 冷战期冷冷丢两句 → 吃醋、担心、心情好主动分享
- **浓度是个旋钮**：`quiet` / `normal` / `clingy` / `chatty`，管的是「一天说多少句」。主打陪伴设成 `clingy` 就够，不用逐档改参数
- **情绪在浓度之上再加一次权**：越气越密，越开心越急。两阵之间和阵内两句之间都跟着缩
- 三个全局闸门兜底：静默时段只记账不开口、两阵之间至少 25 分钟、全天句数上限
- 跟窥屏走**同一条投递管道**，但两条互不认识，能各自单独关掉
- 加一档新的主动理由，还是只改 profile，零行逻辑代码

```bash
node cli/pet.mjs mood urge                # 立刻问一句想不想开口（跟定时那条完全同一套判断）
node cli/pet.mjs mood intensity clingy    # 换浓度，立刻生效，跨重启记得
```

它真会打断你正在干的事，所以插件里默认关，要不要开是你的事。**细节在 [docs/mood.md](docs/mood.md#自己开口urge)**。

闸门（冷战期真的不回）默认关着，`moodGates: true` 才生效——参数得先实跑几天调顺，不然一上线就是天天冷战。

## 可选：DSH 会话联动

`integ/dsh-watch.mjs` 读 DSH 会话事件流，把「读文件 / 写文件 / 跑命令 / 网页 / 子代理 / 卡住 / 报错 / 答完」演出来。默认关闭，在设置面板勾上并填会话目录即可。

分工是：**表情走舞台**（`/api/execute`，只发 `expression`，不动头不动身体），**过程提示走气泡**（`POST /tick`，上半身随机冒圆泡往上飘、边晃边淡，单颗 2~4 秒、最多同时 5 颗，面板里能关）。气泡文案是随机说法池，同一个状态换着说：让我想想 / emmm... / 让我看看 main.js / 跑一下 node --check / 查查 xxx / 啧，翻车。两条线互不干扰——身体留给指针追踪、待机摇摆和说话手势。

## 可选：桌宠会话预设

反向桥要投一条**只有人设、零工具**的独立会话，它才会说人话而不是去开工具。那套预设长什么样——人设之外必须补的「怎么动」提示词、方括号指令白名单、`parseCues` 的拆解规则、从点触到气泡的整条回流链路——都整理在 **[docs/pet-session-prompt.md](docs/pet-session-prompt.md)**。

提示词正文已剥离角色设定，方括号里的表情名是示例，换你自己的模型照那份文档改 `cues.js` 的白名单即可。

**但「零工具」不是挂个只有 persona 的 preset 就到手的。** DSH 的工具注册表在宿主平面：插件一注册，工具就对所有 agent 可见，preset 只能选呈现方式（native / ptc），选不了内容。所以那条会话默认会继承整套干活工具——实测 41 个、schema 合计 37934 字符，约等于九千多 token，每轮都付，而她只要说十个字。要真的收窄，得在同一个 preset 里再挂 [`bridge/dsh-pet-trim`](bridge/dsh-pet-trim)，它调一次 `ctx.tools.restrict({ allow })` 把目录砍到只剩需要的几个。留什么由你自己定，默认只留记忆召回；没装记忆插件的部署会自动退化成「全部拒绝」，不会因为名字对不上而崩。

同一个插件顺手把系统提示段也过滤了：只剩 `harness:identity` 和人设的前后缀三段，gate 说明、搜索引擎名单、present 规矩、harness 源码路径、Web 表层那约八千字符全丢。每轮追加的运行时快照走 `dsh-persona` 自带的 `includeRuntimeContext: false`，热记忆和沙箱策略一起压掉，时间则由插件补一行 `现在是 …`，她还是知道现在几点。三块一起收，固定开销从约 54k 字符降到 5k 出头，写法和代价在 [docs/pet-session-prompt.md](docs/pet-session-prompt.md)。

## 可选：反向桥（把她变成输入设备）

她不只是被指挥，也可以反过来叫醒别的进程。填了 `bridgeUrl` 之后，每一次点触都会 POST 到那个地址：

```json
{"ts":"2026-11-01T07:15:04.608Z","seq":4,"zone":"head","nx":0.501,"ny":0.2}
```

这条线可以单独关掉：`config.bridge`（托盘「互动 ▸ 模型桥接」/ `node cli/pet.mjs bridge off` / `POST :61943/bridge {"on":false}`）。关掉后表情、台词、`touch.jsonl` 全都照旧，只是不再叫醒会话——适合想自己逗她玩、又不想每摸一下都烧一次模型的时候。它和 `interactive` 是两层开关：`interactive` 关了是连本地反应都没有。

同一份数据也会追加进 `data/touch.jsonl`（超过 256KB 自动轮转成 `touch.jsonl.1`），随时可以 `GET /touches` 或 `node cli/pet.mjs touches` 回看主人都点了哪儿。

DSH 这边的接法是 `bridge/dsh-pet-bridge/` 这个插件：收到事件后按 `sessionController.resolveAgent → agent.followup → sessions.flush` 投一条 user 消息，于是「摸头」真的会触发一次模型调用。它带同部位 2.5 秒合并、每分钟 8 条上限，避免连点刷屏。

**默认投专用会话，不碰主会话**（`mode: pet`）：第一次点触时它会 `sessionController.create()` 建一个固定会话（自动改名「桌宠互动」，用 `agentPreset` 指定的预设 —— **默认留空，不替你挑性格**，用的是进程自己的默认预设；想让桌宠有独立人设就填你自己预设的名字，通常配成只有人设、没有工具的那只，免得桌宠那股劲儿跟你写代码那股劲儿混在一起），之后所有点触都投那儿。这样正在写代码的主会话不会被「刚刚有人碰了你的胸口」插进等候区。会话 id 落在 `$DSH_HOME/pet-bridge.json`，重启沿用；`POST :61944/reset-pet-session` 换一个干净的；把 `mode` 改成 `main` 就退回旧行为（投最近活跃会话）。另一个相关的键是 `address`：她怎么称呼你，留空则注入的提示词里不带任何称谓，填了也只影响那几句前缀，不改任何人设文件。预设名没在这个进程里注册时，`/health` 的 `petPreset` 会和 `petPresetWanted` 对不上，日志里也会留一行警告。

**回复回流成气泡**（`echoToPet`，默认开）：那个会话里我一旦说话，桥就等到这一轮结束，把最后一段文本洗掉 markdown / 贴纸 / 代码块、截到 `echoMaxChars`，再 `POST` 回 `:61943/say`——于是桌面真的会出现气泡 + 口型，而不是只躺在聊天窗口里。一轮多条只出最后一条；被打断的残句不播。

**语音**（`echoVoice`，默认关）：打开后只念 `echoVoiceMaxChars`（默认 40）以内的短回复。合成期间气泡停在三个点，合成好之后正文、口型、声音同帧一起出；`early: true` 只让表情和手势提前摆好，正文不会提前漏。改配置要重启 DSH。

**顺带控制表情和手势**：投给桌宠会话的消息后面会附一句口径（一句、**5~20 字**、越短越好、别排版），并允许模型在最前面写 `[emotion:shy]` / `[gesture:hand_on_chest]`，桥把这俩摘出来交给 `/say`，标记不进气泡；认不出的名字直接忽略、正文照留。

**反过来，在桌宠里回她一句**（`config.replyBtn`，默认开）：她说完话，气泡右上角挂一个小蓝钮（只有说话气泡挂，过程小气泡不挂）。鼠标靠近气泡时气泡先不淡——不然 5 秒的回复根本来不及点；点开在桌宠窗口里弹一张输入卡，回车就发。壳子把这句 `POST` 到桥的 `/say`（由 `bridgeUrl` 换 pathname 得来），桥照常投进桌宠专用会话、她的回话再照常回流成气泡，所以你打一句、她答一句，全程不离开桌面。

- 输入卡用 `Esc` 取消，点别处（窗口失焦）也会收掉；发送失败（DSH 没开、端口不通）时卡片不关，原因写在下面一行，文字留在框里。
- 打字期间窗口不穿透；关掉卡片、鼠标离开就恢复。那颗钮是整窗唯一吃鼠标的 DOM（标了 `data-pet-ui`），气泡正文和其它位置照旧穿透，不影响在上面摸她。
- 入口：托盘「说话 ▸ 气泡回复钮」、`config.replyBtn`；`node cli/pet.mjs reply "在吗"` 和 `POST :61943/reply {"text":"…"}` 是同一件事，方便脚本里用。

**她也会自己瞄一眼屏幕**（`peek`，默认关）：桥隔 30 分钟（±20% 抖动）抓一张**前台窗口**的截图，跑 Windows 自带的 `Windows.Media.Ocr` 本地识别，再拼成一条「你刚瞄了眼主人屏幕」的事件投给桌宠会话——于是她会主动开口，而不是等你摸。回话照旧走 `echoToPet` 出气泡 + 语音。

- 为什么是本地 OCR 而不是视觉模型：桌宠预设不给工具（`dsh-pet-trim` 把目录砍到只剩说话用得上的那几个），她调不到 `read_image`；每半小时一张图给模型是稳定的视觉 token 开销，截图还会进会话记录；系统 OCR 是全离线、零依赖、不花钱，认不出就降级成「进程名 + 窗口标题」，永远不报错。
- **全屏的时候她也能知道你在打什么**：全屏下截图是一片黑，所以另有一条轻探针，只读前台窗口的进程名、标题和是否全屏，不截图不认字，45 秒一次、一次约 1 秒。退出全屏要连续两次看不到全屏才算数（切窗口会闪），打够五分钟才上报，然后留一条「有点空、你打了 N 分钟游戏」的此刻。它跟窥屏共用一个开关。
- **想认得更准**：装 [RapidOCR](https://github.com/RapidAI/RapidOCR)（PP-OCR 的 onnx 版，纯 CPU、离线、模型三十来兆），把 `peekOcrPython` 指到那个 venv 的 `python.exe` 就行，探针会用包里的 `scripts/ocr.py` 先跑它，失败再回落系统 OCR。冷启动约 5 秒，`peekTimeoutMs` 记得放宽到 20 秒。

  ```powershell
  python -m venv <venv目录>
  <venv目录>\Scripts\python.exe -m pip install rapidocr onnxruntime -i https://pypi.tuna.tsinghua.edu.cn/simple
  # 然后在桥插件的 config 里写：peekOcrPython: '<venv目录>\Scripts\python.exe'
  ```
- **瞄哪一个窗口**：优先 `peekTarget`（进程名或标题片段，钉死就只瞄它）；没设就顺着**任务栏顺序**挑最靠前的那个独立窗口——判定条件是可见、不是工具窗、没有 owner、有标题、至少 320×240，所以桌宠那层透明壳、AIDA64 的 OSD 小条、桌面窗口都会被跳过。手动「现在瞄一眼试试」时前台会被托盘菜单抢成桌宠窗口，探针会按同一套规则重新挑一个，不会拍到她自己。
- 只截前台那一块，不截整屏；探针和截图落在 `$DSH_HOME/tmp/pet-peek`，读完即删。
- 跳过：静默时段（默认 1~8 点）、主人在 DSH 里说话、桌宠自己在前台、全屏（游戏/看片）、画面指纹跟上次一样。全屏独占抓出来是黑的时候只报标题，不硬猜。
- 开关：托盘「说话 ▸ 窥屏」和「现在瞄一眼试试」、`node cli/pet.mjs peek on|off|now`、`GET/POST :61944/peek`（`{"on":true}` 开关，`{"now":true}` 立刻跑一轮）；状态存 `$DSH_HOME/pet-bridge.json`，重启记得。
- **她盯得多紧是个档位，不是分钟数**。托盘「说话 ▸ 她盯得多紧」四档：黏人、温和、冷淡、病娇。每档给的是一个区间，每次排期从里面抽一个值，同样档位每次都不一样——会被人算准的东西不像活的。病娇是平时不管你、一看到你在做什么就缩到一两分钟。`node cli/pet.mjs peek persona yandere`、`POST :61944/peek {"persona":"yandere"}` 是同一件事，热改，跨重启记得。老配置里存的分钟数会自动反推成最接近的一档。
- 这个基准还会被**情绪**再乘一次：冷战期 ×3、不痛快时 ×0.5，所以同一档设置下，生气的她盯得更勤。菜单标题里会标出「情绪缩到 N 分」，看得到实际值。

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

## 分支约定

`main` 只放**明确封版**的代码，别人 clone 或拉下来能直接用；开发中的改动一律提交到 `dev`。

- 日常开发：在 `dev` 上提交、推送，`main` 不动
- 封版：`dev` 已验证稳定 → 合并进 `main` → 打 tag，比如 `git tag v0.3.0 && git push origin v0.3.0` → 同一个提交里把 `CHANGELOG.md` 和 `package.json` 的版本号一起升上去
- 回滚/热修：从 `main` 切 `hotfix/*`，修完同时回并 `main` 和 `dev`

## 已知限制

- 只适配 **鲸语 1.4.0-beta.2** 的 `web/app.mjs` / `web/engine.mjs` 结构
- 只在 **Windows**（双 2560×1440、缩放 100%）实测过；透明窗口用 `WS_EX_LAYERED`，全屏独占游戏会盖住她
- 跨屏拖动 / 高 DPI（125% / 150% / 混合缩放）的逻辑有单测钉着（`npm test`），但**没有在真机上验过**：那台机器上如果有问题，请把 `npm run doctor` 的输出和 `data/pet.log` 里 `drag-` 开头的行发过来
- 侧身弯腰受模型参数限制：能改 `AngleX / AngleZ / PositionX`，真正折腰要看模型有没有可写的髋/腰参数
- 不随仓库分发模型与 Cubism Core，见 `THIRD-PARTY.txt`

## 已知问题

### 「作者机器上好好的，我这儿一拖就闪 / 口型不同步」（2026-11-07 已修）

反馈来源：B 站评论区 + 下载后自己部署的人。本地双 2560×1440 @100% 一次都复现不出来，查下来是三处「只在别人的机器上才成立」的前提。**三处都已改掉**，下面是原因，方便再遇到时对号入座。

#### 1. Alt 拖动时窗口闪 / 越拖越大

三条原因叠在一起，缺一条都不至于这么明显：

- **尺寸没人管**。旧代码每帧只 `setPosition` 不带宽高。窗口一跨到缩放不同的屏，Windows 按新 DPI 重算一遍尺寸（DIP 不变 = 物理像素变大），下一帧只挪位置不管尺寸，尺寸就被系统留着；来回拖就来回变。现在冻结的是**物理像素尺寸**，每帧都带宽高，跨屏按新缩放比换算回 DIP，屏幕上看起来一样大。
- **位置算错**。旧的是「按下时的绝对坐标 + 总位移」，跨屏时 DIP 坐标系换了基准会跳。现在只认「上一帧 → 这一帧」的增量，而且**不回读** `getBounds`：系统还没落实上一帧时读回来是旧值，基于旧值加增量会多走一截（实测拖 -300 走了 -367，还带竖着漂）。
- **拖动中还在做像素命中**。一直按住 Alt 拖时鼠标在窗口里挪，旧代码每次都 `readPixels` 算「是不是压在角色身上」，随手一算就可能判成离开 → 窗口切成穿透 → 拖动断掉，窗口在可点/穿透之间来回切，屏幕跟着闪。现在拖动期间不碰穿透和光标，命中测试也做了缓存（同一帧不重复读、同一小格 120ms 内复用）。
- 另外两处配套：关掉 Chromium 的「原生遮挡计算」（透明置顶窗会被判成被别人挡住 → 暂停渲染 → 一拖就闪、偶尔卡一拍）；拖动中忽略 `resized` 事件，不再把系统改过的尺寸写进 `config.json` 变成永久变大。

#### 2. 首启窗口比屏幕还高

默认 `531×950`（DIP）。1080p 笔记本常见 125% / 150% 缩放，工作区只有 ~680 DIP 高，窗口一开就超出屏幕，系统就会按 DPI 改尺寸，接着拖就闪。现在开窗前按当前显示器工作区夹一遍（96%），尺寸滑杆也夹住，屏幕外的旧坐标也收回来。

#### 3. 说话时口型不同步

- **顺序反了**。旧链路是「先把 `<audio>` 放出去 → 再等 `runPlan` 排队把口型计划挂上舞台」。舞台一忙（摇摆每 600ms 抢一次、联动 watcher 也抢），声音先跑几百毫秒到两秒，口型在后面追。现在：先在页面里解码（`__petLoadAudio`）→ 再把口型计划挂上舞台 → 最后按「计划真被舞台收下的时刻 + 0.15s」用 AudioContext 的采样级时钟排程播放，排在哪一秒就从哪一秒响。
- **时长信错了**。以前用 TTS 自报的 `duration`，它可能带 padding / 按字数估，和真播出来的差 0.1~0.5s，嘴不是提前闭就是说完还在动。现在时长直接数 wav 头里的帧。
- **帧表越界**。舞台有硬约束：关键帧 `time` 必须落在 `0.15..duration-0.15`。有一次把帧排到 `duration-0.2`，说话计划被舞台连拒 8 次，整句就没口型。约束现在写在 `src/mouth.js`，`npm test` 钉着。
- 顺带：`--autoplay-policy=no-user-gesture-required`。她会自己开口（保活、主动说话），那一刻窗口没有用户手势，自动播放策略会把声音拦成静音。

#### 还是不对的话，给我这两样

1. `npm run doctor` 的整段输出（只有版本、缩放、路径、端口、日志尾巴，没有账号信息）
2. `data/pet.log` 里 `drag-` 开头的行，和每次说话那一行：

   ```
   realtime say synth=6263ms dur=2.40s mouth=19 decode-ok play-ok(running) plan=ok behind=0.081s lead=0.069s <jobid>
   ```

   - `decode-ok` / `play-ok(running)`：解码和播放都成了。出现 `play-suspended` 说明自动播放被挡，`play-http-404` 是舞台取不到 wav（`web/audio` 目录不可写或者端口不对）
   - `plan=ok`：口型计划被舞台收下了。`plan=fail :: 后面那句` 是舞台给的理由，`已有动作正在执行` 表示有别的东西在抢舞台
   - `behind` 是「计划被收下 → 开始排声音」的间隔，`lead` 是补的提前量；正常 `behind` 应该 < 0.15s

### Alt + 拖动时窗口变大、还在闪（旧记录，保留对照）

2026-11-03 B 站评论区反馈的同一件事，当时记成「本地没复现」。2026-11-07 找到上面三处原因并修掉，这条留作对照：

- 拖动本身不改尺寸。`pet:drag-start` 之后只是每帧一次 `setBounds`，从不动 `setSize`，也没有任何缩放动作。
- 当时猜的两条线（多显示器缩放不一致、贴边吸附）里，**第一条是真的**；第二条没证实，现在拖动中也不做任何吸附。

## 许可

本仓库代码 MIT。第三方组件与素材的版权归各自作者，详见 `THIRD-PARTY.txt`。
