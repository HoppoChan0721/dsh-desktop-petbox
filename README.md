# 棉花糖 · Marshmallow

把**任意 Live2D（Cubism 4）模型**放到 Windows 桌面上当桌宠。

舞台自己渲染 Live2D，不依赖第三方舞台工程：模型、Cubism Core 由你自备，其余全在这个仓库里。

- 形象：透明无边框置顶窗口，像素级穿透——只在角色身上吃鼠标，其余位置点到的是下面的窗口
- 演出：气泡、逐字显示、语音口型（按 wav 包络驱动）、表情、动作、整身摇摆、头部摆动
- 互动：点触分区反应（头发／头／脖子／胸口／腰／裙摆／腿／脚，伸出去的尾巴单算）、指针追踪、绕头转圈会生气
- 说话：`/say` 进来一句话就冒泡；接了 TTS 桥就有声音，没接就只有文字（不会报错）
- 会话联动：任何 DSH 会话在跑，她的肩头会冒阶段小泡（读 DSH 会话事件流，可选）
- 托盘 + 设置面板：开关、音量、尺寸、帧率、摇摆、回复钮、会话联动全在面板里
- 体型预设：右键菜单「外观 ▸ 体型预设」在 小／中等／标准 三档之间换（模型里做了体型表情文件才有），
  换完脚底自动对齐到同一条基线，不会因为变矮就飘到半空
- 同台：菜单「同台 ▸ 叫另一只过来」再开一只模型并排站在旁边，**自动随机换一身**（体型、裙子、鞋子、尾巴）；
  两只靠近会互相看一眼、离太近会互相嫌弃一句。副实例有自己的窗口位置文件，不占托盘、不跑语音保活、不看会话，
  **也不给回复钮**（会话只属主人那只），主实例退出时跟着退

## 快速开始

```powershell
npm install
# 告诉她模型在哪（三种方式挑一种，见下节）
npm start
```

第一次运行如果找不到模型，控制台会直说缺什么，窗口里是空白的——那不是崩了。

## 换模型

舞台在模型目录里找第一个 `*.model3.json`，配套的 `*.moc3`、纹理、物理、表情放在同一目录就行。
指定目录的优先级从高到低：

```powershell
$env:WHALE_MODEL_DIR = 'D:\models\mymodel'     # 1. 环境变量
# 2. data\stage-config.json 里写 "modelDir": "D:\\models\\mymodel"
# 3. 默认取仓库下的 models\
node_modules\electron\dist\electron.exe --model D:\models\mymodel   # 0. 命令行最高
```

Cubism Core（`live2dcubismcore.min.js`）按 `--core` → `WHALE_CUBISM_CORE` → `stage\vendor\` → 模型目录 的顺序找。
本仓库不含 Cubism Core，按 Live2D 的许可自行获取。

## 控制口

本地 HTTP，默认 `127.0.0.1:61945`；为了方便别人已经在用的脚本，同时监听 `61942` 和 `61943`。
GET 走查询串，POST 走 JSON 体，体里的键优先。

| 路由 | 作用 |
|---|---|
| `POST /say {"text":"…","emotion":"shy","moves":[…],"gesture":"hand_on_chest","voice":true}` | 说一句话；`emotion` 收英文情绪或模型表情名，`moves` 里是动作（带 `at` 秒偏移） |
| `POST /tick {"text":"…","ms":3000}` | 阶段小泡（不打断正戏） |
| `POST /mood {"emotion":"害羞"}` | 七种中文心情：表情 + 俯身 + 歪头 + 手势一次给全 |
| `POST /api/execute {"plan":{...}}` | 参数级/动作级计划 |
| `GET /status` `GET /state` `GET /params?ids=AngleX` | 自检读数 |
| `GET /panel?toggle=1` `GET /menu` | 开设置面板 / 看菜单结构 |
| `GET /peer/list` `POST /peer/spawn` `POST /peer/spawn?off=1` | 同台：看报到情况 / 叫一只过来 / 收回去 |
| `GET /body?preset=small\|medium\|standard` | 主模型的体型预设（菜单「外观 ▸ 体型预设」的控制口版本），不带参数报当前档 |
| `GET /parts` `GET /hit?x=330&y=1000` | 这个模型有哪些部件 / 一对坐标会算成哪个部位（配点触分区、排查误判用） |

命令行等价物：`node cli/pet.mjs say "台词" --voice --emotion shy`（其余子命令见 `node cli/pet.mjs`）。

## 配置

`data\stage-config.json`（不进仓库）。常用项：

| 键 | 说明 |
|---|---|
| `modelDir` / `cubismCore` | 模型目录 / Core 的 js 路径 |
| `interactive` `cursorTrack` `smartIgnore` `onTop` | 分区互动 / 指针追踪 / 智能穿透 / 置顶 |
| `fps` `sway` `swayTilt` `swayTiltPeriod` | 帧率 / 头部摆动 / 整身摇摆角度 / 摇摆周期 |
| `replyBtn` `replyAlways` | 回复钮 / 常驻（常驻会自动把主开关打开） |
| `voiceVolume` `ttsKeepAlive` `ttsKeepMinutes` | 音量 / 语音服务保活 / 探活间隔 |
| `sessionWatch` `sessionsDir` | 会话联动 / DSH 会话目录 |
| `peerModelDir` | 同台时第二只用哪个模型（留空 = 同一个） |
| `mainForm` | 主模型的体型：`体型默认` = 标准、`体型1` = 中等、`体型2` = 小（菜单里点一下就写这里，重启还记得） |
| `bridge` `bridgeUrl` | 点触转给 DSH 侧桥 |

## 自检与测试

```powershell
npm run doctor   # 模型、Core、控制口、语音桥、DSH 桥
npm test         # 7 组纯函数单测（参数驱动、心情、点触、动作映射、台词清洗…）
```

## 历史

这套舞台是从一个「给别人的舞台打补丁」的外壳长出来的，2026-11-11 起换成自渲染舞台，
旧外壳已在 2026-11-13 移除（`git log` 里能翻到）。现在代码层面不依赖任何外部舞台工程；
`THIRD-PARTY.txt` 里仍保留对上游的署名，那是取用构建产物的许可要求，不是运行依赖。

## 许可

MIT。模型、贴图、Cubism Core 不在本仓库内，各有各的许可。
