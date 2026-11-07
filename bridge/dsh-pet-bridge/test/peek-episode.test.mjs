// 全屏 episode 的自检。
//
// 这一层的价值全在判定上：切窗口闪一下算不算结束、打两分钟算不算一局。
// 真探针要起 PowerShell 测不了，所以判定抽成了纯函数 trackEpisode。
//
//   node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trackEpisode } from '../lib/peek.js';
import { createMood } from '../lib/mood/index.js';

const T0 = 1700000000000;
const min = (n) => n * 60000;
const fresh = () => ({ active: false, since: 0, title: '', proc: '', lastSeenAt: 0, misses: 0 });
const on = (title = 'Starcraft II') => ({ fullscreen: true, title, proc: 'SC2' });
const off = () => ({ fullscreen: false, title: '资源管理器', proc: 'explorer' });

test('全屏开始到退出，报出打了多久', () => {
  const ep = fresh();
  assert.equal(trackEpisode(ep, on(), T0), null);
  assert.equal(ep.active, true);

  trackEpisode(ep, on(), T0 + min(40));
  assert.equal(trackEpisode(ep, off(), T0 + min(41)), null, '第一拍先不算');
  const done = trackEpisode(ep, off(), T0 + min(42));
  assert.ok(done, '连续两拍不是全屏才算真出来');
  assert.equal(done.minutes, 40);
  assert.equal(ep.active, false);
  assert.equal(ep.misses, 0);
});

test('切窗口闪一下不算打完', () => {
  const ep = fresh();
  trackEpisode(ep, on(), T0);
  trackEpisode(ep, on(), T0 + min(20));

  assert.equal(trackEpisode(ep, off(), T0 + min(21)), null);
  assert.equal(ep.active, true, '闪一下还在局里');

  // 又回到全屏：刚才那一下作废，次数要重新数
  trackEpisode(ep, on(), T0 + min(22));
  assert.equal(ep.misses, 0);
  assert.equal(trackEpisode(ep, off(), T0 + min(23)), null, '重新数第一拍');
  assert.equal(ep.active, true);
});

test('只打两分钟不算一局，但状态要复位', () => {
  const ep = fresh();
  trackEpisode(ep, on(), T0);
  trackEpisode(ep, on(), T0 + min(2));
  trackEpisode(ep, off(), T0 + min(2.1));
  assert.equal(trackEpisode(ep, off(), T0 + min(2.2)), null);
  assert.equal(ep.active, false, '太短不上报，但 episode 该收掉');
});

test('瞄到桌宠自己时整拍跳过，不结束 episode', () => {
  const ep = fresh();
  trackEpisode(ep, on(), T0);
  assert.equal(trackEpisode(ep, { fullscreen: false, pet: true }, T0 + min(10)), null);
  assert.equal(ep.active, true);
  assert.equal(ep.misses, 0, '瞄到自己不算主人退出全屏');
});

test('打完一局只留一条此刻，账本一个数都不动', () => {
  const mood = createMood({ file: '', log: () => {}, now: () => T0 });
  mood.scene({ category: 'game-over', label: 'Starcraft II', minutes: 40 }, T0);
  const st = mood.state(T0);
  assert.equal(st.moments.count, 1);
  assert.equal(st.moments.top.id, 'game-over');
  assert.match(st.moments.top.why, /40 分钟/, '要说清打了多久');
  assert.equal(mood.snapshot(T0).values.anger, 0, '一把游戏不该改关系');
  assert.equal(mood.snapshot(T0).values.upset, 0);
});
