// 情绪门面 —— index.js 只跟这个文件打交道，不直接碰 engine / store / cue。
//
// 对外就八个方法，全是「告诉他发生了什么」或「问他要个结论」，没有副作用泄漏：
//
//   createMood({ file, profile, log, now })
//     .touch(evt)        被摸了一下
//     .scene(peekResult) 看见主人在干什么
//     .speech(text)      主人说了句话
//     .cue()             取情绪卡，平静时返回空串
//     .gate(name)        问闸门，返回 { respond, intervalFactor, ... }
//     .state()           给 HTTP / 托盘看的完整快照，含账本
//     .reset()           一键哄好
//     .tick()            结算衰减并落盘，定时器或每次读取前调都行
//
// 把 engine（纯函数）、store（落盘）、signals（翻译）、cue（渲染）粘起来是这里唯一
// 的职责。想换掉任何一层，替换这个文件里的 import 就行，外面的一行不用动。

import { ingest, resolve, gate as gateOf, tick as tickOf } from './engine.js';
import { createStore } from './store.js';
import { DEFAULT_PROFILE, SCHEMA_VERSION } from './profile.js';
import { fromTouch, fromScene, fromSpeech, fromIdle, sceneFromPeek } from './signals.js';
import { render, summarize } from './cue.js';

const IDLE_MIN_MINUTES = 120;        // 少于两小时不算冷落
const IDLE_TICK_MINUTES = 30;        // 每半小时结算一次，别每轮都记

export function createMood({ file = '', profile = DEFAULT_PROFILE, log = () => {}, now = () => Date.now() } = {}) {
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

    /** 给 HTTP / 托盘：快照 + 人话摘要 + 账本 + 最近记录。 */
    state(at = now()) {
      settleIdle(at);
      const snap = resolve(state, profile, at);
      return {
        schemaVersion: SCHEMA_VERSION,
        summary: summarize(snap, profile),
        snapshot: snap,
        log: (state.log || []).slice(-8).reverse(),
      };
    },

    reset(at = now()) {
      state = store.reset(at);
      return resolve(state, profile, at);
    },
  };
}
