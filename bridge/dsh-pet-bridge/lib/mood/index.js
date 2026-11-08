// 情绪门面 —— index.js 只跟这个文件打交道，不直接碰 engine / store / cue。
//
// 对外就八个方法，全是「告诉他发生了什么」或「问他要个结论」，没有副作用泄漏：
//
//   createMood({ file, profile, log, now })
//     .touch(evt)        被摸了一下
//     .scene(peekResult) 看见使用者在干什么
//     .speech(text)      使用者说了句话
//     .cue()             取情绪卡，平静时返回空串
//     .gate(name)        问闸门，返回 { respond, intervalFactor, ... }
//     .urge()            她这会儿自己想不想开口，返回 { speak, window, hint, idleMin }
//     .markUrge(id)      记一次「真的开口了」，间隔和每日上限靠它算
//     .state()           给 HTTP / 托盘看的完整快照，含账本
//     .reset()           一键哄好
//     .tick()            结算衰减并落盘，定时器或每次读取前调都行
//
// 把 engine（纯函数）、store（落盘）、signals（翻译）、cue（渲染）、urge（冲动）
// 粘起来是这里唯一的职责。想换掉任何一层，替换这个文件里的 import 就行，外面的一行不用动。

import { ingest, resolve, gate as gateOf, tick as tickOf } from './engine.js';
import { createStore } from './store.js';
import { DEFAULT_PROFILE, SCHEMA_VERSION, mergeProfile, isValidProfile } from './profile.js';
import { fromTouch, fromScene, fromSpeech, fromIdle, sceneFromPeek } from './signals.js';
import { render, summarize } from './cue.js';
import { decide as decideUrge, mark as markUrgeOf, interrupt as interruptUrge, summarizeUrge } from './urge.js';
import { summarizeMoments, clearMoments } from './moment.js';
import { createInputProbe } from './input-probe.js';
import { readFileSync } from 'node:fs';

const IDLE_MIN_MINUTES = 120;        // 少于两小时不算冷落
const IDLE_TICK_MINUTES = 30;        // 每半小时结算一次，别每轮都记
const ASLEEP_AFTER_MS = 15 * 60 * 1000; // 键鼠十五分钟没动 = 人不在，这段不算冷落

export function createMood({ file = '', profile: baseProfile = DEFAULT_PROFILE, profileFile = '', urgeIntensity = '', log = () => {}, now = () => Date.now(), probe = null } = {}) {
  // 外置调参：不改代码就能换参数。坏文件退回默认——
  // 调参不该有让桥起不来的能力，这是公共插件的底线。
  let profile = baseProfile;
  if (profileFile) {
    try {
      const merged = mergeProfile(baseProfile, JSON.parse(readFileSync(profileFile, 'utf8')));
      if (isValidProfile(merged)) {
        profile = merged;
        log('mood: profile loaded from ' + profileFile);
      } else {
        log('mood: profile at ' + profileFile + ' unusable, keeping defaults');
      }
    } catch (e) {
      log('mood: profile unreadable (' + (e && e.message) + '), keeping defaults');
    }
  }

  // 浓度旋钮：配置里一个名字就能盖掉 profile 里的 intensity。
  // 「主打陪伴的人想多听她说话」不该逼人写一整份 profile。
  if (urgeIntensity) {
    const name = String(urgeIntensity);
    const presets = (profile.urge && profile.urge.presets) || {};
    if (presets[name]) {
      profile = { ...profile, urge: { ...profile.urge, intensity: name } };
      log('mood: urge intensity = ' + name);
    } else {
      log('mood: unknown urge intensity "' + name + '", keeping ' + ((profile.urge && profile.urge.intensity) || 'normal'));
    }
  }

  const store = createStore({ file, profile, log });
  let state = store.open(now());

  // 人在不在：只有 Windows 的输入空闲能分清「睡着了」和「坐着不理她」。
  // 采不到就如实返回 -1，下面按「不知道」处理——宁可少记一笔委屈，也别凭空生气。
  const inputProbe = probe || createInputProbe({ log });
  if (!probe && typeof inputProbe.start === 'function') inputProbe.start();

  /** 把「键鼠一直没动」的时段累进 state.asleepMs。只在拿到新的采样点时推进。 */
  function sampleAsleep() {
    const snap = (inputProbe && typeof inputProbe.current === 'function') ? inputProbe.current() : null;
    if (!snap || !snap.sampledAt || !(snap.idleMs >= 0)) return;
    const prev = state.lastProbeSampleAt || 0;
    if (snap.sampledAt <= prev) return;
    if (snap.idleMs >= ASLEEP_AFTER_MS) {
      const delta = prev ? Math.max(0, snap.sampledAt - prev) : 0;
      // 窗口比采样间隔长，说明至少这一整段都没人碰键鼠。
      state.asleepMs = (state.asleepMs || 0) + Math.min(delta, snap.idleMs);
    }
    state.lastProbeSampleAt = snap.sampledAt;
  }

  /** 把「一直没人理」换算成 idle 信号。间隔多久都按实际小时数补，重启也不丢。 */
  function settleIdle(at) {
    sampleAsleep();
    const last = state.lastInteractionAt || 0;
    if (!last) return;
    const idleMin = (at - last) / 60000;
    if (idleMin < IDLE_MIN_MINUTES) return;

    // 睡觉那段不算冷落。账本记的是「人坐在前面却没人理」，不是「过了多少小时」。
    const asleepMin = Math.min(idleMin, (state.asleepMs || 0) / 60000);
    const activeIdleMin = Math.max(0, idleMin - asleepMin);

    const lastCount = state.lastIdleCountAt || (last + IDLE_MIN_MINUTES * 60000);
    const gapMin = (at - lastCount) / 60000;
    if (gapMin < IDLE_TICK_MINUTES) return;

    // 一整夜睡过去，醒来活跃时长可能还不够两小时，那就先不记这笔。
    if (activeIdleMin < IDLE_MIN_MINUTES) {
      state.lastIdleCountAt = at;
      return;
    }

    const share = idleMin > 0 ? activeIdleMin / idleMin : 0;
    state = ingest(state, fromIdle(activeIdleMin, at, (gapMin / 60) * share), profile, at);
    state.lastIdleCountAt = at;
  }

  function tick(at = now()) {
    settleIdle(at);
    state = tickOf(state, profile, at);
    store.save(state);
    return state;
  }

  function record(signal, at = now()) {
    settleIdle(at);
    state = ingest(state, signal, profile, at);
    // 主人来了就别接着怼了。一阵话说到一半被打断，剩下的不该再补——
    // 已经在生气的人被摸一下还没消气，是很正常的事；继续念第三句才是程序。
    if (signal && (signal.kind === 'touch' || signal.kind === 'speech')) {
      state = interruptUrge(state);
      // 人来了，从这一刻重新数「多久没人理」，睡觉的账一笔勾销。
      state.asleepMs = 0;
    }
    // 真的开口说话，比什么都算数：之前「瞄到一眼」留下的余温当场翻篇。
    // 触摸不算——摸一下不代表他想聊，那点在意留着就留着。
    if (signal && signal.kind === 'speech') {
      state = { ...state, moments: clearMoments() };
    }
    store.save(state);
    return state;
  }

  return {
    get profile() {
      return profile;
    },

    touch(evt, at = now()) {
      return record(fromTouch(evt, at), at);
    },

    speech(text, at = now()) {
      return record(fromSpeech(text, at), at);
    },

    /** 窥屏结果。传原始探针 JSON 即可，分类在这里做。 */
    peekScene(peekResult, at = now()) {
      const scene = sceneFromPeek(peekResult, { now: new Date(at) });
      // 认不出来的窗口不记账：少记一笔比乱生气好
      if (scene.category === 'other') return state;
      return record(fromScene(scene, at), at);
    },

    /** 直接喂一个已经分好类的场景，方便测试和外部接入。 */
    scene(scene, at = now()) {
      return record(fromScene(scene, at), at);
    },

    tick,

    // 读的时候也顺带结算一次「多久没人理」。这一步是幂等的：半小时内重复读不会重复记账，
    // 所以定时器挂了也不会让情绪停在原地。落盘仍然只发生在 tick / record 里。
    snapshot(at = now()) {
      settleIdle(at);
      return resolve(state, profile, at);
    },

    cue(at = now(), opts = {}) {
      settleIdle(at);
      return render(resolve(state, profile, at), profile, opts);
    },

    gate(name, at = now()) {
      settleIdle(at);
      return gateOf(resolve(state, profile, at), profile, name);
    },

    /** 她现在自己想不想开口。只读，不写账本。 */
    urge(at = now()) {
      settleIdle(at);
      return decideUrge(resolve(state, profile, at), state, profile, at);
    },

    /**
     * 真的开口了才记这一笔。投递失败就别记，下一轮还能重来。
     * 传的是 urge() 给出的那份决定：里面已经算好了下一句什么时候说。
     */
    markUrge(decision, at = now()) {
      state = markUrgeOf(state, decision, at);
      store.save(state);
      return state;
    },

    /**
     * 换浓度。这是唯一一个会在运行时改 profile 的方法——
     * 「能不能多听她说两句」是最该随手拨的开关，不该逼人重启。
     * 名字不认识就原样不动，返回可选名单。
     */
    setIntensity(name) {
      const presets = (profile.urge && profile.urge.presets) || {};
      const list = Object.keys(presets);
      const key = String(name || '');
      if (!presets[key]) return { ok: false, error: 'unknown intensity', options: list };
      profile = { ...profile, urge: { ...profile.urge, intensity: key } };
      return { ok: true, intensity: key, options: list };
    },

    /** 给 HTTP / 托盘：快照 + 人话摘要 + 账本 + 最近记录。 */
    state(at = now()) {
      settleIdle(at);
      const snap = resolve(state, profile, at);
      return {
        schemaVersion: SCHEMA_VERSION,
        summary: summarize(snap, profile),
        snapshot: snap,
        urge: summarizeUrge(state, profile, at),
        // 「此刻」的余温：窥屏留下的短时状态，跟账本分开显示，托盘上分得清
        moments: summarizeMoments(state.moments, at),
        // 有没有可恢复的备份。托盘靠它决定要不要显示「恢复上一次账本」
        backup: store.hasBackup(),
        log: (state.log || []).slice(-8).reverse(),
      };
    },

    /**
     * 哄好她：只清负面，保留亲近和好心情。
     *
     * 名字和行为得对上。以前这个方法叫 reset，清的是整本账——连亲近度都归零，
     * 那是「重新认识」，不是「哄一下」。主人 2026-11-07 指出菜单写着哄好、
     * 实际在洗号。现在负面的清零，正面和 bond 原样留着。
     *
     * 顺手把一阵没说完的话掐掉：哄好了还接着念第三句，那不是人。
     */
    calm(at = now()) {
      state = tickOf(state, profile, at);
      const kept = {};
      const cleared = [];
      for (const [name, entry] of Object.entries(state.emotions || {})) {
        const def = profile.emotions[name];
        const negative = def && Number(def.polarity) < 0;
        if (negative) { kept[name] = { value: 0, at }; cleared.push(name); }
        else kept[name] = entry;
      }
      state = interruptUrge({ ...state, emotions: kept, cooldowns: {} });
      state = tickOf(state, profile, at);   // 重算档位：从冷战回到平静
      store.save(state);
      return { state: resolve(state, profile, at), cleared };
    },

    /** 彻底重来：整本清空。清之前先存一份备份，点错了能捞回来。 */
    resetAll(at = now()) {
      const backup = store.backup();
      state = store.reset(at);
      return { state: resolve(state, profile, at), backup };
    },

    /** 从上一份备份恢复。没有备份或者版本不认识就如实失败。 */
    restoreBackup(at = now()) {
      const r = store.restore();
      if (!r.ok) return { ok: false, error: r.error };
      state = tickOf(r.state, profile, at);
      store.save(state);
      return { ok: true, state: resolve(state, profile, at) };
    },

    hasBackup() {
      return store.hasBackup();
    },

    /** 老名字，等价于彻底重来。留着给 CLI 和外部脚本，菜单不再用它。 */
    reset(at = now()) {
      return this.resetAll(at).state;
    },
  };
}
