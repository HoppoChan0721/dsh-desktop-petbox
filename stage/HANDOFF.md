# 交接文档 · 自建 Live2D 舞台

> 写给**下一个会话的我**。读完这一份就能接着干，不用翻聊天记录。
> 最后更新：2026-11-10 22:0x · 分支 `dev` · HEAD `2815e3c`

---

## 0. 一句话

桌宠正在从「鲸语 1.4 + 四个补丁」迁到我们自己的舞台 `F:\DaFeiYu\projects\whale-pet-shell\stage\`。舞台已经能跑、能动、能摸、能说话出声，正按七步计划把外壳的成果搬进去。**接入进度 2/7。**

## 1. 立刻要做的第一件事

**第 3 步：点触记录与反向桥。**（指针手感那套 2026-11-10 晚已经补完，见 6.5 节）

- 点她 → 追加 `F:\DaFeiYu\projects\whale-pet-shell\data\touch.jsonl` → 算亲密度 → POST 到 `bridgeUrl`（现役是 `http://127.0.0.1:61944/event`）→ 把 DSH 会话叫醒
- 本地反应（表情 + 点头/摇头）已经有了，在第 3 步里保留
- **先只做本地记录和 `/taps`，桥那头等主人点头再连**（主人当时正用着 DSH）
- 参考实现：外壳 `src\main.js` 的 `handleTouch` `recordTouch` `appendTouch` `forwardTouch` `affinityInfo`（约 690~760 行）

做完第 3 步接着第 4~7 步，顺序和验收方式全在 `stage\PLAN.md`。

## 2. 先确认舞台在不在跑

```powershell
# 在跑就该回一段 JSON，带 frames / motion / pointer
curl http://127.0.0.1:61945/state
```

不在跑就这样起（**Cubism Core 不进仓库**，脚本会自己从鲸语 1.4 的 vendor 找）：

```powershell
cd F:\DaFeiYu\projects\whale-pet-shell
Start-Process -FilePath 'node_modules\electron\dist\electron.exe' `
  -ArgumentList 'stage\main.js','--cdp=9340' `
  -WorkingDirectory 'F:\DaFeiYu\projects\whale-pet-shell'
```

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

控制口 `127.0.0.1:61945`：`/state` `/say` `/voice` `/voice-stop` `/wait` `/bubble?hide=1` `/motion` `/emotion` `/pointer` `/taps` `/zones` `/window`。

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
| `stage\cli.mjs` | 命令行 |
| `stage\PLAN.md` | **接入计划 + 每步进展记录**（动手前必读） |
| `stage\README.md` | 架构、跑法、命令、五条红线的完整版 |

## 6. 路径与端口

- 模型目录 `F:\DaFeiYu\tools\jingyu\model\DeepSeek`（`大肥鱼.model3.json`，模型、贴图、`live2dcubismcore.min.js` **都不进仓库**）
- Cubism Core 自动从 `F:\DaFeiYu\tools\jingyu\jingyu-live2d-agent-main\web\vendor\live2dcubismcore.min.js` 找
- Cubism 渲染构建用 `stage\vendor\cubism4.colors.min.js`（鲸语那份改过的，换成官方 stock 版会出鼻梁黑块）
- TTS 桥 `F:\DaFeiYu\tools\pet-voice-prepare.mjs`，wav 目录 `F:\AI\VoiceService\gateway\downloads`
- 窗口几何存在 `userData\stage-window.json`，现在的位置 `1828,92` 大小 `671×1182`
- 端口：舞台控制口 **61945**；现役桌宠 61942/61943/9333；反向桥 61944

## 6.5 指针手感（2026-11-10 晚新增，`stage\gaze.js`）

主进程的指针轮询已经抽成独立模块，`main.js` 里只剩「创建 + 绕圈之后长什么样」两件事。

- 三节：绕着她的头转够 6 圈 → `圈圈眼`（3.6 秒不看鼠标）→ `屑屑眼` + HandRaise（4 秒）→ `黑脸` + HandRaise（26 秒冷却）
- 鼠标静止 10 秒不再送位置（视线回正），一动立刻恢复；离开本屏回正、回屏立刻跟手
- 窗口正中 ±0.04 死区；一帧转角 > 1.2 弧度当瞬移丢掉（外壳没这条，以前跨屏跳两下能凑出假发晕）
- 圆心 = 剪影头顶（页面 `reportHead()` 报，兜底 `0.503 / 0.22`）

```powershell
node stage\cli.mjs gaze                     # 看追踪状态、离鼠标多少毫秒、这一节转了几圈
node stage\cli.mjs gaze off | on            # 开关追踪
node stage\cli.mjs gaze hide --ms 8000      # 手动挂起一阵
node stage\cli.mjs gaze circle 2            # 演示钩子：走真实判定和三节反应，不挪真鼠标
node scripts\test-gaze.mjs                  # 绕圈状态机单测（31 条，`npm test` 已带）
```

要现场演示「转两圈就晕」：启动前 `$env:WHALE_SPIN_TURNS='2'`，正常是 6 圈。

## 7. 未结项 / 等主人拍板

- 第 3 步要不要真连反向桥（连了会唤醒 DSH 会话，主人当时在用）
- 语音：气泡和音频起点仍有约 50~100ms 差（页面 fetch+解码耗时），要不要提前预热
- 换装表情（`裙子切换` `鞋子` `胸衣` `体型1/2`）还没验证过在舞台上的持久性——外壳那边有「换装是状态不是动作、演完不能穿回去」的处理
- 第 5 步托盘/面板的**具体取舍**（哪些开关放托盘、哪些放面板）要主人定口味
- 现役桌宠什么时候让位（第 7 步）

## 8. 协作约定

- **分支**：一律提交并推 `dev`；主人说封版才合 `main`、升版本号、打 tag
- **推代码前**确认 `steamcommunity_302` 开着（`Start-Process 'E:\Game\steamcommunity_302\steamcommunity_302.exe'`），不然 GitHub 连不上
- **提交身份**：`git -c user.name='Anna' -c user.email='anna@local' commit ...`
- **临时文件**：`F:\DaFeiYu\tmp\<日期>-<事项>\`，收工删；证据图留 `F:\DaFeiYu\out\stage\`
- **验证原则**：能数字化的就数字化（控制口读数、逐像素比对），别用肉眼比截图；拿不准就让主人看一眼真实桌面
- **记录规矩**：每完成一步就更新 `stage\PLAN.md` 的进展记录 + `persona\STATE.md` 顶部快照

## 9. 变更记录

```
<下一次提交>  指针手感细节：绕头转圈三节 / 静止丢失追踪 / 瞬移防护（stage\gaze.js）
2815e3c  接入第 2 步：语音链路，wav 包络驱动口型
49bb6e1  接入第 1 步：气泡与文字链路，附接入计划
a8fec35  脚不再被截、表情自动归位、悬停换光标、窗口尺寸记忆
1438f4b  搬来穿透/拖动/缩放/点触，分区判定改成相对剪影自动标定
0399202  接通控制口与命令行，修好表情被每帧擦掉
fe2eeeb  参数写对语义名，并在模型归位后再补写一次
df6c435  参数改成叠加写，俯身与自带动作同时生效
```
