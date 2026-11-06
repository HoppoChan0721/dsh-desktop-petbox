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
import { readFileSync } from 'node:fs';

const IDLE_MIN_MINUTES = 120;        // 少于两小时不算冷落
const IDLE_TICK_MINUTES = 30;        // 每半小时结算一次，别每轮都记

export function createMood({ file = '', profile: baseProfile = DEFAULT_PROFILE, profileFile = '', urgeIntensity = '', log = () => {}, now = () => Date.now() } = {}) {
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

  /** 把「一直没人理」换算成 idle 信号。间隔多久都按实际小时数补，重启也不丢。 */
  function settleIdle(at) {
    const last = state.lastInteractionAt || 0;
    if (!last) return;
    const idleMin = (at - last) / 60000;
    if (idleMin < IDLE_MIN_MINUTES) return;

    const lastCount = state.lastIdleCountAt || (last + IDLE_MIN_MINUTES * 60000);
    const gapMin = (at - lastCount) / 60000;
    if (gapMin < IDLE_TICK_MINUTES) return;

    state = ingest(state, fromIdle(idleMin, at, (gapMin / 60)), profile, at);
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

    cue(at = now()) {
      settleIdle(at);
      return render(resolve(state, profile, at), profile);
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
        log: (state.log || []).slice(-8).reverse(),
      };
    },

    reset(at = now()) {
      state = store.reset(at);
      return resolve(state, profile, at);
    },
  };
}
