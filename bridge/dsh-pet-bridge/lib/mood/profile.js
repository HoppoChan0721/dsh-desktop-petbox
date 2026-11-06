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

/**
 * 把一份外部配置合并到默认表上。
 *
 * 存在的意义：调参不该改代码。别人拉下仓库想把她改得迟钝一点，只要写个 JSON
 * 放进 moodProfile，不用碰这个文件——改代码的人一多，冲突就来了。
 *
 * 合并规则（刻意简单，好预期）：
 *   - 对象按键合并，emotions / gates / cue 再多深一层，加一种情绪不用重写别的
 *   - 数组整体替换，不拼接 —— 规则表拼接会让顺序变得不可控
 *   - 值是 null 的键删掉
 *   - patch 里没写的键保持默认
 *
 * @param {object} base   DEFAULT_PROFILE
 * @param {object} patch  moodProfile 读出来的 JSON
 * @returns {object} 新对象，不改入参
 */
export function mergeProfile(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;

  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) { delete out[key]; continue; }
    if (Array.isArray(value)) { out[key] = value; continue; }

    const cur = base[key];
    const bothPlain = value && typeof value === 'object'
      && cur && typeof cur === 'object' && !Array.isArray(cur);

    if (!bothPlain) { out[key] = value; continue; }

    // 这几个键再深一层：只想改一条规则/一档闸门/一个主动窗口，不用把整张表抄一遍。
    // 注意 windows 是数组，还是会整体替换 —— 数组拼接会让顺序（也就是优先级）变得不可预期。
    if (key === 'emotions' || key === 'gates' || key === 'cue' || key === 'urge') {
      const merged = { ...cur };
      for (const [k, v] of Object.entries(value)) {
        if (v === null) { delete merged[k]; continue; }
        const prev = merged[k];
        merged[k] = (v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev))
          ? { ...prev, ...v }
          : v;
      }
      out[key] = merged;
    } else {
      out[key] = { ...cur, ...value };
    }
  }
  return out;
}

/** 合并后的表还活着吗。坏掉的 profile 宁可不用，也不能让桥起不来。 */
export function isValidProfile(profile) {
  if (!profile || typeof profile !== 'object') return false;
  if (!profile.emotions || typeof profile.emotions !== 'object') return false;
  if (!Object.keys(profile.emotions).length) return false;
  if (!Array.isArray(profile.tiers) || !profile.tiers.length) return false;
  return true;
}

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
      // 委屈没攒够就只是更委屈，不会转化成气。
      // 阈值取 0.3 而不是 0.4：一天没人理委屈大约稳在 0.44，衰减一小时后会掉到 0.39，
      // 卡在 0.4 上会让「看见在玩却不生气」变得很随机。归因要稳，宁可早一点。
      requires: { path: 'mood.upset', gt: 0.3 },
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
      // 对方回话 = 一次真心回应，抵掉半天郁闷
      id: 'speech-warm',
      on: 'speech',
      add: 'joy',
      delta: 0.4,
      reason: '他说话了',
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
      // 说句话才是真亲近。对方愿意跟你讲话，比摸十下都算数。
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
      reason: '看见他在玩',
      when: {
        all: [
          { path: 'signal.category', eq: 'leisure' },
          { path: 'mood.upset', gt: 0.3 },
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
      reason: '看见他在忙',
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

  // ── 主动开口（2026-11-06）───────────────────────────────────────────────
  // 没有这张表，情绪就是个被动效果：只能等被摸、等窥屏到点，她才会有反应。
  // 有了它，情绪高到一定程度她自己会开口——生气不用等人来点才发作。
  //
  // 每一档 window 是一条「开口理由」，从上往下第一条满足的就用，顺序即优先级。
  // 负面排在正面前面：又想发火又想分享的时候，先发火。
  // 语法和字段说明见 urge.js 顶部。
  urge: {
    enabled: true,
    quietFrom: 0,                 // 静默时段只记账不开口
    quietTo: 8,
    minGapMs: 25 * 60 * 1000,     // 任意两次主动之间至少隔 25 分钟
    maxPerDay: 6,                 // 全天总共最多 6 次，防止几档轮流把她变成播报机
    windows: [
      {
        // 第一档：轻轻戳一下。冷落到了一个多小时，先软着来。
        id: 'sulky-nudge',
        note: '有点不痛快，试探着问一句',
        hint: '你已经一个多小时没跟他说上话了，有点不痛快。别直接发火，先轻轻戳一句，看他理不理。',
        requires: { path: 'tier', eq: 'sulky' },
        minIdleMin: 45,
        gapMs: 60 * 60 * 1000,
        maxPerDay: 2,
      },
      {
        // 第二档：软的不吃就来硬的。轻轻戳的次数用完才轮到这档。
        id: 'sulky-sharp',
        note: '戳过两次没反应，语气要硬了',
        hint: '你已经试探过两次都没人理。这次别再软着来了，直接说自己不高兴，要他给个说法。',
        requires: { path: 'tier', eq: 'sulky' },
        after: { window: 'sulky-nudge', times: 2 },
        minIdleMin: 150,
        gapMs: 2 * 60 * 60 * 1000,
        maxPerDay: 2,
      },
      {
        // 第三档：冷战。还在开口，但话很短、很冷。真不出声的话主人反而感觉不到她在生气。
        id: 'cold-drift',
        note: '冷战期，冷冷地丢一句',
        hint: '你现在在生闷气。话要短、要冷，别解释、别撒娇。丢一句就停。',
        requires: { path: 'tier', eq: 'cold' },
        minIdleMin: 180,
        gapMs: 3 * 60 * 60 * 1000,
        maxPerDay: 2,
      },
      {
        id: 'jealous-grumble',
        note: '看见他在玩，酸一句',
        hint: '你看见他在玩，心里不是滋味。酸一句，别提具体窗口名。',
        requires: { path: 'mood.jealous', gt: 0.3 },
        minIdleMin: 60,
        gapMs: 2 * 60 * 60 * 1000,
        maxPerDay: 2,
      },
      {
        id: 'worried-check',
        note: '有点担心，问一句',
        hint: '你有点担心他。问一句，别唠叨。',
        requires: { path: 'mood.worried', gt: 0.3 },
        minIdleMin: 90,
        gapMs: 2 * 60 * 60 * 1000,
        maxPerDay: 1,
      },
      {
        // 正面也要能主动：开心到一定程度，她会自己来找人分享。
        id: 'joy-share',
        note: '心情好，主动来说一句',
        hint: '你现在心情不错，自己想说句话。随便聊点什么，别问「在吗」。',
        requires: { path: 'mood.joy', gt: 0.55 },
        minIdleMin: 20,
        gapMs: 3 * 60 * 60 * 1000,
        maxPerDay: 1,
      },
    ],
  },

  // ── 渲染 ───────────────────────────────────────────────────────────────
  // 情绪卡的最大长度和条数，防止提示词被写爆
  cue: {
    maxReasons: 3,
    closedLine: true,
  },
};

export default DEFAULT_PROFILE;
