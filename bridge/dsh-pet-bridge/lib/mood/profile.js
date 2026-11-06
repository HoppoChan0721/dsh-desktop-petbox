// 情绪定义表 —— 纯数据，没有任何逻辑。
//
// 这份文件是「情绪世界观」的唯一真源。想加一种情绪、改一个衰减速度、换一套触发条件，
// 只改这里，不要动 engine.js。engine 只认字段名，不认情绪叫什么。
//
// ── 字段说明 ─────────────────────────────────────────────────────────────
//   halfLife  半衰期，单位小时。数值越大情绪留得越久。
//   polarity  +1 正面 / -1 负面 / 0 中性。结算 valence 时用。
//   axis      'mood' 参与心情结算（默认）；'bond' 单独成轴，代表关系本身，衰减极慢。
//   drives    这个情绪能驱动什么。tier 决定行为档位，tone 决定语气，expression 决定主动程度。
//             「担心」只给 tone，不推 tier —— 别让心疼也变成冷战。
//   label     给人看的中文名，托盘和 /mood 用。
//   requires  涨上去的前提条件，用来表达「委屈攒够才转成气」这种链式关系。
//             不满足时这条规则直接跳过，不会凭空生气。
//
// ── 条件怎么写 ───────────────────────────────────────────────────────────
//   { path: 'mood.upset', gt: 0.4 }     取值比大小，支持 gt / gte / lt / lte / eq / ne
//   { all: [...] } / { any: [...] } / { not: {...} }
//   { path: 'signal.category', eq: 'leisure' }
//   { fn: (mood, signal, tier) => boolean }   逃生舱，只有配置里允许时才用
//
// 刻意不支持 JS 表达式字符串：那等于把 eval 塞进配置文件，别人不敢改也不好审。

export const SCHEMA_VERSION = 1;

export const DEFAULT_PROFILE = {
  version: SCHEMA_VERSION,

  emotions: {
    joy: { halfLife: 2, polarity: 1, drives: ['tier', 'tone'], label: '开心' },
    moved: { halfLife: 12, polarity: 1, drives: ['tone'], label: '感动' },
    upset: { halfLife: 6, polarity: -1, drives: ['tier', 'tone'], label: '委屈' },
    anger: {
      halfLife: 3,
      polarity: -1,
      drives: ['tier', 'tone', 'expression'],
      label: '生气',
      // 委屈没攒够就只是更委屈，不会转化成气
      requires: { path: 'mood.upset', gt: 0.4 },
    },
    worried: { halfLife: 5, polarity: -1, drives: ['tone'], label: '担心' },
    jealous: { halfLife: 24, polarity: -1, drives: ['tone'], label: '吃醋' },
    bond: { halfLife: 240, polarity: 0, axis: 'bond', drives: [], label: '亲近' },
  },

  // ── 记账规则 ───────────────────────────────────────────────────────────
  // on      signal.kind
  // add     记到哪个情绪上
  // delta   单次金额，乘上 signal.weight。适配器负责把「几小时」换算成 weight
  // reason  给模型看的人话，渲染情绪卡时直接用
  // when    条件，可省
  // clear   顺手清零哪些情绪，用来表达「被哄好了」
  // cooldown 同一个 key 在这段时间内只记一次，防重复。单位毫秒
  // key      去重的依据，从 signal 里取哪个字段，默认 label
  rules: [
    {
      id: 'touch-warm',
      on: 'touch',
      add: 'joy',
      delta: 0.04,
      reason: '被摸了一下',
      when: { path: 'tier', ne: 'cold' },
      cooldown: 2 * 60 * 1000,
      key: 'zone',
    },
    {
      // 冷战期里被摸不是甜，是「现在才来」
      id: 'touch-cold',
      on: 'touch',
      add: 'upset',
      delta: 0.05,
      reason: '现在才来摸我',
      when: { path: 'tier', eq: 'cold' },
      cooldown: 2 * 60 * 1000,
      key: 'zone',
    },
    {
      // 每小时多少钱。半衰期 6 小时的话，一天没人理大约稳在 0.45：
      // 够「不痛快」，但到不了冷战——冷战要靠后面那条看见摸鱼的归因。
      id: 'idle-away',
      on: 'idle',
      add: 'upset',
      delta: 0.05,
      reason: '好久没人理',
      when: { path: 'signal.minutes', gt: 120 },
    },
    {
      // 主人回话 = 一次真心回应，抵掉半天郁闷
      id: 'speech-warm',
      on: 'speech',
      add: 'joy',
      delta: 0.4,
      reason: '主人说话了',
      clear: ['upset', 'anger'],
    },
    {
      // 亲近是关系本身，涨得很慢、掉得也很慢（半衰期十天）。
      // 单独一条规则，不跟 joy 混在一起：被摸一下会开心，但亲近要靠很多次才攒得起来。
      id: 'bond-touch',
      on: 'touch',
      add: 'bond',
      delta: 0.02,
      reason: '',
      cooldown: 10 * 60 * 1000,
      key: 'zone',
    },
    {
      // 说句话才是真亲近。主人愿意跟你讲话，比摸十下都算数。
      id: 'bond-speech',
      on: 'speech',
      add: 'bond',
      delta: 0.06,
      reason: '',
      cooldown: 10 * 60 * 1000,
    },
    {
      // 委屈攒够 + 看见在玩 = 这条链的终点
      id: 'scene-leisure-hurt',
      on: 'scene',
      add: 'anger',
      delta: 0.45,
      reason: '看见主人没干正事',
      when: {
        all: [
          { path: 'signal.category', eq: 'leisure' },
          { path: 'mood.upset', gt: 0.4 },
        ],
      },
      cooldown: 60 * 60 * 1000,
      key: 'label',
    },
    {
      id: 'scene-work-moved',
      on: 'scene',
      add: 'moved',
      delta: 0.35,
      reason: '看见主人在忙',
      when: { path: 'signal.category', eq: 'work' },
      cooldown: 60 * 60 * 1000,
      key: 'label',
    },
    {
      id: 'scene-late-worried',
      on: 'scene',
      add: 'worried',
      delta: 0.25,
      reason: '这么晚还在玩',
      when: {
        all: [
          { path: 'signal.category', eq: 'leisure' },
          { path: 'signal.night', eq: true },
        ],
      },
      cooldown: 3 * 60 * 60 * 1000,
      key: 'label',
    },
  ],

  // ── 档位 ───────────────────────────────────────────────────────────────
  // 从「负面总值」切档。上调立即生效，下调要低于 threshold * hysteresis，
  // 不然情绪在阈值边上会来回跳，看着像抽风。
  tiers: [
    { name: 'calm', below: 0.25 },
    { name: 'sulky', below: 0.6 },
    { name: 'cold' },
  ],
  hysteresis: 0.8,

  // ── 闸门 ───────────────────────────────────────────────────────────────
  // 消费方问「现在能不能做某事」，这里是唯一的答案来源。
  // 只描述行为差异，不描述怎么实现——桥要不要真的不投递，是消费方的决定。
  gates: {
    touch: {
      calm: { respond: 1 },
      sulky: { respond: 0.75, extraDelayMs: 4000 },
      cold: { respond: 0.3, extraDelayMs: 20000 },
    },
    proactive: {
      calm: { intervalFactor: 1 },
      sulky: { intervalFactor: 0.5 },
      cold: { intervalFactor: 3 },
    },
  },

  // ── 渲染 ───────────────────────────────────────────────────────────────
  // 情绪卡的最大长度和条数，防止提示词被写爆
  cue: {
    maxReasons: 3,
    closedLine: true,
  },
};

export default DEFAULT_PROFILE;
