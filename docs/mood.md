# 情绪层

桌宠不是只会放动画的壳子。她会因为被冷落而委屈，会因为看见你在打游戏而真的生气，会因为你一句话就把账清了。这一层负责那件事。

默认**关着**。`config.mood: true` 才会启用，关着的时候插件行为和以前完全一样。

---

## 为什么不是「一个心情变量 + 强度」

因为那样只能让嘴角变一下。情绪要能感觉到，得是三样东西：

1. **一本账**：谁、因为什么、什么时候给我记了一笔
2. **会自己走**：每种情绪有自己的半衰期，没人碰也会消
3. **影响行为**：不只是语气，还包括理不理你

第一样决定了「为什么生气」，第二样决定了「能气多久」，第三样决定了「气成什么样」。

---

## 结构

```
外部世界                 适配层                    核心                     消费方
触摸      ─┐
窥屏      ─┼→ signals.js ───→  engine.js ───→  snapshot ──→ ┬→ 投递时拼情绪卡
对方说话  ─┤   （翻译）         （纯函数）        （只读）     ├→ 闸门决定要不要理
时间流逝  ─┘                      ↑                          ├→ 托盘 / HTTP 查看
                                  │                          ├→ 壳子挑表情
                             profile.js                     └→ urge 决定要不要自己开口
                          （情绪定义，纯数据）
```

五条硬规矩：

- **核心不认情绪名字**。代码里没有 `anger`、`upset` 这种字面量，全在 `profile.js`
- **核心不认识触摸和窥屏**。它只接收 signal，翻译是 `signals.js` 的事
- **核心不读时钟、不写文件、不用随机数**。时间由调用方传，落盘在 `store.js`
- **核心能被单测**。`engine.js` 是纯函数，`node --test` 直接跑
- **关掉就真的关掉**。`mood` 关着时 `index.js` 里每处都走 `if (mood)` 短路

---

## 文件

| 文件 | 职责 |
|---|---|
| `lib/mood/profile.js` | 情绪定义表。加情绪、调衰减、改触发条件、加主动理由，只动这里 |
| `lib/mood/engine.js` | 账本、衰减、规则求值、档位。纯函数 |
| `lib/mood/signals.js` | 触摸 / 空闲 / 说话 / 场景 → signal；场景分类词表 |
| `lib/mood/urge.js` | 该不该自己开口、多久能开一次。纯函数 |
| `lib/mood/store.js` | `pet-mood.json` 读写，原子写 + 版本迁移 + 坏文件自愈 |
| `lib/mood/cue.js` | snapshot → 一段话。改文案的地方 |
| `lib/mood/index.js` | 门面。把上面几层粘起来，`index.js` 只跟它打交道 |

---

## 加一种情绪

假设想加「吃醋」：你看见她在跟别人聊天。

**第一步**，`profile.js` 里加一条情绪：

```js
emotions: {
  jealous: { halfLife: 24, polarity: -1, drives: ['tone'], label: '吃醋' },
}
```

`drives` 里不写 `tier`，意思是「吃醋会改语气，但不会把我推进冷战」。

**第二步**，加一条规则：

```js
rules: [
  {
    id: 'scene-social-jealous',
    on: 'scene',
    add: 'jealous',
    delta: 0.4,
    reason: '看见他在跟别人聊',
    when: {
      all: [
        { path: 'signal.category', eq: 'social' },
        { path: 'mood.bond', gt: 0.3 },
      ],
    },
    cooldown: 6 * 60 * 60 * 1000,
    key: 'label',
  },
]
```

**没有第三步。** 零行逻辑代码。

---

## 加一个信号源

假设你想让情绪跟着「今天写了几个小时代码」走。

```js
// signals.js
export function fromCodingSession({ minutes }, now = Date.now()) {
  return { kind: 'coding', at: now, minutes, weight: minutes / 60 };
}
```

然后在 `index.js` 里接上：

```js
mood.scene({ category: 'work' })   // 或者直接用底层 record
```

`engine.js` 一行不用改。规则里写 `on: 'coding'` 就能用上。

---

## 条件的写法

刻意不支持 JS 表达式字符串——那等于把 `eval` 塞进配置文件，别人不敢改也不好审。

```js
{ path: 'mood.upset', gt: 0.4 }         // 取值比大小：gt gte lt lte eq ne
{ path: 'signal.category', eq: 'leisure' }
{ all: [ ... ] }                         // 全部满足
{ any: [ ... ] }                         // 任意满足
{ not: { ... } }                         // 取反
{ fn: (mood, signal, tier) => true }     // 逃生舱，profile.allowFnConditions 为 false 时禁用
```

`path` 的四个命名空间：`mood.<情绪名>`、`signal.<字段>`、`tier`、`axes.<轴>`。

---

## 链式情绪

「委屈攒够了才转成气」靠的是情绪定义上的 `requires`：

```js
anger: {
  requires: { path: 'mood.upset', gt: 0.4 },
}
```

不到 0.4 时，看见你打游戏也只是更委屈；到了才转成气。这样「生气」有前因，不是随机抽风。

---

## 档位和闸门

三个档位，由**能推档位的负面情绪**加总决定：

| 档位 | 默认阈值 | 什么感觉 |
|---|---|---|
| `calm` | 负面 < 0.25 | 正常 |
| `sulky` | 负面 < 0.6 | 不痛快，话短带刺，但还理你 |
| `cold` | 其余 | 冷战，大概率不理你 |

档位带 **0.8 回差**：升档立即生效，降档要掉到阈值以下才降。没有回差的话情绪在阈值边上会来回跳，看着像抽风而不是像脾气。

`gates` 描述每个档位的行为差异，消费方自己决定要不要照做：

```js
gates: {
  touch: {
    calm: { respond: 1 },
    sulky: { respond: 0.75, extraDelayMs: 4000 },
    cold: { respond: 0.3, extraDelayMs: 20000 },
  },
  proactive: {
    cold: { intervalFactor: 3 },    // 冷战的时候主动消息降频到三分之一
  },
}
```

---

## 情绪卡

投递消息时会拼一段，告诉模型「你现在什么状态、因为什么、该怎么说话」。平静时返回空串，不占 token。

```text
（你现在是真的在生气，因为看见他在玩、好久没人理。只回极短的一句，不主动示好，被追问也冷着，别解释为什么生气。）
```

三条自我约束写在 `cue.js` 开头：只说「因为什么」和「怎么说」，不写情绪描写；平静就不说话；最多一百来字。

---

## 自己开口（urge）

情绪卡只是「开口时怎么说」。没有 urge，整层还是**被动的**：生气要等被摸一下才发作，开心也只躺在那儿。

`urge.js` 回答另一个问题：**现在该不该由她先开口**。纯函数，一分钟问一次也不花钱，真要说的时候才走一次投递。

```
profile.urge.windows  ──┐
账本里的 urges 记账    ──┼→ urge.decide() → { speak, window, hint, idleMin }
当前档位 / 情绪值      ──┘                          │
                                                    ↓
                                    index.js 的 deliver()（跟窥屏同一条管道）
```

### 和窥屏的区别

| | 看什么 | 什么时候说话 | 关掉它 |
|---|---|---|---|
| 窥屏 `peek` | 屏幕内容 | 定时间隔到了、画面有变化 | `peek: false` |
| 冲动 `urge` | 情绪和冷落时长 | 情绪到了她才开口，不看屏幕 | `moodUrge: false` |

两条都调 `deliver()`，谁都不认识谁。所以一条坏了另一条照常跑，也能各自单独关。

### 一档 window 长什么样

```js
{
  id: 'sulky-nudge',
  note: '有点不痛快，试探着问一句',      // 日志和 /mood 里给人看的
  hint: '你已经一个多小时没跟他说上话了，有点不痛快。别直接发火，先轻轻戳一句，看他理不理。',
  requires: { path: 'tier', eq: 'sulky' },  // 条件 DSL，跟规则表同一套
  minIdleMin: 45,                            // 至少多久没人理才允许开口
  gapMs: 60 * 60 * 1000,                     // 这一档两次之间至少隔多久
  maxPerDay: 2,                              // 这一档 24 小时内最多几次
}
```

`hint` 会原样拼进投递消息，告诉模型「为什么要开口」。情绪卡另有一条，两条不重复：卡说「你现在什么状态」，hint 说「你为什么现在说话」。

### 默认的六档，顺序即优先级

| window | 触发 | 冷落门槛 | 间隔 | 每天上限 |
|---|---|---|---|---|
| `sulky-nudge` | 档位 `sulky` | 45 分钟 | 1 小时 | 2 |
| `sulky-sharp` | 档位 `sulky` 且轻戳已用满 | 150 分钟 | 2 小时 | 2 |
| `cold-drift` | 档位 `cold` | 180 分钟 | 3 小时 | 2 |
| `jealous-grumble` | `jealous > 0.3` | 60 分钟 | 2 小时 | 2 |
| `worried-check` | `worried > 0.3` | 90 分钟 | 2 小时 | 1 |
| `joy-share` | `joy > 0.55` | 20 分钟 | 3 小时 | 1 |

负面排在正面前面：又想发火又想分享时，先发火。

**冷战也开口，只是很少很冷。** 真不出声的话对方反而感觉不到她在生气，只会觉得桌宠死了。所以「不理人」交给 `gates.touch` 去做，不是靠闭嘴。

### 三个全局闸门

在 `profile.urge` 上，比任何一档都优先：

- `quietFrom` / `quietTo`：静默时段只记账不开口，默认 0 点到 8 点
- `minGapMs`：任意两次主动之间至少隔多久，默认 25 分钟
- `maxPerDay`：全天总数，默认 6 次。几档轮流也不会变成播报机

另外两条写在 `index.js`：窥屏刚替她说过话，十分钟内不再补一句；投递失败先歇十分钟，别每分钟重试。

### 加一档新的主动理由

比如「感动了她会主动说一句」：

```yaml
moodProfile: 'F:\somewhere\mood.json'
```

```json
{
  "urge": {
    "windows": [
      { "id": "moved-thanks", "note": "被感动到了",
        "hint": "你刚被他说的话打动了，主动说一句，别煽情。",
        "requires": { "path": "mood.moved", "gt": 0.4 },
        "minIdleMin": 10, "gapMs": 7200000, "maxPerDay": 1 }
    ]
  }
}
```

注意 `windows` 是数组，外置配置会**整体替换**而不是拼接：数组拼接会让顺序（也就是优先级）变得不可预期。想保留默认几档就整份抄下来再改。

### 调试

```bash
node cli/pet.mjs mood urge      # 立刻问一句想不想开口，走的是跟定时完全相同的判断
curl -X POST 127.0.0.1:61944/mood -d '{"urge":true}'
```

返回里的 `urgeResult` 是这一次的结论，`urge` 是状态摘要（今天开了几次、每一档的计数）。托盘菜单「现在让她说一句」调的是同一个接口。

---

## 接口

```bash
GET  /mood                          # 当前状态：档位、心情、账本、主动开口计数、最近几条记录
POST /mood {"reset": true}          # 一键哄好
POST /mood {"scene": {...}}         # 手动喂一笔，调试用
POST /mood {"urge": true}           # 立刻问她一句想不想自己开口
```

关着的时候返回 `{ ok: true, enabled: false }`，不是 404——前端不用分两种错误处理。

---

## 状态文件

`$DSH_HOME/pet-mood.json`，普通 JSON，可以直接看、直接改。

- 带 `schemaVersion`。以后改结构就加一条迁移函数，别去改读取流程
- 坏了就重置成空账本并记日志。情绪丢了是小，桥挂了是大
- 读写是原子的：先写 `.tmp` 再 rename，半截文件永远不会被读到
- 停机那段时间的衰减会在下次读取时补上，不会因为关了 DSH 就假装时间没走

---

## 调参

参数是拍脑袋定的，得靠实跑。

**改参数不用动代码。** 配置里给 `moodProfile` 一个 JSON 路径，它会和默认表合并：

```yaml
      config:
        mood: true
        moodProfile: 'F:\somewhere\mood.json'
```

```json
{
  "rules": [
    { "id": "idle-away", "on": "idle", "add": "upset", "delta": 0.08,
      "reason": "好久没人理", "when": { "path": "signal.minutes", "gt": 120 } }
  ],
  "gates": { "touch": { "cold": { "respond": 0.15 } } }
}
```

合并规则是刻意做简单的，好预期：

- 对象按键合并，`emotions` / `gates` / `cue` 再多深一层——加一种情绪不用重写别的
- **数组整体替换，不拼接**。规则表拼接会让顺序变得不可控
- 值是 `null` 的键删掉
- patch 里没写的键保持默认

外置表写坏了、或者把 `emotions` 删空了，会退回默认并记一行日志。调参不该有让桥起不来的能力。

几个一眼能改的：

| 参数 | 影响 |
|---|---|
| `rules[idle-away].delta` | 每小时攒多少委屈。现在 0.05，一天没人理大约稳在 0.45 |
| `emotions.upset.halfLife` | 委屈留多久。现在 6 小时 |
| `tiers[0].below` | 多难过才算「不痛快」。现在 0.25 |
| `gates.touch.cold.respond` | 冷战期还理你的概率。现在 0.3 |
| `urge.minGapMs` | 任意两次主动之间最短间隔。现在 25 分钟 |
| `urge.maxPerDay` | 全天最多自己开口几次。现在 6 |

改完跑 `npm test`，六十多条用例覆盖了「委屈攒够才转成气」「冷战里被摸更委屈」「说话能哄好」「冷战会自己结束」「坏状态文件不会把桥带崩」「软的不吃两次才换硬的」「静默时段不开口」这几条业务约定，改坏了会当场红。

---

## 现在做到哪一步

- [x] 账本、衰减、档位、闸门、状态持久化
- [x] 情绪卡拼进投递
- [x] 触摸、说话、窥屏、空闲四个信号源
- [x] `GET /mood`、`POST /mood`、`node cli/pet.mjs mood [reset|urge]`
- [x] 六十多条单测
- [x] 闸门机制：冷战期按概率不投递，`moodGates: true` 才生效。延迟卡在 3 秒内，免得壳子的请求超时
- [x] 主动消息频率跟着 `proactive.intervalFactor` 走（窥屏每次排期都现问一次，夹在 0.2~6 倍之间）
- [x] 托盘「说话 ▸ 心情 · …」显示当前状态，附一行原因，可点「哄好她」
- [x] **主动开口**：六档 window、软硬升级、三个全局闸门、窥屏先记场景再跳过。跟窥屏共用一条投递管道，互不影响
- [ ] 参数实跑调顺，然后打开 `moodGates`
- [ ] 和主会话的 `mood.ps1` 合并成一本账

---

## 开关一览

| 配置 | 默认 | 作用 |
|---|---|---|
| `mood` | `false` | 总开关。关着时整层不加载，行为一个字不变 |
| `moodUrge` | `false` | 主动开口。打开后情绪够了她会自己把话送到桌面上 |
| `moodGates` | `false` | 闸门。打开后冷战期真的会不理人 |
| `moodFile` | `$DSH_HOME/pet-mood.json` | 状态文件位置 |
| `moodProfile` | 空 | 外置情绪表，和默认表合并。调参不用改代码 |
| `moodTickMs` | `300000` | 多久结算一次衰减并落盘 |
| `moodUrgeTickMs` | `60000` | 多久问一次「她想不想开口」。只是纯计算 |
| `moodUrgeCooldownMs` | `600000` | 投递失败后先歇多久 |

四个开关分开是有意的：先把情绪接上、看几天账本，觉得参数对了再开主动开口和闸门。一起打开的话，万一半夜参数歪了，第二天起床面对的就是一个不理人还在抱怨的桌宠。
