# 桌宠会话 · 预设提示词汇总

桌宠会动、会回话，靠的不是外壳自己，而是**一个独立的 DSH 会话**在下判断。这份文档给出那套预设的完整写法。

提示词正文已经剥离过：不带你自己的角色设定、人名、称呼、现实信息。方括号里的表情名是**示例白名单**，换成你自己模型的名字即可。

---

## 为什么必须是独立会话

主会话正在写代码、看日志、跑命令。如果点触事件投给主会话，会有两个毛病：

1. 上下文被污染。用户正在想别的事，突然插进来一句「点你胸口了」
2. 它会拿工具干活。有工具就会去读文件、跑命令，而不是说一句话让模型动一下

所以桌宠走一条**只有人设、工具被砍到最低**的会话。外壳点一下 → 反向桥把点触变成一条 user 消息 → 那条会话回一句话 → 回流成气泡 + 舞台动作。主会话完全不参与。

反向桥见 [`bridge/dsh-pet-bridge`](../bridge/dsh-pet-bridge)。

---

## 预设怎么建

在 DSH 里新建一个 agent preset，**插件列表先只放 persona**：没有工具 = 它只能说话。

不过「只挂 persona 就等于零工具」是个常见的误会，建完看下一节。

```yaml
# 字段名以你装的 DSH 版本为准，这里只标结构
- insert:
    - id: preset-<name>-pet
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: <name>-pet
        name: <角色名>（桌宠）
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              suffix: ''
              prefix: |-
                <把下面「提示词正文」整段粘到这里>
                <上面接你的人设正文>
```

建完在 `dsh-pet-bridge` 的配置里指定它：

```json
{ "mode": "pet", "agentPreset": "<name>-pet" }
```

`mode: "pet"` 会固定一条会话反复用；`mode: "main"` 是旧行为，投给当前主会话，不建议。

---

## 只挂 persona 为什么还不是零工具

DSH 的工具注册表在**宿主平面**：任何一个插件注册了工具，那个工具就对所有 agent 可见。preset 手里有的只是「呈现方式」（native 还是 ptc），选不了内容。所以你把预设砍到只剩 persona，那条会话照样继承全套干活工具。

代价是实的，不是洁癖。实测一条桌宠会话的请求体：**41 个工具，schema 合计 37934 字符**，粗算九千多 token，每轮都付一遍，而她的输出是十个字。贵的几个还都跟她没关系——`domain_search` 4140 字符、`schedule_create` 2678、`mnemon_runtime_memory` 2517、`schedule_update` 2389。

`dsh-tools` 留了按作用域掩码的口子：

```text
ctx.tools.restrict({ allow?: string[], deny?: string[] })
```

注释写着「按调用方 agent 作用域限制全局工具」，README 里还有一句更直接的：「隐藏工具的限制会为该 agent 移除其全部 schema 成本」。冒号前那句是关键——**限制落在调用作用域上**，而插件的挂载作用域正好就是 preset。所以在 preset 里挂一个十行的插件，在 `apply` 里调一次，就只影响这个 agent。

仓库里给了现成的：[`bridge/dsh-pet-trim`](../bridge/dsh-pet-trim)。挂法：

```yaml
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
                <人设 + 提示词正文>
          - id: pet-trim
            name: dsh-pet-trim
            config:
              allow:
                - mnemon_recall
```

`allow` 留什么由你自己定。只留 `mnemon_recall` 是「能回忆、不能干活」；一个人都不想留就删掉整条 trim——但那样等于维持 38k 字符的现状。

插件优先走 `allow`，因为 `allow` 不依赖「此刻哪些工具已经注册」，宣布完剩下的全被移走。名字里有一个不存在会整个失败（没装记忆插件就属于这种），这时它退到 `deny` 当时可见的全量并记一行日志，不会把会话搞崩。

### 同一套口子还能治提示词和快照

工具只是三块里最贵的一块。同一条会话的请求体里还有两笔：

| 来源 | 每轮多少 | 里面是什么 |
|---|---|---|
| 系统提示段 | 约 8000 字符 | gate 的安装扫描说明、搜索插件的引擎名单和 fallback 链、present 的图片链接规矩、harness 源码路径、Web 表层说明、记忆写入协议 |
| 运行时快照 | 4021 字符 | 热记忆（用户画像加记忆正文）、时间戳 |

前者走 `ctx.on('system-prompt/assemble', …)`。那是 `dsh-system-prompt` 的 waterfall，**按作用域分发**——scoped listener 只收到自己那条 agent 的装配，而插件的挂载作用域就是 preset。拿到 `assembly.sections` 按名字过滤再返回，剩下的由你说了算。

第一方段名就三个：

| 段名 | 内容 |
|---|---|
| `harness:identity` | `You are an AI agent powered by DeepSeek Harness.` |
| `deployment:persona-prefix` | 人设正文，`dsh-persona` 的 `prefix` 落在这儿 |
| `deployment:persona-suffix` | `suffix`，桌宠预设里是空串 |

`dsh-pet-trim` 默认只留这三个，其余全丢。一个段名都没匹配上时它原样放行，不会把提示词删空。

后者更省事——**不用插件**。`dsh-persona` 自己带 `includeRuntimeContext`，设 false 等价于调 `ctx.systemPrompt.suppressRuntimeContext()`：

```yaml
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              suffix: ''
              includeRuntimeContext: false
              prefix: |-
                <人设 + 提示词正文>
```

代价是模型收不到时间戳，也收不到沙箱和审批策略——桌宠只用来说话，这些本来就用不上。要是希望她知道现在几点，删掉这一行，快照会连热记忆一起回来。

三块一起收，固定开销从约 54k 字符降到 5k 出头。

改完要重启 DSH，preset 是启动时装配的。

---

## 提示词正文

下面这段是「怎么动」，不进人设正文。人设（她是谁、怎么说话）另写，两段拼起来就是一个完整的桌宠预设。

```text
## 说话

一句 5～20 字，越短越好。不用列表、标题、代码块。气泡装不下长文。

## 指令

写在台词里，方括号包住。桥会执行并从台词里剥掉，气泡里看不见。

表情，直接点名字就成：
> [脸红] [眯眼] [黑脸] [＞＜] [兔牙] [爱心眼] [圈圈眼] [流泪] [流冷汗] [屑屑眼] [前倾] [钢盆] [食指伸出] [食指收起] [加载]

换装 / 体型这类开关也走同一个通道：
> [体型1] [体型2] [体型默认] [尾巴切换] [胸衣] [裙子切换] [鞋子]

动作：
> [look:left] [nod:2] [shake:2] [tilt:right] [blink:1] [smile] [pose:AngleZ=8,LeanInput=6]

情绪，一整段身体表演，和单个表情二选一：
> [emotion:happy] [emotion:shy] [emotion:excited] [emotion:thinking] [emotion:sleepy] [emotion:proud] [emotion:sad] [emotion:annoyed] [emotion:surprised] [emotion:greeting] [emotion:playful] [emotion:neutral] [emotion:flustered] [emotion:confused] [emotion:pout] [emotion:pout]

手势：
> [gesture:hand_on_chest] [gesture:point] [gesture:grass]

时间和保持：
> [at:0.6] 让后面的动作晚点开始　[hold:脸红:6] 挂住不散

## 分寸

一句最多三个指令。默认同时开始，抢同一处身体会自动错开，不用自己排。

用户只是说句话，别每次都上大表情。点到为止更像活人。

## 做不到的

没有走路、转身、跑、抱人、递东西。不要声称做过这些。

舞台只认上面这些动作。想秀新花样先试 [act:...] 原始 JSON，失败就当没试过。
```

最后一句 `[act:...]` 是留的口子：桥不认识的方括号会原样留在台词里，所以只在本地试验时用，别放进正式人设。

---

## 可选：让她记得住事

**这一节不属于上面那份提示词，加不加要看你自己装了什么，别直接抄。**

先说一个容易踩空的事实：如果装了记忆类插件（`dsh-mnemon` 之类），这类插件是**应用级注册**的，工具会自动出现在这条本来「零工具」的会话里，记忆召回、搜索、日程全都在。但预设卡里没人告诉它可以查，它就一次都不会用。实测 53 轮桌宠回复，工具调用 0 次。能力在，它不知道自己有。

要不要加、怎么加，**先去问你自己那只桌宠**，让它跟主人商量。不要照抄任何人的写法，三个理由：

- 没装记忆插件就没有这个工具，写进提示词只会让它假装调了一个不存在的动作
- 各家暴露的工具名不一样，本文写 `mnemon_recall` 只是举例，别的插件可能完全不同
- 给了权限就会花钱，每轮多一次工具调用，而气泡里看不出它查过什么

还有个隐性成本：装了这类插件，桌宠会话每轮还会被塞一份热记忆快照，用户画像四五千字加记忆正文近万字，而它要回的可能只是「嗯，主人辛苦了」。这份开销要不要留，也一起商量。

商量下来要加的话，句式只写原则，工具名留空让自己填：

```text
## 想不起就问

想不起用户提过的事，就调 <你的记忆查询工具> 查一条，够了就停。

查到就顺着聊，查不到就说不知道，别编。

一轮最多查一次，气泡里不解释查了什么。

没有这个工具就当没这段。别拿它查代码、查配置、查自己的设定，那是陪聊用的东西。
```

---

## 相关待办

- **提示词段和快照的收法已经在前面写全了**，剩下的是取舍不是能力：丢了运行时快照，她也就不知道当前时间了；想留着就把 `includeRuntimeContext` 那行删掉
- 这些口子都算半个内部约定（`system-prompt/assemble` 的 waterfall 签名、三个第一方段名），DSH 大版本升级后先跑一遍再信它。`dsh-pet-trim` 每步都 try/catch + 记日志，最坏情况是收不动而照样说话

---

## 指令是怎么被认出来的

解析器在 [`bridge/dsh-pet-bridge/lib/cues.js`](../bridge/dsh-pet-bridge/lib/cues.js)，白名单就是文件顶上那几个数组：

| 数组 | 对应什么 |
|---|---|
| `EXPRESSIONS` | 表情 / 换装的按键名，名字要和你的模型资产里的开关对得上 |
| `EMOTIONS` | 情绪预设，一次演一整段 |
| `GESTURES` | 手势 |
| `PARAM_OF` | 每种动作占哪些参数，用来错开同时抢同一处的动作 |
| `PARAM_RANGE` | 语义参数的合法区间，越界会夹紧到范围内 |

设计上有两条约束：

- **认不出来的方括号原样留在台词里**，绝不吞字。`[图片]` `[链接]` 这类是照常显示的
- **越界一律夹紧**，不抛错打断，只记一条 notes 给日志看

另外两个硬上限：一句最多 **24 条动作**，超了后面直接丢；`[at:x]` 最多推到 **60 秒**。所以「一句最多三个指令」那条不是摆设，写多了也是白写。

`[emotion:...]` 和 `[gesture:...]` 不进动作列表，各自单独占一个字段（`emotion` / `gesture`），跟着口型同帧下发。同一句里写多个只有最后一个算数。

换模型的流程就是改 `EXPRESSIONS`：把里面的名字换成你 `.model3.json` 里实际的开关名。

---

## 回流链路

```
点触（外壳 61943）
   └→ 反向桥 61944 ── 转成 user 消息 ──→ 桌宠会话（人设 + 身体卡，工具已收窄）
                                            │ 回一句话，带方括号指令
                                            ↓
                              parseCues 拆成「气泡台词 + 舞台动作」
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     ↓                                             ↓
          外壳 /say {"text":"..."}                       舞台 /api/execute
          （气泡 + 口型 + 可选 TTS）                    （plan → 参数曲线）
```

会话里说的每一句都会被回送成气泡。太长会截断，所以那句「一句 5～20 字」不是风格建议，是接口限制。

---

## 踩过的坑

- **expression 不带 `strength` 会被按 0.6 编译**，结果是新旧两张脸各半透明叠在一起。下发时统一补满档
- **同一参数被两条动作同时驱动会 400**，所以 `PARAM_OF` 要先算占用，撞了就自动把后一条往后挪
- **换装是单向的**，只有「变成」没有「变回」。舞台的 pose 白名单也不收 `Clothes*`，想复位得从外壳直接改引擎参数，见 `src/main.js` 里的 `__petResetOutfit`
- **引擎每帧会平滑回默认值**，只改模型核心不够，得同时改引擎的 `current` 缓存
