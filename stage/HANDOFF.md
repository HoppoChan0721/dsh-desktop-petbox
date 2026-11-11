# 交接文档 · 自建 Live2D 舞台

> 写给**下一个会话的我**。读完这一份就能接着干，不用翻聊天记录。
> 最后更新：2026-11-11 18:4x · 分支 `dev` · **桌宠入口已切到 `stage/main.js`**

---

## 0. 一句话

桌宠已经**正式换成我们自己的舞台** `F:\DaFeiYu\projects\whale-pet-shell\stage\`（`package.json` 的 `main` 指向它，老外壳还在，`npm run start:legacy` 能起来当回退）。接入进度 **7/7 全部接完**（2026-11-11 晚）：气泡、语音、指针手感、点触账本、心情端口、托盘/右键/面板、入口切换、DSH 桥（阶段气泡 + 回复钮 + plan 执行）。

## 1. 立刻要做的第一件事

**没有未接的步了。** 剩下的是收尾和打磨：换装表情的持久性没验过、气泡和音频起点差 50~100ms、心情目前是「拉」的（`cli.mjs mood` 才同步一次）。

要动 DSH 桥那头时记住：桥（`.dsh-pet-bridge`，61944）里写死 `petSayUrl=61943/say`、`petStageUrl=61942`，舞台现在**同时监听 61945 / 61942 / 61943**，所以桥不用改配置。

## 2. 先确认舞台在不在跑

```powershell
# 在跑就该回一段 JSON，带 frames / motion / gaze
curl http://127.0.0.1:61945/state
```

正常启动就是仓库根目录跑 `electron .`（入口已经是 stage/main.js）；开机自启走 `tools\pet-autostart.ps1`，它健康检查的端口也是 61945：

```powershell
cd F:\DaFeiYu\projects\whale-pet-shell
Start-Process -FilePath 'node_modules\electron\dist\electron.exe' `
  -ArgumentList '.','--cdp=9340' `
  -WorkingDirectory 'F:\DaFeiYu\projects\whale-pet-shell'
```

**要调试口才加 `--cdp=9340`**；自启脚本给的是 Chromium 原生的 `--remote-debugging-port=9333`，两个都能用。加单实例锁了：重复启动只会把已有那只叫到前面来。

重启后要**关掉旧进程**，否则控制口占着：

```powershell
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*stage\main.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

**注意**：现役桌宠跑的是 `src\main.js`（61942/61943/9333），上面这条 `Where-Object` 只匹配 `stage\main.js`，不会误杀。

## 3. 现在舞台能干什么 + 怎么验
```powershell
node stage\cli.mjs state                      # 状态
node stage\cli.mjs say "主人回来啦"            # 气泡 + 口型
node stage\cli.mjs say "主人回来啦" --voice    # 出声，气泡/口型/音频对齐
node stage\cli.mjs motion FingerShow          # 竖指，播完自己归位
node stage\cli.mjs emotion 脸红                # 表情，2.6 秒自动归位
node stage\cli.mjs wait                       # 三个点的等待泡
node stage\cli.mjs hide                       # 收起气泡
node stage\cli.mjs pointer 0 -1 --hold        # 冻结指针位置（验证探身）
node stage\cli.mjs pointer reset
```

控制口 `127.0.0.1:61945`：`/state` `/say` `/voice` `/voice-stop` `/volume` `/keepalive` `/wait` `/bubble?hide=1` `/motion` `/emotion` `/pointer` `/taps` `/touches` `/affinity` `/zones` `/window` `/gaze` `/config` `/panel` `/menu`。

点触那条链（2026-11-11 晚接完）：

```powershell
node stage\cli.mjs touches 5                   # 最近 5 条流水（data\touch.jsonl）
node stage\cli.mjs affinity                    # 亲密度：总次数/今天/连几天/最爱被摸哪
```

- 落盘跟外壳那套是**同一份文件**（`data\touch.jsonl`、`data\touch-stats.json`），所以以前攒的 67 下和 Lv 不会清零
- 反应由 `stage\touch.js` 的 `decide()` 定：部位表情 + 语气词，外加「隔 6 小时没摸会一惊一乍」「今天被摸 15 下以上会黏人」「同部位连击 3~5 下翻脸」，连击阈值随亲密度 Lv.4/Lv.6 抬到 4/5 下
- **表情只在主进程定**，页面那边 `interact.js` 只做点头摇头。两边同时改表情会互相打，看着像闪一下又回去
- 反向桥默认开：`data\stage-config.json` 的 `bridge` / `bridgeUrl`（`http://127.0.0.1:61944/event`），失败只记一次日志，不影响本地反应

心情那条链（2026-11-11 晚接完）：

```powershell
node stage\cli.mjs mood                        # 跟 persona\mood.json 对齐（mood.ps1 的落盘）
node stage\cli.mjs mood 害羞 --intensity 1      # 直接指定，强度 0~1
node stage\cli.mjs moods                       # 七种心情各自会变成什么样
```

- 来源只有 `persona\mood.ps1` 那七种：恬静 / 开心 / 害羞 / 撒娇 / 担心 / 认真 / 困（**不是**外壳那套 15 种英文情绪）
- `stage\mood.js` 的 `plan()` 把心情翻成三样：表情 + 小动作（点头/摇头）+ 待机摆动偏置（幅度倍数、重心前倾、歪头）
- 偏置由 `engine.setMood()` 接，**淡入 0.8 秒、末尾 1.5 秒淡出**，直接改会像卡了一帧
- 实测：`困` 强度 1 时 `AngleX` 摆幅是基线的 **0.65 倍**（跟表里的值一致），`害羞` 挂 `脸红`、`撒娇` 挂 `＞＜`
- 心情文件读不到会明确报错，不会静默什么都不做

DSH 桥那条链（第 6 步，2026-11-11 晚接完）：

```powershell
node stage\cli.mjs tick "整理笔记中" --ms 2600    # 阶段气泡：肩线冒小泡往上飘
node stage\cli.mjs reply "主人在吗"               # 回她一句（POST 到桥的 /say）
node stage\cli.mjs reply open | close            # 不点鼠标也能验输入卡
node stage\cli.mjs status                        # 端口/开关/亲密度/lastTick/lastReply
```

- **三个口都收**：GET 查询串、POST JSON 体。老的 DSH 桥全是 POST JSON，命令行习惯 GET，两种都认
- **三个端口都听**：61945（主）、61942、61943（别名）。桥里写死的是后两个，所以桥一行配置都不用改
- 阶段气泡跟正文气泡分开：正文是「她在说话」，阶段泡是「进度/状态」。**动画是外壳那版原样搬过来的**（2026-11-11 主人点名要）：
  圆泡带渐变和内发光，从上半身轮廓外侧随机冒出来（`interact.tickSpot`，四分之三落在头发边/肩/手臂），
  边往上飘边左右晃、微转、开头有个 0.6→1.08→1 的弹出，2~4 秒淡掉，同时最多 5 颗。
  踩过的坑：`bbox` 和 `rows[].y` 已经是归一化比例，再除一次窗口高度会让泡全挤在头顶那一行
- 回复钮默认跟随气泡（她说完话亮起来，气泡走了再留 2.4 秒），也能设常驻；点开是个输入卡，回车发、Esc 收
- 回复钮和输入卡不在剪影里，所以 `interact.js` 加了「额外热区」（`addHitTest`），否则鼠标压上去会判穿透、钮点不着
- 输入卡开着时强制整窗吃鼠标（`setForceEat`），不然点文本框那一瞬间窗口穿透了就没反应
- `POST /api/execute {"plan":{...}}` 只认 expression / motion / gesture 三类；pose 和 trajectory 是外壳那套参数级编排，**跳过并如实回报**在 `skipped` 里，别装作演了
- 实测整条闭环：`reply "测试一下"` → 桥投进桌宠会话 → 她回话 → 桥回流 → 舞台气泡出现「测试通过，主人快赏安娜一个奖励的亲亲」，桥日志 `echoed to pet (18 chars, moves=2)`

语音音量（2026-11-11 晚补，`voiceVolume` 0~1，默认 0.6）：

- 走一个 `GainNode`，**改音量不碰包络**：口型大小跟响度无关，调小只是她说话轻了，嘴型照旧张
- 三条入口：托盘/右键菜单（20/40/60/80/100% + 滑杆微调）、设置面板滑杆（拖着即时生效、松手落盘）、`node stage\cli.mjs volume 0.6`
- 即时生效，**不重载页面**：配置一改主进程就推一条 `{type:'volume'}` 进页面
- 播放中途改音量用 `setTargetAtTime` 平滑 20ms，直接赋值会有一声「咔」

**没声音那次是怎么踩的（2026-11-11 晚，别再踩）**：

- `stage.js` 原来写 `volume: Number(qs.get('volume'))`。URL 里没这个参数时 `qs.get(null)` 是 `null`，
  `Number(null)` 是 **0**，于是页面一开局音量就是 0 —— 全静音，而且口型照张、气泡照冒，看着像「播了但没声」
- 现在三处都补了：主进程 `stageUrl()` 把音量写进 URL；页面 `volRaw === null` 就传 null 交给默认值；
  `voice.js` 只有真给了数才用，非数一律 0.6（**传 0 才是真静音**）
- 查「没声音」先看这两个数：`window.__stageVoice.gain`（实际挂在音频图上的增益）、`ctxState`（要 `running`）。
  只有 `volume` 是配置值，不能当证据

TTS 保活（2026-11-11 晚，`stage\keepalive.js`，`ttsKeepAlive` 默认开）：

- 本地 CosyVoice 冷启动第一句要 27 秒，原因是网关没起、或者起了但模型还没进显存
- 定时（默认 5 分钟）`GET http://127.0.0.1:9880/health` 探活：不通就跑 `gateway\start.ps1` 拉起，
  起来之后再用一句「嗯」合成一次把模型顶进显存，**这句 wav 合成完立刻删**
- 她自己说过话（`noteSay`）就不重复热身；热身失败也不反复撞（桥脚本没装这种，每分钟撞一次是白撞）
- 拉起脚本顶不住（常见：`runtime\process.json` 里还记着旧 PID，脚本自己会 `throw`）就走第二条路：
  让 TTS 桥脚本自己起服务（`voice-say.ps1` 本来就会），只是要等 20 秒左右
- **spawn 的坑**：`detached: true` + `stdio: 'pipe'` 在 Windows 上拿不到任何输出、子进程还 exit 0 空串，
  看着像「脚本什么都没干」。别 detached，保持管道，把 stderr 尾巴留在 `/keepalive` 的 `startLog` 里
- 入口：面板「语音」那节（开关 + 探活间隔 + 实时状态说人话）、菜单「语音服务」、`node stage\cli.mjs keepalive [now|warm|on|off|分钟]`
- 实测：服务停掉后 `keepalive?now=1` → 拉起脚本 3 秒通、热身 19.7 秒；已经热着时再热身 5.4 秒；
  之后一句话从请求到出声 7.5 秒（含 powershell + python 那圈开销）

表情是引擎自己叠的，不靠模型那套（2026-11-11 晚，**重要**）：

- 这个 vendor 构建里 `model.expression(name)` 只把表情设成 `currentExpression`，**每帧没人把参数值写进 coreModel**
  （`ExpressionManager.update` 根本没被调）。结果是表情看着完全没反应：爱心眼不红、眯眼不眯、换装也穿不上。
  之前一直以为「表情能用」，是因为只看了 `state().emotion` 那个标签，没看画面。
- 现在 `engine.emotion()` 自己解析 exp3（`loadExpression`），每帧在**最后一层**按 blend 叠上去（`applyExpression`）：
  Add / Multiply / Overwrite 三种，淡入 0.15 秒、末尾 0.2 秒淡出。表情参数会被 `register()` 登记，跟着 `reassert()` 一起留住。
- 验法：`emotion 爱心眼` 之后立刻读 `key4` 应该从 0 涨到 1；截图能看见眼睛变色。
  **只读 `state().emotion` 不算验过**，那只是个字符串。

复原服装（`engine.resetOutfit()` / `/outfit/reset` / 菜单「复原服装」）：

- 换装（裙子切换、鞋子、胸衣、体型1/2、尾巴切换）是**状态不是动作**，穿上就下不来
- 做法：把 `Clothes1..8` 摁回各自默认档，同时清掉当前表情（换装是走表情通道写的，不撤表情下一帧又写回去）
- 构造时就 `register` 了 `Clothes1..8`，所以不用等某个换装表情被点过才生效；它们在 `this.hold` 里，驱动层不会写回默认值

菜单里补回来的那几项（2026-11-11 晚，给别人下载用的）：

- 互动 ▸ 点触叫醒 DSH 会话（`bridge`）、智能穿透（`smartIgnore`）——这两个原来只有配置，没有入口
- 说话 ▸ 阶段气泡 / 回复钮 / 回复钮常驻 / 窥屏（开关 + 四档性子 + 立刻瞄一眼）/ 主动开口浓度（安静~不拦着）+ 现在让她说一句
- **桥那几项是「问出来的」，不是本地存的**：弹菜单前先 GET 一次 `http://127.0.0.1:61944/health` 和 `/mood`，
  桥没装或没跑就把项灰掉并写明「桥没在跑，这个功能得装 dsh-pet-bridge」，点了没反应还一头雾水是最糟的
- 桥的开关全部转发给桥自己（`POST /peek`、`POST /mood`），舞台不留副本，避免两边状态打架

托盘左键 = 开关设置面板，右键 = 菜单（2026-11-11 晚主人定的，之前左键也弹菜单，菜单/面板一挂就不走）：

- 托盘左键：面板开着就收起、关着就打开；她藏起来了就先把她叫回来
- 托盘右键 / 右键她：弹菜单
- **菜单只放「面板里没有的」**：设置面板自己、语音（音量/保活状态/预热）、搭话（窥屏四档 + 主动开口五档，桥侧的东西）、
  外观 ▸ 复原服装、重新载入舞台、藏起来、退出
- 反过来，**所有开关和数值只在面板里**（分区互动 / 指针追踪 / 智能穿透 / 点触桥 / 置顶 / 阶段气泡 / 回复钮 / 保活开关和间隔 /
  帧率 / 摆动 / 圈数 / 尺寸 / 音量滑杆）。以前菜单里还各有一份，两处维护两份状态，早晚对不上
- `server: /panel?toggle=1` 是左键那条路的同一个函数，方便远程验

命令行对应：

```powershell
node stage\cli.mjs panel                       # 打开设置面板
node stage\cli.mjs config                      # 读当前配置（data\stage-config.json）
node stage\cli.mjs config '{"cursorTrack":false}'   # 改配置，就地生效
node stage\cli.mjs menu                        # 把菜单结构拍平成文字，确认勾选状态
```

台词里的方括号（2026-11-11 晚，主人报「方括号和内容被显示还念出来」）：

- 桥那边 `cues.js` 只把**认得**的指令编译成动作并从台词里剥掉，认不出的原来「绝不吞字」——
  于是 `[眼神闪烁]` 这种舞台说明会原样挂在气泡里，TTS 还一个字一个字念出来
- 现在两条路都剥：桥 `parseCues` 收尾把「像舞台说明」的括号摘掉并记 notes；
  舞台 `/say` 入口再过一遍 `stage\text.js`（旧桥、命令行、别的调用方塞进来的都能兜住）
- 判据故意保守，只剥「纯中文/中文标点 + 不超过 12 字 + 没有 ASCII 字母数字和冒号」的：
  `[眼神闪烁]` `【小声】` 剥；`[1]` `array[0]` `[at:1.5]` `[act:{...}]` 一个都不动
- 整句只有说明时（`[图片]`）把原文留着，绝不产出空气泡
- 顺手把**裸动词**也认了：`[点头]` `[歪头]` `[眨眼]` `[nod]` `[tilt]` 原来当错，现在各有默认幅度
- 记住这条链的现状：**桥解析出的动作（moves）现在送不到舞台**——新舞台的 `/say` 只吃 `emotion`，
  `moves` / `gesture` 字段没接（老外壳接过）。所以括号指令目前只是「不再碍眼」，动作还没真演

设置面板能拖着走（2026-11-11 晚，主人点名要）：
- 拖标题栏。实现是 CSS `-webkit-app-region: drag`，交给系统做拖拽，比自己算 mousemove 稳、不抖；
  标题里的关闭按钮标了 `no-drag`，不然点不着
- 位置记在 `%APPDATA%\whale-pet-shell\panel-window.json`，跟舞台窗那份（`stage-window.json`）分开存，互不拽
- 存下来的坐标如果落在所有屏幕之外（拔了副屏、换分辨率），会退回「跟着鼠标那块屏居中」，并把新坐标写回文件
- 找不回来的时候：菜单 ▸ 打开设置面板，或者 `curl 127.0.0.1:61945/panel?reset=1`
- **托盘右键菜单点外面自动收**（2026-11-11 晚）：托盘那条必须走 `tray.popUpContextMenu(menu)`，
  它把菜单的宿主设成托盘、拿到正常激活权，Windows 才会在点到别处时收掉。
  早先用的是 `Menu.popup({ window: win })`：桌宠窗是透明置顶、常年穿透不吃鼠标，
  菜单借它的壳弹出却拿不到激活，点外面没有任何事件关它，就一直挂着（主人报的就是这个）
- 右键她本人还是走 `popup({ window: win })`，那时候窗口活着、鼠标也在窗口上，普通 popup 的关闭是好的
- 「点面板外面自动收起」是**另一件事**，默认关（`panelAutoClose`），开关在面板最下面；
  它靠 `panel.on('blur')` 关窗，勾上之后点击面板外面就会收
- 踩过的坑：blur 和托盘左键的顺序是「先 blur 关掉、后 click 到」，
  不记一笔就会当成「没开过」又开一个新的，看着像点了关不掉。现在记 `panelBlurClosedAt`，
  600ms 内的 toggle 直接当「关闭」处理
- 调试口：`/panel?where=1` 回当前 bounds + 各屏 workArea；`/panel?at=120,300` 摆过去；`/panel?close=1` 关掉；
  `/panel?toggle=1` 跟托盘左键同一个函数；`/status` 里的 `panel` 字段能看 `open/visible/focused/autoClose`；
  `/menu?open=1` 按托盘右键那条路真弹一次菜单（自检用）
- 踩过的坑：`moved` 事件攒 400ms 再落盘的定时器里**别用全局 `panel`**——旧窗口的定时器晚到一步时，
  全局变量已经指向新窗口，会把新窗口的坐标当成旧窗口的存下去。要用创建时抓住的那个窗口引用

鼠标那边：压在她身上吃鼠标、透明处穿透、**Alt + 左键拖动**、**Ctrl + 滚轮**缩放、悬停换蓝色软点光标、点身上不同部位有反应。

页面里的调试钩子：`__lockPointer`（冻结外部指针）、`__freeze`（冻结驱动）、`__stageInspect([id])`（读参数）、`__petEngine.state()`、`__stageZones()`、`__stageVoice.playing`。

## 4. 五条红线（每条都吃过亏，别再踩）

1. **参数名用模型自己的语义名**：`AngleX / AngleY / AngleZ / LeanInput / PositionX`。`ParamAngleX` 在本模型里是物理**输出**，写进去当场被覆盖、读回恒 0。
2. **`internalModel.update` 收尾会 `loadParameters()`**：在 `updateNaturalMovements` 里写一次（物理当帧吃到），`update` 返回后再 `reassert()` 补写一次（值才留得住）。
3. **`key1..key13` 是表情专用通道**，驱动层不许碰，否则每帧擦一次表情。
4. **`fit()` 要挂在 `app.renderer` 的 resize 上并读 `app.screen`**：`window` 的 resize 比 PIXI 早一步，读旧值会让模型底锚掉到窗外、脚被截。
5. **`model.expression()` 不会自动回去**，要主动 `expressionManager.resetExpression()`。

## 5. 文件地图

| 文件 | 职责 |
|---|---|
| `stage\main.js` | Electron 入口：`pet://stage` 协议（`/model` `/voice` `/core`）、透明窗、33ms 轮询全局光标、穿透/拖动/滚轮 IPC、控制口、TTS 桥调用、窗口几何记忆 |
| `stage\index.html` | 载入顺序：Core → pixi → cubism4 → engine → interact → bubble → voice → stage |
| `stage\stage.js` | 建 PIXI 应用、加载模型、把驱动挂到更新链、指令分发 |
| `stage\engine.js` | **唯一**参数写入口：待机 / 眨眼 / 指针 / 口型 / 动作 / 冲量 / 表情定时归位 |
| `stage\interact.js` | 画布 alpha 判穿透、剪影自动标定、分区点触、拖动、滚轮、悬停光标、头顶锚点 |
| `stage\bubble.js` | 贴头顶的说话泡、逐字出水、等待三点 |
| `stage\voice.js` | 放 wav、RMS 包络驱动口型 |
| `stage\drag.js` | 跨屏高 DPI 拖动数学（从 `src\drag.js` 原样搬，别重写） |
| `stage\gaze.js` | 指针策略：轮询、静止丢失追踪、离屏回正、绕圈三节判定（纯数学可单测） |
| `stage\touch.js` | 点触账本：`touch.jsonl` 流水、`touch-stats.json` 亲密度、分区语气池 + 语境/连击判定（纯函数可单测） |
| `stage\mood.js` | 心情翻译：七种心情 → 表情 / 小动作 / 待机摆动偏置（纯函数可单测） |
| `stage\reply.js` | 回复钮 + 输入卡：直接打字回她，走桥的 `/say`；同时给交互层提供额外热区 |
| `stage\text.js` | 台词清洗：剥掉「舞台说明」型方括号（`[眼神闪烁]` / `【小声】`），别念别显示（纯函数可单测） |
| `stage\keepalive.js` | TTS 保活：探活 / 拉起网关 / 冷了就热身（13 条单测） |
| `stage\plan.js` | 桥砸过来的 plan → 舞台指令（expression / motion / gesture，其余如实跳过；纯函数可单测） |
| `stage\config.js` | 舞台配置：`data\stage-config.json` 的读写与默认值 |
| `stage\panel.html` `panel.js` `panel-preload.js` | 设置面板：尺寸滑杆、帧率、摆动、圈数、三个开关 |
| `stage\tray-32.png` `tray-256.png` | 托盘/面板图标（从 `assets\` 复制，stage 不 import src） |
| `stage\cli.mjs` | 命令行 |
| `stage\PLAN.md` | **接入计划 + 每步进展记录**（动手前必读） |
| `stage\README.md` | 架构、跑法、命令、五条红线的完整版 |

## 6. 路径与端口

- 模型目录 `F:\DaFeiYu\tools\jingyu\model\DeepSeek`（`大肥鱼.model3.json`，模型、贴图、`live2dcubismcore.min.js` **都不进仓库**）
- Cubism Core 自动从 `F:\DaFeiYu\tools\jingyu\jingyu-live2d-agent-main\web\vendor\live2dcubismcore.min.js` 找
- Cubism 渲染构建用 `stage\vendor\cubism4.colors.min.js`（鲸语那份改过的，换成官方 stock 版会出鼻梁黑块）
- TTS 桥 `F:\DaFeiYu\tools\pet-voice-prepare.mjs`，wav 目录 `F:\AI\VoiceService\gateway\downloads`
- 窗口几何存在 `userData\stage-window.json`，现在的位置 `1828,92` 大小 `671×1182`
- 配置存在 `data\stage-config.json`（互动/追踪/置顶/帧率/摆动/圈数）
- 端口：舞台控制口 **61945**，另加两个别名口 **61942 / 61943**（给 DSH 桥用，`--alias-ports=61942,61943` 可改）；反向桥 61944 是 DSH 侧插件在听
- `tools\pet-autostart.ps1` / `aux-services.ps1` / `pet-stop.ps1` 的健康端口都已经是 **61945**

## 6.5 指针手感（2026-11-10 晚新增，`stage\gaze.js`）

主进程的指针轮询已经抽成独立模块，`main.js` 里只剩「创建 + 绕圈之后长什么样」两件事。

- 三节：绕着她的头转够 **4** 圈 → `圈圈眼`（3.6 秒不看鼠标）→ `屑屑眼`（4 秒）→ `黑脸` + 手按在胸口（6.5 秒，最后 1 秒放下来，跟表情同时复原）
- `motion` 支持 `hold=1`（演完停在最后一帧，举手动作用它才按得住），`/motion-stop` 手动放掉
- **判据只要一条：指针在她这扇窗里就一直累计有向转角**，挪出窗口才清零。不设半径上下限
  （2026-11-10 深夜改的：原来 0.27 倍窗高 + 贴头心清零，主人绕整个身子转根本不触发）
- 手停 700ms 作废、两节间至少隔 900ms、一帧转角 >1.6 弧度当瞬移丢掉
- 鼠标静止 10 秒不再送位置（视线和身体一起回正），一动立刻恢复；离开本屏回正、回屏立刻跟手
- 窗口正中 ±0.04 死区
- 圆心 = 剪影头顶（页面 `reportHead()` 报，兜底 `0.503 / 0.22`）
- 模型更新锁 60 帧（`PIXI.Ticker.shared.maxFPS`，只锁 `app.ticker` 没用）；待机摆动倍数 `--sway=1.6`，头发物理全靠它

```powershell
node stage\cli.mjs gaze                     # 看追踪状态、离鼠标多少毫秒、这一节转了几圈
node stage\cli.mjs gaze off | on            # 开关追踪
node stage\cli.mjs gaze hide --ms 8000      # 手动挂起一阵
node stage\cli.mjs gaze circle 2            # 演示钩子：走真实判定和三节反应，不挪真鼠标
node scripts\test-gaze.mjs                  # 绕圈状态机单测（31 条，`npm test` 已带）
```

要现场演示「转两圈就晕」：`node stage\cli.mjs config '{"spinTurns":2}'`，正常 4 圈。

## 7. 未结项 / 等主人拍板

- 心情目前是「拉」的：`cli.mjs mood` 或 `/mood` 才同步一次，`mood.ps1` 改完不会自己推送；要自动跟就得让 `mood.ps1` 之后补一条 POST，或者舞台定时轮询 mood.json
- 语音：气泡和音频起点仍有约 50~100ms 差（页面 fetch+解码耗时），要不要提前预热
- 换装表情（`裙子切换` `鞋子` `胸衣` `体型1/2`）还没验证过在舞台上的持久性——外壳那边有「换装是状态不是动作、演完不能穿回去」的处理
- 老外壳（`src\`）什么时候删/归档：现在留着当回退，`npm run start:legacy`；它的 61942/61943 现在跟舞台撞口，两边同时开会有一个端口起不来（舞台会把占口那件事写日志，不影响其它口）
- 待优化（主人说后面再说）：摆动幅度手感（1.0 / 1.6 / 2.4 三档挑一档）

## 8. 协作约定

- **分支**：一律提交并推 `dev`；主人说封版才合 `main`、升版本号、打 tag
- **推代码前**确认 `steamcommunity_302` 开着（`Start-Process 'E:\Game\steamcommunity_302\steamcommunity_302.exe'`），不然 GitHub 连不上
- **提交身份**：`git -c user.name='Anna' -c user.email='anna@local' commit ...`
- **临时文件**：`F:\DaFeiYu\tmp\<日期>-<事项>\`，收工删；证据图留 `F:\DaFeiYu\out\stage\`
- **验证原则**：能数字化的就数字化（控制口读数、逐像素比对），别用肉眼比截图；拿不准就让主人看一眼真实桌面
- **记录规矩**：每完成一步就更新 `stage\PLAN.md` 的进展记录 + `persona\STATE.md` 顶部快照

## 9. 变更记录

```
<下一次提交>  设置面板点外面自动收起（blur 关闭 + 托盘左键的先后顺序防抖）
d7e30bc  菜单瘦身 + 托盘左键改开关面板（配置项一律回面板，音量归到「语音」下）
f90cde5  台词里的舞台说明方括号不再显示/念出来（stage\text.js + 桥 cues.js，裸动词也认）
fe64c4d  设置面板可以拖了：标题栏拖动、位置记住、拖丢了能一键回正中
8ca8db9  设置面板加长到 764，语音那节塞进去也不挤
9a96d30  语音其实一直静音（音量没进 URL 被当成 0）+ TTS 保活
3abfe26  阶段气泡换成外壳那版圆泡动画（上半身外侧随机冒、上浮摆动、弹出缩放）
deb0b62  表情原本完全没生效，改成引擎自渲染 exp3；补复原服装/智能穿透/窥屏/主动开口入口
9aa03b9  语音音量可调（GainNode 不碰口型包络），托盘/面板/命令行三处入口
e3f7321  第 6 步 DSH 桥：阶段气泡 / 回复钮 / plan 执行 / 别名端口（reply.js + plan.js + 20 条单测）
702e4e5  第 4 步心情端口：七种心情 → 表情/动作/待机摆动偏置（stage\mood.js + 41 条单测）
763366c  第 3 步点触账本：流水/亲密度/语境语气/反向桥（stage\touch.js + 61 条单测）
7742f24  摆动幅度/频率提到看得见的量级，头角+身体角一起摆
5494d94  绕圈判据放宽、眼睛回正、锁 60 帧、待机摆动 ×1.6
9c34506  指针手感细节：绕头转圈三节 / 静止丢失追踪 / 瞬移防护（stage\gaze.js）
2815e3c  接入第 2 步：语音链路，wav 包络驱动口型
49bb6e1  接入第 1 步：气泡与文字链路，附接入计划
a8fec35  脚不再被截、表情自动归位、悬停换光标、窗口尺寸记忆
1438f4b  搬来穿透/拖动/缩放/点触，分区判定改成相对剪影自动标定
0399202  接通控制口与命令行，修好表情被每帧擦掉
fe2eeeb  参数写对语义名，并在模型归位后再补写一次
df6c435  参数改成叠加写，俯身与自带动作同时生效
```
