# 自建轻量舞台（stage/）

我们自己的 Live2D 舞台，**跟 `src/` 那套桌宠外壳完全隔离**：它有自己的入口、自己的页面，不 import 外壳任何代码，跑起来也不占 61942 / 61943 / 9333。现役桌宠照旧跑原来的入口，两边互不影响。

为什么要自己养一个：现役模式靠给鲸语 `web/app.mjs`、`web/engine.mjs` 打补丁才拿到透明舞台和指针驱动，上游一升级补丁就失效。自建舞台没有这个问题，参数、动作、穿透全归自己。

## 现在能做什么

- **所有参数写入只从 `engine.js` 出**：待机呼吸摆动、眨眼、指针跟随、动作播放、说话口型，一个出口，互不覆盖
- 指针跟随：头 `AngleX/Y/Z`、探身 `LeanInput`、上身 `PositionX`，带时间常数平滑，指针在窗口外也跟
- 动作：读 `motion3.json` 自己求值，播完自动归位。`engine.motion('HandRaise')`
- 表情：`engine.emotion('脸红')`，走模型自带表情
- 口型：`engine.talk(毫秒)` 张嘴说话
- 透明无边框窗口，`pet://` 自定义协议直接读磁盘，**不需要 Python，也不需要任何端口**
- canvas 开了 `preserveDrawingBuffer`，页内可以直接读 alpha，穿透和点触分区不必再借补丁

## 怎么跑

```powershell
node_modules\electron\dist\electron.exe stage\main.js `
  --model="F:\path\to\model" `
  [--core="F:\path\to\live2dcubismcore.min.js"] `
  [--cdp=9340]
```

- `--model` 指向含 `*.model3.json` 的目录
- `--core` 不给就依次找 `WHALE_CUBISM_CORE`、鲸语 1.4 部署的 `web/vendor/`、模型目录本身
- `--cdp` 给个端口就能用 CDP 挂调试

## 怎么跟她玩

| 动作 | 效果 |
|---|---|
| 鼠标移到她身上 | 光标换成蓝色软点；窗口吃鼠标；移到透明处就穿透到底下，不挡主人点东西 |
| 左键点她 | 按点到的部位反应：头/发 → 眯眼摇头，胸/腰 → 脸红点头，腿 → ＞＜ 点头。表情 2.6 秒后自动归位 |
| **Alt + 左键拖动** | 拖到桌面任何位置（跨屏、高 DPI 都按物理像素冻结尺寸） |
| **Ctrl + 滚轮** | 微调大小，脚不动，只有个头变高 |

说话时头顶冒气泡：贴着她的头顶走（不是贴在窗口角上），逐字出水，到点自己淡掉；等待的时候是三个点在跳。泡不吃鼠标，绝不挡点击。

窗口的大小和位置记在 `userData\stage-window.json`，重启不用重新调。`GET /window?w=&h=` 可以直接设。

分区不写死数值：启动后扫一遍画布 alpha 量出剪影，脖子用「头下面最窄的那一行」自动找，其余部位按脖子到下摆的比例切。窗口拉大、缩放、换装都不用重新标定。`GET /zones` 和 `GET /taps` 可以看当前标定和最近的点触记录。

## 怎么说话（控制口）

`main.js` 在 **127.0.0.1:61945** 开了个只监听本机的 HTTP 口，`--port=` 可改。避开现役桌宠的 61942/61943/9333 和 dsh-pet-bridge 的 61944。

```powershell
node stage\cli.mjs state
node stage\cli.mjs say "主人回来啦" --emotion 脸红 --motion HandRaise
node stage\cli.mjs wait                # 三个点的等待泡
node stage\cli.mjs hide                # 收起气泡
node stage\cli.mjs motion FingerShow
node stage\cli.mjs emotion 眯眼
node stage\cli.mjs pointer 0 -1 --hold     # 冻结成固定指针位置
node stage\cli.mjs pointer reset
```

HTTP 直接调也行：`/state`、`/say`、`/wait`、`/bubble?hide=1`、`/motion`、`/emotion`、`/pointer`。

## 目录

| 文件 | 作用 |
|---|---|
| `main.js` | Electron 入口：注册 `pet://` 协议、开窗口、选模型与 Core、送指针、开控制口 |
| `index.html` | 页面骨架，先加载 Core，再 pixi，再 cubism4，最后 `stage.js` |
| `stage.js` | 渲染层：建 PIXI 应用、加载模型、把驱动挂到更新链上 |
| `engine.js` | 驱动层：待机、指针、眨眼、口型、动作、参数写入 |
| `interact.js` | 交互层：alpha 判定穿透、剪影标定、分区点触、拖动与缩放 |
| `bubble.js` | 气泡层：贴着头顶的说话泡、逐字出水、等待三点 |
| `drag.js` | Alt 拖动的一帧数学，跨屏 / 高 DPI 冻结物理像素尺寸 |
| `PLAN.md` | 把外壳成果搬进来的接入计划与进展记录 |
| `preload.js` | 主进程与页面之间的桥 |
| `cli.mjs` | 命令行：走控制口给她发指令 |
| `vendor/` | `pixi 6.5.10` 与 `pixi-live2d-display 0.4.0`，都是 MIT，随仓库走 |

**Cubism Core 不进仓库**，跟现在 README 里那条一致，谁用谁自备。

## 三个必须记住的坑（都吃过）

**一、参数名用模型自己的语义名。**
这个模型的驱动参数是 `AngleX / AngleY / AngleZ / LeanInput / PositionX`，不是 Cubism 标准的 `ParamAngleX`。
`ParamAngleX` 这类在本模型里是物理**输出**，写进去当场被物理覆盖，读回来永远是 0——所以「俯身没反应」「动作管理器说在播但画面不动」都从这里来的。

**二、`internalModel.update` 收尾会 `loadParameters()`。**
pixi-live2d-display 的顺序是：动作 → `saveParameters()` → 表情/眨眼/焦点 → `updateNaturalMovements()` → 物理 → `pose` → `o.update()` → **`loadParameters()`**。
最后一脚把所有参数还原成「动作算完时保存的那份」，所以在中间写进去的东西，几何虽然用上了，参数表里却看不到，下一帧也被抹平。
现在两个时机各写一次：`updateNaturalMovements` 里算并写（物理这一帧就吃到），`update` 回来后再补写一遍（值才留得住）。

**三、`key1..key13` 是表情专用通道，驱动层不许碰。**
这套模型所有表情都写这组参数（`脸红` 就是 `key7 += 1`）。驱动层一旦把它们纳入管理，每帧写回默认值 0，等于每帧把表情擦掉一次——表现就是「切了表情但看不出来」。表情交给模型自己的表情管理器，驱动层只管动作和身体。

**四、窗口尺寸要在 PIXI 自己的 resize 事件里读。**
`resizeTo: window` 是 PIXI 自己接的，`window` 的 resize 事件比它早一步。在 window 的事件里读尺寸拿到的是旧值，算出来的缩放和底部锚点都差一截——表现是窗口一变，脚和鞋子就被截掉一截。要挂 `app.renderer.on('resize')`，并且用 `app.screen` 而不是 `renderer.width / resolution`。

**五、表情不会自己回去。**
`model.expression()` 挂上就一直挂着。点她一次脸红能挂到天荒地老，所以 `engine.emotion()` 演完 `TUNE.expressionMs` 之后要主动 `expressionManager.resetExpression()`。

## 下一步

1. 把外壳那层的托盘、气泡、情绪端口接过来，让她能被 `/say` 和 mood 驱动
2. 穿透与点触分区搬过来验证
3. 参数彩蛋：裙子、换装表情（模型里有 `裙子切换`、`鞋子`、`胸衣` 这些表情名）

调试钩子：`window.__lockPointer = true` 冻结外部指针、`window.__freeze = true` 冻结驱动、`window.__stageInspect([id])` 读参数、`window.__petEngine.state()` 看状态。
