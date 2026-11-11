# 交接文档 · 自建 Live2D 舞台

> 写给**下一个会话的我**。读完这一份就能接着干，不用翻聊天记录。
> 最后更新：2026-11-11 18:4x · 分支 `dev` · **桌宠入口已切到 `stage/main.js`**

---

## 0. 一句话

桌宠已经**正式换成我们自己的舞台** `F:\DaFeiYu\projects\whale-pet-shell\stage\`（`package.json` 的 `main` 指向它，老外壳还在，`npm run start:legacy` 能起来当回退）。接入进度 **5/7 + 替身已完成**：气泡、语音、指针手感、托盘/右键菜单/设置面板、入口切换都好了；剩下第 3 步点触账本与反向桥、第 4 步情绪端口、第 6 步 DSH 桥。

## 1. 立刻要做的第一件事

**第 3 步：点触记录与反向桥。**

- 点她 → 追加 `F:\DaFeiYu\projects\whale-pet-shell\data\touch.jsonl` → 算亲密度 → POST 到 `bridgeUrl`（现役是 `http://127.0.0.1:61944/event`）→ 把 DSH 会话叫醒
- 本地反应（表情 + 点头/摇头）已经有了，在第 3 步里保留
- **先只做本地记录和 `/taps`，桥那头等主人点头再连**
- 参考实现：外壳 `src\main.js` 的 `handleTouch` `recordTouch` `appendTouch` `forwardTouch` `affinityInfo`（约 690~760 行）
- 接着第 4 步情绪端口 61943：`persona\mood.ps1` 现在还是往 61943 发，舞台没接之前那边是哑的

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

控制口 `127.0.0.1:61945`：`/state` `/say` `/voice` `/voice-stop` `/wait` `/bubble?hide=1` `/motion` `/emotion` `/pointer` `/taps` `/zones` `/window` `/gaze` `/config` `/panel` `/menu`。

托盘菜单 / 右键她 / 设置面板三处看到的是同一套东西（开关、尺寸、帧率、摆动、绕圈圈数）。命令行对应：

```powershell
node stage\cli.mjs panel                       # 打开设置面板
node stage\cli.mjs config                      # 读当前配置（data\stage-config.json）
node stage\cli.mjs config '{"cursorTrack":false}'   # 改配置，就地生效
node stage\cli.mjs menu                        # 把菜单结构拍平成文字，确认勾选状态
```

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
- 端口：舞台控制口 **61945**（现役就这一个）；老外壳那套 61942/61943/9333 只在 `npm run start:legacy` 时才会出现；反向桥 61944
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

- 第 3 步要不要真连反向桥（连了会唤醒 DSH 会话）
- 第 4 步情绪端口 61943 还没接，`persona\mood.ps1` 现在是往空气里发
- 语音：气泡和音频起点仍有约 50~100ms 差（页面 fetch+解码耗时），要不要提前预热
- 换装表情（`裙子切换` `鞋子` `胸衣` `体型1/2`）还没验证过在舞台上的持久性——外壳那边有「换装是状态不是动作、演完不能穿回去」的处理
- 老外壳（`src\`）什么时候删/归档：现在留着当回退，`npm run start:legacy`

## 8. 协作约定

- **分支**：一律提交并推 `dev`；主人说封版才合 `main`、升版本号、打 tag
- **推代码前**确认 `steamcommunity_302` 开着（`Start-Process 'E:\Game\steamcommunity_302\steamcommunity_302.exe'`），不然 GitHub 连不上
- **提交身份**：`git -c user.name='Anna' -c user.email='anna@local' commit ...`
- **临时文件**：`F:\DaFeiYu\tmp\<日期>-<事项>\`，收工删；证据图留 `F:\DaFeiYu\out\stage\`
- **验证原则**：能数字化的就数字化（控制口读数、逐像素比对），别用肉眼比截图；拿不准就让主人看一眼真实桌面
- **记录规矩**：每完成一步就更新 `stage\PLAN.md` 的进展记录 + `persona\STATE.md` 顶部快照

## 9. 变更记录

```
<下一次提交>  第 5 步托盘/右键菜单/设置面板 + 第 7 步入口切到 stage（config.js / panel.*）
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
