// 适配器 —— 把「世界里发生的事」翻译成情绪引擎认识的 signal。
//
// 引擎不认识触摸、窥屏、代码，只认识 { kind, at, weight, ...字段 }。
// 想让情绪跟着别的东西走，在这里加一个 fromXxx，然后把它塞给 engine.ingest 就行，
// 引擎一行都不用改。
//
// signal 约定：
//   kind    必填。'touch' | 'idle' | 'speech' | 'scene'，自己加也行，规则里对上就生效
//   at      时间戳
//   weight  金额倍率，默认 1。适配器负责把「几小时」换算成它
//   其余字段随便带，规则的条件里用 signal.xxx 取

/** 被摸了一下。 */
export function fromTouch(evt, now = Date.now()) {
  return {
    kind: 'touch',
    at: now,
    zone: (evt && evt.zone) || '',
    nx: evt && evt.nx,
    ny: evt && evt.ny,
    weight: 1,
  };
}

/**
 * 一段时间没人理。
 * weight 默认用总空闲小时数；门面会传「距离上次结算」的小时数，避免重复记账时金额翻倍。
 * minutes 始终是总空闲时长，规则里用它判断「够不够久」。
 */
export function fromIdle(minutes, now = Date.now(), weightHours) {
  const fallback = Math.max(0, (Number(minutes) || 0) / 60);
  return {
    kind: 'idle',
    at: now,
    minutes: Number(minutes) || 0,
    weight: Number.isFinite(weightHours) ? Math.max(0, weightHours) : fallback,
  };
}

/** 会话里说了句话。主人的回应一律算正面刺激，清账的事写在规则里。 */
export function fromSpeech(text, now = Date.now()) {
  return { kind: 'speech', at: now, text: String(text || ''), weight: 1 };
}

/**
 * 看见主人在干什么。
 * scene 是 { category, label, night }，category 至少要有 leisure / work / social 三种，
 * 分类由 classifyScene 判定，也可以在配置里覆盖。
 */
export function fromScene(scene, now = Date.now()) {
  return {
    kind: 'scene',
    at: now,
    category: (scene && scene.category) || 'other',
    label: (scene && scene.label) || '',
    night: !!(scene && scene.night),
    weight: 1,
  };
}

// ── 场景分类 ─────────────────────────────────────────────────────────────
// 只认进程名和窗口标题，不读别的东西。表可以整个替换，别改判定逻辑。
// 词表故意写得宽：认错成 other 只是少记一笔，比乱生气好。

export const DEFAULT_SCENE_RULES = {
  work: [
    /deepseek\s*harness/i, /\bdsh\b/i, /visual studio code/i, /\bvscode\b/i, /cursor/i,
    /\bidea\b/i, /pycharm/i, /webstorm/i, /sublime/i, /notepad\+\+/i,
    /windows terminal/i, /powershell/i, /cmd\.exe/i, /git\s*bash/i, /mobaxterm/i,
    /docker/i, /postman/i, /figma/i, /photoshop/i, /word|excel|powerpoint/i, /obsidian/i,
  ],
  leisure: [
    /steam/i, /epic\s*games/i, /\bbattle\.net/i, /uplay/i, /origin/i, /wegame/i,
    /bilibili/i, /哔哩哔哩/i, /youtube/i, /netflix/i, /twitch/i, /抖音|douyin/i,
    /minecraft/i, /\bcs2\b|counter-strike/i, /league of legends|\blol\b/i, /genshin|原神/i,
    /honkai|星穹铁道|崩坏/i, /valorant/i, /dota/i, /apex/i, /pubg/i, /palworld|幻兽帕鲁/i,
  ],
  social: [
    /discord/i, /telegram/i, /\bqq\b/i, /wechat|微信/i, /weibo|微博/i, /twitter|\bx\.com/i,
    /reddit/i, /instagram/i, /\bline\b/i,
  ],
};

/**
 * 判定一个场景属于哪类。
 * @param {{ proc?: string, title?: string, rules?: object }} input
 * @returns {'work'|'leisure'|'social'|'other'}
 */
export function classifyScene({ proc = '', title = '', rules = DEFAULT_SCENE_RULES }) {
  const hay = `${proc} ${title}`;
  if (!hay.trim()) return 'other';
  const order = ['work', 'leisure', 'social'];   // 有歧义时先认正事，宁可少生气
  for (const cat of order) {
    const list = rules[cat] || [];
    if (list.some((re) => re.test(hay))) return cat;
  }
  return 'other';
}

/** 深夜判定。凌晨到早上这段时间玩游戏，记「担心」不记「生气」。 */
export function isNight(now = new Date(), from = 1, to = 6) {
  const h = now.getHours();
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

/** 从窥屏结果拼一个完整 scene。 */
export function sceneFromPeek(peekResult, { rules, now = new Date() } = {}) {
  const proc = (peekResult && peekResult.proc) || '';
  const title = (peekResult && peekResult.title) || '';
  const category = classifyScene({ proc, title, rules });
  return {
    category,
    label: (title || proc || '').slice(0, 40),
    night: isNight(now),
  };
}
