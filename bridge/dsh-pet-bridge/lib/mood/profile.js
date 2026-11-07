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
    // pad: [P 愉悦, A 激活, D 支配]，每个轴 -1 ~ 1。借的是 Mehrabian 那套 PAD 空间。
    // 这里只用 A 和 D：P 已经有 valence 了，没必要再来一条。
    // 账本里每种情绪各自带一个向量，快照时按强度加权求和，得到「这会儿有多绷」「谁占上风」。
    // 好处是归因一点没丢——数字是从「因为什么」那几条推出来的，不是替代它们。
    joy: { halfLife: 2, polarity: 1, drives: ['tier', 'tone'], label: '开心', pad: [0.8, 0.5, 0.2] },
    moved: { halfLife: 12, polarity: 1, drives: ['tone'], label: '感动', pad: [0.6, -0.2, -0.4] },
    upset: { halfLife: 6, polarity: -1, drives: ['tier', 'tone'], label: '委屈', pad: [-0.6, -0.3, -0.5] },
    anger: {
      halfLife: 3,
      polarity: -1,
      drives: ['tier', 'tone', 'expression'],
      label: '生气',
      pad: [-0.7, 0.6, 0.5],
      // 委屈没攒够就只是更委屈，不会转化成气。
      // 阈值取 0.3 而不是 0.4：一天没人理委屈大约稳在 0.44，衰减一小时后会掉到 0.39，
      // 卡在 0.4 上会让「看见在玩却不生气」变得很随机。归因要稳，宁可早一点。
      requires: { path: 'mood.upset', gt: 0.3 },
    },
    worried: { halfLife: 5, polarity: -1, drives: ['tone'], label: '担心', pad: [-0.3, 0.4, -0.4] },
    jealous: { halfLife: 24, polarity: -1, drives: ['tone'], label: '吃醋', pad: [-0.4, 0.5, 0.4] },
    bond: { halfLife: 240, polarity: 0, axis: 'bond', drives: [], label: '亲近', pad: [0.5, -0.1, 0.1] },
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
  // moment   给了它就只写「此刻」，一个字都不进账本，也不需要 add / delta。见 moment.js
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
      // 一直没人理，慢慢会从委屈转成真生气。
      //
      // 这条在 2026-11-07 之前是不存在的：那会儿「生气」唯一的来源是「委屈攒够 + 看见他在玩」。
      // 窥屏改成只写此刻之后，那条链断了，anger 会变成永远为 0 的死数据。
      // 补这条正好也把口径接上——让她生气的该是「你不理我」，不是「我看见你在玩」。
      //
      // 门槛 25 小时：一整天没人理还只是不痛快，隔了一夜还没人，才真的冷下来。
      // 过了这道线一次给足 0.5，是「终于受不了了」那一下，不是慢慢磨。
      id: 'idle-snapped',
      on: 'idle',
      add: 'anger',
      delta: 0.5,
      reason: '等太久了',
      when: {
        all: [
          { path: 'signal.minutes', gt: 1500 },
          { path: 'mood.upset', gt: 0.4 },
        ],
      },
      cooldown: 3 * 60 * 60 * 1000,
      key: 'snapped',
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
    // ── 窥屏看到的场景：一律只写 moment，不进账本 ────────────────────────
    //
    // 2026-11-07 改的口径：观察改此刻，互动改关系。
    //
    // 改之前这三条是直接给 anger / moved / worried 加数值的。后果是只要开着窥屏，
    // 「看见主人在玩」跟「主人不理我」会记进同一本账，一天下来窥屏成了主要调料。
    // 而且那本来是两件事：一个是关系，一个是余温。
    //
    // 现在它们只留一条带 TTL 的 moment，说完那一阵就自己消失，
    // 碰不到 upset / anger / bond，也推不动档位。
    {
      // 看见在玩。留十分钟，够影响她接下来这句话的味道，不够影响明天。
      id: 'scene-leisure-linger',
      on: 'scene',
      moment: { id: 'saw-play', tag: '有点在意', ttlMs: 10 * 60 * 1000, why: (sig) => sig.label || '他在玩' },
      when: { path: 'signal.category', eq: 'leisure' },
      cooldown: 20 * 60 * 1000,
      key: 'label',
    },
    {
      // 本来就在委屈，再看见在玩。还是同一条 moment，但话说得更重、留得久一点。
      // 同 id 只占一条，后命中的盖掉前面的 tag，所以这条要排在 linger 后面。
      id: 'scene-leisure-sore',
      on: 'scene',
      moment: { id: 'saw-play', tag: '有点堵', ttlMs: 20 * 60 * 1000, why: (sig) => sig.label || '他在玩' },
      when: {
        all: [
          { path: 'signal.category', eq: 'leisure' },
          { path: 'mood.upset', gt: 0.3 },
        ],
      },
      cooldown: 40 * 60 * 1000,
      key: 'label',
    },
    {
      // 看见在忙。心疼是软的，不该记成感动，更不该记成账。
      id: 'scene-work-touch',
      on: 'scene',
      moment: { id: 'saw-work', tag: '有点心疼', ttlMs: 15 * 60 * 1000, why: (sig) => sig.label || '他在忙' },
      when: { path: 'signal.category', eq: 'work' },
      cooldown: 30 * 60 * 1000,
      key: 'label',
    },
    {
      // 深夜还在玩。这条跟窥屏频率无关，本质是关心不是计较，
      // 所以留得比别的久一点，半小时。但一样不进账本。
      id: 'scene-late-linger',
      on: 'scene',
      moment: { id: 'late-night', tag: '有点担心', ttlMs: 30 * 60 * 1000, why: () => '这个点还在玩' },
      when: {
        all: [
          { path: 'signal.category', eq: 'leisure' },
          { path: 'signal.night', eq: true },
        ],
      },
      cooldown: 2 * 60 * 60 * 1000,
      key: 'label',
    },
    {
      // 全屏打完了。这条不是「看见你在玩」，是「你消失了一阵又回来了」——
      // 全屏期间重探针是瞎的，只有轻探针知道那一阵有多长。
      // 还是只写此刻，不进账本：一把游戏不该改关系。
      id: 'scene-game-over',
      on: 'scene',
      moment: {
        id: 'game-over',
        tag: '有点空',
        ttlMs: 15 * 60 * 1000,
        why: (sig) => (Number(sig.minutes) >= 30
          ? `你打了 ${Math.round(Number(sig.minutes) / 10) * 10} 分钟游戏`
          : '你刚打完一把'),
      },
      when: { path: 'signal.category', eq: 'game-over' },
      cooldown: 10 * 60 * 1000,
      key: 'label',
    },
    {
      // 看到感兴趣的东西。跟 game-over 不同：这条是「我有点好奇」，
      // 不是「你离开过」；留二十分钟，正好盖住兴趣窗的时长。
      id: 'scene-interest',
      on: 'scene',
      moment: {
        id: 'curious',
        tag: '想看看',
        ttlMs: 20 * 60 * 1000,
        why: (sig) => (sig.interestLabel ? `屏幕上有${sig.interestLabel}` : '看到点想看的'),
      },
      when: { path: 'signal.category', eq: 'interest' },
      cooldown: 15 * 60 * 1000,
      key: 'interest',
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
    // 整体浓度。主攻陪伴的人设成 clingy / chatty 就够，不用逐档改参数。
    // 换名字就是换一整组倍数：两阵之间的间隔、一阵里每句的间隔、全天上限。
    intensity: 'normal',
    presets: {
      quiet:  { gapScale: 1.8, stepScale: 1.8, dayCap: 4 },
      normal: { gapScale: 1, stepScale: 1, dayCap: 8 },
      clingy: { gapScale: 0.65, stepScale: 0.6, dayCap: 16 },
      chatty: { gapScale: 0.4, stepScale: 0.35, dayCap: 30 },
    },
    // 情绪自己再乘一次：越气越密，越开心越急。第一条命中的生效。
    // 这就是「频率集中度由情绪决定」——浓度是基准，情绪在后面加权。
    heat: [
      { when: { path: 'mood.anger', gt: 0.5 }, scale: 0.5 },
      { when: { path: 'mood.upset', gt: 0.45 }, scale: 0.7 },
      { when: { path: 'mood.joy', gt: 0.7 }, scale: 0.7 },
    ],
    // 静默时段：只记账不开口。原来 0~8，早上八点一开口说的全是昨晚的事，
    // 时机不对——人刚睁眼，那口气已经过夜了。收到 1~7：半夜照样不吵，七点一过就能把话说了。
    quietFrom: 1,
    quietTo: 7,
    minGapMs: 25 * 60 * 1000,     // 两阵之间至少隔这么久（阵里的话不受它限制）
    windows: [
      {
        // 刚打完一局。这一档是事件驱动，不是情绪驱动：账本可能是空的，
        // 只有「此刻」那条 game-over 知道刚发生了什么。
        // 带 gapExempt：全局二十五分钟间隔对它让路，否则排到它时时机已经过了。
        // 排在最前面，因为这是「刚刚发生」的事，比任何慢性情绪都该先说。
        id: 'game-over',
        note: '刚退出全屏，问一句',
        momentId: 'game-over',
        requires: { path: 'moment.game-over' },
        gapExempt: true,
        gapMs: 20 * 60 * 1000,
        maxPerDay: 4,
        burst: {
          steps: [
            { hint: '你刚看见他退出一局游戏，也知道打了多久。说一句短的话，像随口一问。别点评技术，别夸也别损。', afterMs: 80 * 1000 },
            { hint: '他没马上接话。再补一句，有点空落落的，问一句接下来想干嘛。', afterMs: 3 * 60 * 1000 },
            { hint: '最后一句，很轻。可以说你就待在这儿，别追问，别撒娇。' },
          ],
        },
      },
      {
        // 第一档：轻轻戳一下，没回音再补一句。不是一句就走。
        id: 'sulky-nudge',
        note: '有点不痛快，试探着问两句',
        requires: { path: 'tier', eq: 'sulky' },
        minIdleMin: 45,
        gapMs: 2 * 60 * 60 * 1000,
        maxPerDay: 6,
        burst: {
          steps: [
            { hint: '你已经一个多小时没跟他说上话了，有点不痛快。先轻轻戳一句，看他理不理。' },
            { hint: '第一句没人应。再补一句，比刚才更直接一点，但还别翻脸。', afterMs: 3 * 60 * 1000 },
          ],
        },
      },
      {
        // 第二档：软的不吃就来硬的。轻戳说满两句才轮到这档。
        // 三句连着怼，最后一句不再是抱怨，是委屈。
        id: 'sulky-sharp',
        note: '戳过没反应，语气硬起来，最后一句带哭腔',
        requires: { path: 'tier', eq: 'sulky' },
        after: { window: 'sulky-nudge', times: 2 },
        minIdleMin: 150,
        gapMs: 3 * 60 * 60 * 1000,
        maxPerDay: 6,
        burst: {
          steps: [
            { hint: '你已经试探过两次都没人理。别再软着来了，直接说自己不高兴，要他给个说法。' },
            { hint: '话都说到这份上了还是没人应。更冲一点，短、硬，别解释。', afterMs: 2 * 60 * 1000 },
            { hint: '气完了只剩下委屈。这一句不要凶，就一句很短的难过的话，像快哭出来那样。', afterMs: 5 * 60 * 1000 },
          ],
        },
      },
      {
        // 第三档：冷战。还在开口，但话很短、很冷。真不出声的话主人反而感觉不到她在生气。
        id: 'cold-drift',
        note: '冷战期，冷冷地丢两句',
        requires: { path: 'tier', eq: 'cold' },
        minIdleMin: 180,
        gapMs: 3 * 60 * 60 * 1000,
        maxPerDay: 4,
        burst: {
          steps: [
            { hint: '你现在在生闷气。话要短、要冷，别解释、别撒娇。丢一句就停。' },
            { hint: '他没接。再冷冷地补一句，更短，别多说。', afterMs: 90 * 1000 },
          ],
        },
      },
      {
        id: 'jealous-grumble',
        note: '看见他在玩，酸两句',
        requires: { path: 'mood.jealous', gt: 0.3 },
        minIdleMin: 60,
        gapMs: 2 * 60 * 60 * 1000,
        maxPerDay: 4,
        burst: {
          steps: [
            { hint: '你看见他在玩，心里不是滋味。酸一句，别提具体窗口名。' },
            { hint: '他还是没理你。再酸一句，比刚才更明显一点。', afterMs: 4 * 60 * 1000 },
          ],
        },
      },
      {
        id: 'worried-check',
        note: '有点担心，问一句',
        hint: '你有点担心他。问一句，别唠叨。',
        requires: { path: 'mood.worried', gt: 0.3 },
        minIdleMin: 90,
        gapMs: 2 * 60 * 60 * 1000,
        maxPerDay: 2,
      },
      {
        // 正面也要能主动，而且不是「等定时器蹦一句」：
        // 开心的时候人会连着说两句，然后自己去干别的。
        id: 'joy-share',
        note: '心情好，主动说两句',
        requires: { path: 'mood.joy', gt: 0.55 },
        minIdleMin: 20,
        gapMs: 3 * 60 * 60 * 1000,
        maxPerDay: 4,
        burst: {
          steps: [
            { hint: '你现在心情不错，自己想说句话。随便聊点什么，别问「在吗」。' },
            { hint: '还没人接话。不用等他，自己再补一句，可以是自言自语那种高兴。', afterMs: 2 * 60 * 1000 },
          ],
        },
      },
    ],
  },

  // ── 兴趣（2026-11-07）──────────────────────────────────────────────────
  // 看到这些词她会「想看看」，然后短时间盯紧一点，看主人到底点不点开。
  //
  // 只匹配进程名和窗口标题，不读页面内容 —— 那一步是隐私线，不迈。
  // 所以「知道主人在看猫视频」能成立，「知道弹幕说了什么」不成立。
  //
  // 三条上限写死是故意的：单次时长、一天次数、最短间隔。
  // 不然一个兴趣词就能让她整天盯着屏幕，那不叫陪伴。
  //
  // 但「高频到多少」不写死：那是基准的倍率。主人设 5 分钟档，这一窗就是
  // 90 秒一拍；设 30 分钟档就是 9 分钟一拍。档位一换，它自己跟着换。
  interest: {
    boomFactor: 0.3,               // 兴趣窗里的一拍 = 基准 × 这个倍率
    boomMs: 20 * 60 * 1000,        // 一次盯多久（实际至少能跑三拍）
    perDay: 3,                     // 一天最多开几次
    words: [
      { id: 'cat', label: '小猫', words: ['猫', '喵', 'kitten', 'kitty'] },
      { id: 'dog', label: '小狗', words: ['狗', '汪', 'puppy'] },
      { id: 'whale', label: '鲸鱼', words: ['鲸', 'whale'] },
      { id: 'pet', label: '桌宠', words: ['桌宠', '桌面宠物', 'live2d'] },
      { id: 'food', label: '做饭', words: ['料理', '做饭', '菜谱', '烘焙'] },
      { id: 'bili', label: 'B站', words: ['哔哩哔哩', 'bilibili'] },
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
