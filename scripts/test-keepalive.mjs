// 语音服务保活的单测：不碰真服务，用一个本地 http 假装 /health。
// 重点是三件事：探不到就报 down、通了才热身、她自己说过话就不再白热一次。
import http from 'node:http';
import { createKeepAlive } from '../stage/keepalive.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
}

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, url: 'http://127.0.0.1:' + port + '/health', close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

const up = await listen((req, res) => { res.writeHead(200); res.end('{"status":"ok"}'); });
const dead = await listen(() => {});
await dead.close();   // 拿一个能保证连不上的端口
const deadUrl = dead.url;

// 1. 服务在 + 需要热身 → 热身一次，wav 删掉
{
  const warmed = [];
  const dropped = [];
  const ka = createKeepAlive({
    healthUrl: up.url,
    prepareVoice: async (text) => { warmed.push(text); return { job_id: 'abc' }; },
    dropWav: (id) => dropped.push(id),
  });
  const st = await ka.tick();
  ok('热身只发一句短词', warmed.length === 1 && warmed[0].length <= 2, warmed);
  ok('热身完 = warm', st.state === 'warm', st.state);
  ok('热身 wav 要删', dropped.length === 1 && dropped[0] === 'abc', dropped);

  // 再探一次：已经热了，不再热身
  const st2 = await ka.tick();
  ok('热了就不重复热身', warmed.length === 1 && st2.state === 'warm', { warmed: warmed.length, state: st2.state });
}

// 2. 服务不在 + 没有拉起脚本 + 没有 TTS 桥 → down，别装作没事
{
  const ka = createKeepAlive({
    healthUrl: deadUrl,
    startScript: '',
    prepareVoice: null,
  });
  const st = await ka.tick();
  ok('连不上 = down', st.state === 'down', st.state);
  ok('down 要写清原因', typeof st.lastError === 'string' && st.lastError.length > 0, st.lastError);
}

// 2b. 拉起脚本顶不住时，走 TTS 桥自己拉起服务那条路（voice-say.ps1 本来就会起服务）
{
  let warmed = 0;
  const ka = createKeepAlive({
    healthUrl: deadUrl,
    startScript: '',                // 没有拉起脚本 → 只能靠桥
    prepareVoice: async () => { warmed++; return { job_id: 'f1' }; },
    dropWav: () => {},
  });
  const st = await ka.tick();
  ok('靠桥热起来 = warm', st.state === 'warm' && warmed === 1, { state: st.state, warmed });
}

// 3. 说过话之后不热身（模型本来就热着）
{
  let calls = 0;
  const ka = createKeepAlive({
    healthUrl: up.url,
    prepareVoice: async () => { calls++; return { job_id: 'z' }; },
  });
  ka.noteSay();
  const st = await ka.tick();
  ok('说过话就不热身', calls === 0 && st.state === 'warm', { calls, state: st.state });
}

// 4. 关掉保活 → off，一次请求都不发
{
  let calls = 0;
  const ka = createKeepAlive({
    enabled: false,
    healthUrl: up.url,
    prepareVoice: async () => { calls++; return { job_id: 'y' }; },
  });
  const st = ka.start({ intervalMs: 60000 });
  ok('关着 = off', st.state === 'off', st.state);
  ok('关着不热身', calls === 0, calls);
  ka.stop();
}

// 5. 热身失败不重试（桥脚本没装这种，每分钟撞一次是白撞）
{
  let calls = 0;
  const ka = createKeepAlive({
    healthUrl: up.url,
    prepareVoice: async () => { calls++; throw new Error('没有 TTS 桥脚本'); },
  });
  const st1 = await ka.tick();
  ok('热身失败记错误', st1.lastError && st1.lastError.includes('桥'), st1.lastError);
  const st2 = await ka.tick();
  ok('失败后不反复撞', calls === 1, calls);
  ok('状态回 up', st2.state === 'up', st2.state);
}

await up.close();
console.log((fail ? 'FAIL' : 'ok') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
