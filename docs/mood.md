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
                                  │                          └→ 壳子挑表情
                             profile.js
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
| `lib/mood/profile.js` | 情绪定义表。加情绪、调衰减、改触发条件，只动这里 |
| `lib/mood/engine.js` | 账本、衰减、规则求值、档位。纯函数 |
| `lib/mood/signals.js` | 触摸 / 空闲 / 说话 / 场景 → signal；场景分类词表 |
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

## 接口

```bash
GET  /mood                          # 当前状态：档位、心情、账本、最近几条记录
POST /mood {"reset": true}          # 一键哄好
POST /mood {"scene": {...}}         # 手动喂一笔，调试用
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

参数是拍脑袋定的，得靠实跑。`profile.js` 里每个数字都有注释说明意图，改之前先看注释。

几个一眼能改的：

| 参数 | 影响 |
|---|---|
| `idle-away.delta` | 每小时攒多少委屈。现在是 0.05，一天没人理大约稳在 0.45 |
| `emotions.upset.halfLife` | 委屈留多久。现在 6 小时 |
| `tiers[0].below` | 多难过才算「不痛快」。现在 0.25 |
| `gates.touch.cold.respond` | 冷战期还理你的概率。现在 0.3 |

改完跑 `npm test`，二十来条用例覆盖了「委屈攒够才转成气」「冷战里被摸更委屈」「说话能哄好」这几条业务约定，改坏了会当场红。

---

## 现在做到哪一步

- [x] 账本、衰减、档位、闸门、状态持久化
- [x] 情绪卡拼进投递
- [x] 触摸、说话、窥屏、空闲四个信号源
- [x] `GET /mood`、`POST /mood`、`node cli/pet.mjs mood [reset]`
- [x] 二十来条单测
- [x] 闸门机制：冷战期按概率不投递，`moodGates: true` 才生效。延迟卡在 3 秒内，免得壳子的请求超时
- [x] 主动消息频率跟着 `proactive.intervalFactor` 走（窥屏每次排期都现问一次，夹在 0.2~6 倍之间）
- [x] 托盘「说话 ▸ 心情 · …」显示当前状态，附一行原因，可点「哄好她」
- [ ] 参数实跑调顺，然后打开 `moodGates`
- [ ] 和主会话的 `mood.ps1` 合并成一本账

---

## 开关一览

| 配置 | 默认 | 作用 |
|---|---|---|
| `mood` | `false` | 总开关。关着时整层不加载，行为一个字不变 |
| `moodGates` | `false` | 闸门。打开后冷战期真的会不理人 |
| `moodFile` | `$DSH_HOME/pet-mood.json` | 状态文件位置 |
| `moodTickMs` | `300000` | 多久结算一次衰减并落盘 |

三个开关分开是有意的：先把情绪接上、看几天账本，觉得参数对了再开闸门。一起打开的话，万一半夜参数歪了，第二天起床面对的就是一个不理人的桌宠。
