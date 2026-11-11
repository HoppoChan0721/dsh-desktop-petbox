// 设置面板的交互。一切改动即时生效；改完顺手存进 data/stage-config.json。
// 尺寸用滑杆实时预览（拖动过程中就改窗口），松手才落盘。
const $ = (id) => document.getElementById(id);
const sizeEl = $('size');
const sizeVal = $('sizeVal');
const swayEl = $('sway');
const swayVal = $('swayVal');
const statusEl = $('status');
let aspect = 671 / 1182;

function paintSize() {
  const h = Number(sizeEl.value);
  const w = Math.round(h * aspect);
  sizeVal.textContent = w + ' × ' + h;
  return { w, h };
}

function say(text, kind) {
  statusEl.className = kind || '';
  statusEl.textContent = text || '';
}

async function save(patch, note) {
  try {
    const r = await window.stagePanel.save(patch);
    say(note || '已保存', 'good');
    if (r && r.reloaded) say(note || '已保存，舞台重新载入中…', 'good');
    return r;
  } catch (e) {
    say('保存失败：' + e.message, 'bad');
    return null;
  }
}

// 保活状态说人话：外行看「热着 / 没起来」就够了，别甩状态码
const KA_TEXT = {
  idle: ['还没探过', ''],
  off: ['保活关着', ''],
  down: ['语音服务没起来', 'bad'],
  starting: ['正在拉起语音服务…', ''],
  warming: ['正在热身（第一句最慢就是这样）', ''],
  warm: ['热着，说话不用等', 'good'],
  up: ['服务在，还没热身', ''],
};
function paintKeepAlive(ka) {
  const el = $('ttsState');
  if (!ka) { el.textContent = ''; return; }
  const [text, kind] = KA_TEXT[ka.state] || [ka.state, ''];
  let line = text;
  if (ka.state === 'warm' && ka.lastWarmMs) line += '（上次热身 ' + (ka.lastWarmMs / 1000).toFixed(1) + ' 秒）';
  if (ka.lastError) line += ' · ' + ka.lastError;
  el.textContent = line;
  el.className = 'hint' + (kind ? ' ' + kind : '');
}

(async () => {
  const s = await window.stagePanel.state();
  if (!s) { say('读不到舞台状态', 'bad'); return; }
  if (s.size) {
    aspect = s.size.aspect || aspect;
    sizeEl.min = String(s.size.min || 420);
    sizeEl.max = String(s.size.max || 1400);
    sizeEl.value = String(Math.min(Number(sizeEl.max), Math.max(Number(sizeEl.min), s.size.h || 1182)));
    paintSize();
  }
  const cfg = s.cfg || {};
  $('fps').value = String(cfg.fps === undefined ? 60 : cfg.fps);
  swayEl.value = String(cfg.sway === undefined ? 1.6 : cfg.sway);
  swayVal.textContent = Number(swayEl.value).toFixed(1) + ' ×';
  $('spin').value = String(cfg.spinTurns || 4);
  const volEl = $('volume');
  const volVal = $('volumeVal');
  volEl.value = String(cfg.voiceVolume === undefined ? 0.6 : cfg.voiceVolume);
  volVal.textContent = Math.round(Number(volEl.value) * 100) + '%';
  $('interactive').checked = cfg.interactive !== false;
  $('cursorTrack').checked = cfg.cursorTrack !== false;
  $('onTop').checked = cfg.onTop !== false;
  $('smartIgnore').checked = cfg.smartIgnore !== false;
  $('bridge').checked = cfg.bridge !== false;
  $('tickBubble').checked = cfg.tickBubble !== false;
  $('replyBtn').checked = cfg.replyBtn !== false;
  $('replyAlways').checked = cfg.replyAlways === true;
  $('panelAutoClose').checked = cfg.panelAutoClose === true;
  $('sessionWatch').checked = cfg.sessionWatch !== false;
  $('ttsKeepAlive').checked = cfg.ttsKeepAlive !== false;
  $('ttsKeepMinutes').value = String(Math.max(1, Number(cfg.ttsKeepMinutes) || 5));
  if (s.voice === false) {
    $('ttsState').textContent = '没有语音桥脚本，说话只有气泡没有声音';
    $('ttsState').className = 'hint bad';
    $('ttsKeepAlive').disabled = true;
    $('ttsKeepMinutes').disabled = true;
  } else {
    paintKeepAlive(s.keepalive);
  }
  if (s.note) say(s.note);
})().catch((e) => say('读状态失败：' + e.message, 'bad'));

// ---- 尺寸：拖的时候实时改，松手存盘 ----
sizeEl.addEventListener('input', () => { const { w, h } = paintSize(); window.stagePanel.size(w, h); });
sizeEl.addEventListener('change', async () => { const { w, h } = paintSize(); await save({ width: w, height: h }, '尺寸 ' + w + ' × ' + h); });

// ---- 帧率 / 摆动：要重载舞台才生效 ----
$('fps').addEventListener('change', () => save({ fps: Number($('fps').value) }, '帧率已改，重载中…'));
swayEl.addEventListener('input', () => { swayVal.textContent = Number(swayEl.value).toFixed(1) + ' ×'; });
swayEl.addEventListener('change', () => save({ sway: Number(swayEl.value) }, '摆动已改，重载中…'));
$('spin').addEventListener('change', () => save({ spinTurns: Number($('spin').value) }, '绕圈圈数已改'));

// 音量是即时生效的：拖着滑杆就发，松手才落盘——不然每动一格写一次盘
$('volume').addEventListener('input', () => {
  const v = Number($('volume').value);
  $('volumeVal').textContent = Math.round(v * 100) + '%';
  window.stagePanel.save({ voiceVolume: v }).catch(() => {});
});
$('volume').addEventListener('change', () => {
  const v = Number($('volume').value);
  save({ voiceVolume: v }, '音量 ' + Math.round(v * 100) + '%');
});

$('interactive').addEventListener('change', () => save({ interactive: $('interactive').checked }, '分区互动已切换'));
$('cursorTrack').addEventListener('change', () => save({ cursorTrack: $('cursorTrack').checked }, '指针追踪已切换'));
$('onTop').addEventListener('change', () => save({ onTop: $('onTop').checked }, '置顶已切换'));
$('smartIgnore').addEventListener('change', () => save({ smartIgnore: $('smartIgnore').checked }, '智能穿透已切换'));
$('bridge').addEventListener('change', () => save({ bridge: $('bridge').checked }, '点触桥已切换'));
$('tickBubble').addEventListener('change', () => save({ tickBubble: $('tickBubble').checked }, '阶段气泡已切换'));
$('replyBtn').addEventListener('change', () => save({ replyBtn: $('replyBtn').checked }, '回复钮已切换'));
$('replyAlways').addEventListener('change', () => save({ replyAlways: $('replyAlways').checked }, '回复钮常驻已切换'));
$('panelAutoClose').addEventListener('change', () => save({ panelAutoClose: $('panelAutoClose').checked }, $('panelAutoClose').checked ? '点外面自动收起' : '面板会一直开着'));
$('sessionWatch').addEventListener('change', () => save({ sessionWatch: $('sessionWatch').checked }, $('sessionWatch').checked ? '会话联动已开' : '会话联动已关'));
$('ttsKeepAlive').addEventListener('change', () => save({ ttsKeepAlive: $('ttsKeepAlive').checked }, '语音保活已切换'));
$('ttsKeepMinutes').addEventListener('change', () => save({ ttsKeepMinutes: Number($('ttsKeepMinutes').value) }, '探活间隔已改'));

$('close').onclick = () => window.stagePanel.close();
$('x').onclick = () => window.stagePanel.close();
