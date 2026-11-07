// 极简演示：一条命令把「她会说话 / 有情绪 / 会看屏幕 / 能点能拖」演一遍，录屏就完事。
//
//   node scripts/demo-minimal.mjs --warm    # 先热一下 TTS，不然第一句要等二十多秒
//   node scripts/demo-minimal.mjs           # 正式演一遍，全程约 75 秒
//   node scripts/demo-minimal.mjs --dry     # 只走流程不出声，检查端口通不通
//
// 设计原则：不剪辑。所以每一拍都等「上一句真的说完了」再往下走（轮询 /status 的 voicing），
// 而不是写死秒数——TTS 快慢不定，写死必然错位。控制台会打印每一拍的时间，录制时对着看。
const PET = process.env.WHALE_PET_SHELL || 'http://127.0.0.1:61943';
const BRIDGE = process.env.WHALE_PET_BRIDGE || 'http://127.0.0.1:61944';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const WARM = argv.includes('--warm');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(3, ' ');
const log = (s) => console.log(`[${el()}s] ${s}`);
const star = (s) => console.log(`\n[${el()}s] ── ${s} ──\n`);

async function req(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}
const get = (u) => req('GET', u);
const post = (u, b) => req('POST', u, b);

async function alive() {
  try {
    const s = await get(PET + '/status');
    if (!s || s.ok !== true) throw new Error('壳子没回 ok');
    let bridge = false;
    try { bridge = !!(await get(BRIDGE + '/health')).ok; } catch {}
    return { pet: true, bridge };
  } catch (e) {
    return { pet: false, bridge: false, error: e.message };
  }
}

// 说一句，并等她真的说完（合成 + 播放）
async function say(text, emotion, wait = true) {
  log(`她说：${text}`);
  if (DRY) return;
  await post(PET + '/say', { text, emotion, voice: true }).catch((e) => log('say 失败：' + e.message));
  if (!wait) return;
  await sleep(1500);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const st = await get(PET + '/status').catch(() => null);
    if (!st || st.voicing !== true) break;
    await sleep(500);
  }
  await sleep(700);
}

async function mood(name) {
  log(`情绪：${name}`);
  if (DRY) return;
  await post(PET + '/mood', { emotion: name, intensity: 0.9 }).catch(() => {});
  await sleep(1200);
}

// 让桥立刻瞄一眼屏幕，等它给出结果。返回 true = 真投递了，false = 跳过或没结果
// 投递成功还要再等十几秒：她的回话是模型现场生成的，气泡冒出来那一刻这段才有画面。
async function peekOnce(timeoutSec = 30) {
  log('窥屏：现在瞄一眼');
  if (DRY) return true;
  let before = null;
  try { before = await get(BRIDGE + '/health'); } catch { log('桥没在跑，跳过这一拍'); return false; }
  const beforeAt = before.peek && before.peek.lastAt;
  const beforeCue = before.lastCue && before.lastCue.at;
  const r = await post(BRIDGE + '/peek', { now: true }).catch(() => null);
  const deliveredNow = !!(r && r.result && r.result.delivered);
  const deadline = Date.now() + timeoutSec * 1000;
  let delivered = deliveredNow;
  let logged = false;
  while (Date.now() < deadline) {
    await sleep(1000);
    let h = null;
    try { h = await get(BRIDGE + '/health'); } catch { continue; }
    if (h.peek && h.peek.lastAt && h.peek.lastAt !== beforeAt) {
      delivered = !/跳过/.test(String(h.peek.lastResult || ''));
      if (!logged) { log('窥屏结果：' + (h.peek.lastResult || '-')); logged = true; }
    }
    if (delivered && h.lastCue && h.lastCue.at && h.lastCue.at !== beforeCue) {
      log('她的回话到了：' + String(h.lastCue.text || '').slice(0, 40));
      return true;
    }
  }
  log(delivered ? '窥屏投递了，但回话没等到' : '窥屏：跳过或没结果');
  return delivered;
}

async function waitHowLong() {
  // 等她这一句说完（上面 say 已经轮询过 voicing），这里只是留一点呼吸
  await sleep(900);
}

async function main() {
  const a = await alive();
  if (!a.pet) { console.error('桌宠没在跑：' + (a.error || '') + '\n先 npm start 起外壳。'); process.exit(2); }
  if (!a.bridge) console.log('提示：反向桥没在跑，涉及「窥屏」的那一拍会跳过。');

  if (WARM) {
    star('热 TTS，不录');
    await say('嗯…', 'neutral');
    log('热好了，开始录吧');
    return;
  }

  star('先留 8 秒给你按下录制');
  await sleep(8000);

  star('第一拍：她在');
  await say('主人，我在这儿。', 'greeting');

  star('第二拍：点她一下，随便点哪儿');
  log('（现在点她，她会自己反应。这 9 秒留给你点）');
  await sleep(9000);

  star('第三拍：她有脾气');
  await mood('annoyed');
  await say('你不理我，我也不高兴。', 'annoyed');
  star('哄一下');
  await mood('happy');
  await say('哄一下就没事了。', 'shy');

  star('第四拍：看屏幕。把浏览器切到前面，随便一个网页，再往下走');
  await sleep(3000);
  const ok = await peekOnce(15);
  if (!ok) log('（这一拍跳过了，把浏览器放到最前面再来一次，或者后期剪掉这一段）');

  star('第五拍：按住 Alt 拖她，随便扔个地方');
  await say('拖着走也行。', 'neutral');
  log('（现在拖她，这 6 秒留给你）');
  await sleep(6000);

  star('第六拍：收尾');
  await say('行了，我继续待着。代码在 GitHub，README 里有装法。', 'happy');
  await sleep(2500);

  star(`演完了，共 ${el().trim()} 秒。停录吧`);
}

main().catch((e) => { console.error('演示脚本出错：' + e.message); process.exit(1); });
