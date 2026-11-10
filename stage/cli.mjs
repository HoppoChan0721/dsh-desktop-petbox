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
else if (cmd === 'say') await call('/say', { text: rest.join(' '), ms: flags.ms, emotion: flags.emotion, emotionMs: flags['emotion-ms'], motion: flags.motion });
else if (cmd === 'wait') await call('/wait', { ms: flags.ms });
else if (cmd === 'hide') await call('/bubble', { hide: 1 });
else if (cmd === 'motion') await call('/motion', { name: rest[0] || flags.name });
else if (cmd === 'emotion') await call('/emotion', { name: rest[0] || flags.name });
else if (cmd === 'pointer') {
  if (rest[0] === 'reset') await call('/pointer', { reset: 1 });
  else await call('/pointer', { x: rest[0] || 0, y: rest[1] || 0, hold: flags.hold ? 1 : undefined });
} else {
  console.error('用法：state | say <文本> | wait | hide | motion <名字> | emotion <名字> | pointer <x> <y> [--hold] | pointer reset');
  process.exit(2);
}
