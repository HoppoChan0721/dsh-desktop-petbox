#!/usr/bin/env node
// 舞台的命令行。走 main.js 里那个只监听本机的控制口，跟页面无关。
//
//   node stage/cli.mjs state
//   node stage/cli.mjs say "主人回来啦" --emotion 脸红 --motion HandRaise
//   node stage/cli.mjs motion HandRaise
//   node stage/cli.mjs emotion 脸红
//   node stage/cli.mjs pointer 0 -1 --hold
//   node stage/cli.mjs pointer reset

const PORT = Number(process.env.WHALE_STAGE_PORT || 61945);
const BASE = `http://127.0.0.1:${PORT}`;

const argv = process.argv.slice(2);
const cmd = argv[0] || 'state';

function takeFlags(list) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = list[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[key] = true; }
      else { flags[key] = next; i++; }
    } else rest.push(a);
  }
  return { flags, rest };
}

async function call(pathname, query) {
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== false) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    console.error(`连不上舞台的控制口 ${BASE}，舞台开了吗（--port 对得上吗）`);
    process.exit(1);
  }
  const body = await res.text();
  try { console.log(JSON.stringify(JSON.parse(body), null, 1)); } catch (e) { console.log(body); }
  if (!res.ok) process.exit(1);
}

const { flags, rest } = takeFlags(argv.slice(1));

if (cmd === 'state') await call('/state');
else if (cmd === 'say') await call('/say', { text: rest.join(' '), ms: flags.ms, emotion: flags.emotion, emotionMs: flags['emotion-ms'], motion: flags.motion, voice: flags.voice ? 1 : undefined });
else if (cmd === 'voice') await call('/voice', { job: rest[0] || flags.job });
else if (cmd === 'voice-stop') await call('/voice-stop');
else if (cmd === 'wait') await call('/wait', { ms: flags.ms });
else if (cmd === 'hide') await call('/bubble', { hide: 1 });
else if (cmd === 'motion') {
  if (rest[0] === 'stop') await call('/motion-stop');
  else await call('/motion', { name: rest[0] || flags.name, hold: flags.hold ? 1 : undefined });
}
else if (cmd === 'emotion') await call('/emotion', { name: rest[0] || flags.name });
else if (cmd === 'pointer') {
  if (rest[0] === 'reset') await call('/pointer', { reset: 1 });
  else await call('/pointer', { x: rest[0] || 0, y: rest[1] || 0, hold: flags.hold ? 1 : undefined });
} else if (cmd === 'gaze') {
  if (rest[0] === 'off') await call('/gaze', { track: 0 });
  else if (rest[0] === 'on') await call('/gaze', { track: 1 });
  else if (rest[0] === 'hide') await call('/gaze', { suspend: flags.ms || 8000 });
  else if (rest[0] === 'circle') await call('/gaze', { circle: rest[1] || 2, r: flags.r });
  else await call('/gaze');
} else if (cmd === 'touches') await call('/touches', { n: rest[0] || flags.n });
else if (cmd === 'affinity') await call('/affinity');
else if (cmd === 'mood') {
  // 不带参数 = 跟 mood.json 自动对齐；带了就照给的来
  if (rest[0]) await call('/mood', { emotion: rest[0], intensity: flags.intensity });
  else await call('/mood');
} else if (cmd === 'moods') await call('/moods');
else if (cmd === 'tick') await call('/tick', { text: rest.join(' '), ms: flags.ms });
else if (cmd === 'reply') {
  if (rest[0] === 'open') await call('/reply', { open: 1 });
  else if (rest[0] === 'close') await call('/reply', { open: 0 });
  else if (rest.length) await call('/reply', { text: rest.join(' ') });
  else await call('/reply');
} else if (cmd === 'status') await call('/status');
else if (cmd === 'config') {
  if (rest.length) await call('/config', { json: rest.join(' ') });
  else await call('/config');
} else if (cmd === 'panel') await call('/panel');
else if (cmd === 'menu') await call('/menu');
else {
  console.error('用法：state | say <文本> | wait | hide | motion <名字> [--hold] | motion stop | emotion <名字> | pointer <x> <y> [--hold] | pointer reset | gaze [on|off|hide|circle <圈数>] | touches [n] | affinity | mood [心情] [--intensity 0.8] | moods | tick <文本> [--ms 3000] | reply [文本|open|close] | status | config [json] | panel | menu');
  process.exit(2);
}
