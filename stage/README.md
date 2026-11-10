# 自建轻量舞台（stage/）

我们自己的 Live2D 舞台，**跟 `src/` 那套桌宠外壳完全隔离**：它有自己的入口、自己的页面，不 import 外壳任何代码，跑起来也不占 61942 / 61943 / 9333。现役桌宠照旧跑原来的入口，两边互不影响。

为什么要自己养一个：现役模式靠给鲸语 `web/app.mjs`、`web/engine.mjs` 打补丁才拿到透明舞台和指针驱动，上游一升级补丁就失效。自建舞台没有这个问题，参数、动作、穿透全归自己。

## 现在能做什么

- 透明无边框窗口，把模型正确画出来，`pet://` 自定义协议直接读磁盘，**不需要 Python，也不需要任何端口**
- 自动播模型自带的表情与 Idle 待机动作
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

## 目录

| 文件 | 作用 |
|---|---|
| `main.js` | Electron 入口：注册 `pet://` 协议、开窗口、选模型与 Core |
| `index.html` | 页面骨架，先加载 Core，再 pixi，再 cubism4，最后 `stage.js` |
| `stage.js` | 渲染层：建 PIXI 应用、加载模型、按窗口大小摆好 |
| `vendor/` | `pixi 6.5.10` 与 `pixi-live2d-display 0.4.0`，都是 MIT，随仓库走 |

**Cubism Core 不进仓库**，跟现在 README 里那条一致，谁用谁自备。

## 下一步

1. 动作引擎：待机微动、指针跟随（`AngleX / AngleY / AngleZ / LeanInput / PositionX`）、口型、情绪表情
2. 把外壳那层的托盘、气泡、情绪端口接过来，让她能被 `/say` 和 mood 驱动
3. 穿透与点触分区搬过来验证
4. 参数彩蛋：裙子、换装表情（模型里有 `裙子切换`、`鞋子`、`胸衣` 这些表情名）
