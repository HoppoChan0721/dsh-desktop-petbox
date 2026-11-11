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
  $('tickBubble').checked = cfg.tickBubble !== false;
  $('replyBtn').checked = cfg.replyBtn !== false;
  $('replyAlways').checked = cfg.replyAlways === true;
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
$('tickBubble').addEventListener('change', () => save({ tickBubble: $('tickBubble').checked }, '阶段气泡已切换'));
$('replyBtn').addEventListener('change', () => save({ replyBtn: $('replyBtn').checked }, '回复钮已切换'));
$('replyAlways').addEventListener('change', () => save({ replyAlways: $('replyAlways').checked }, '回复钮常驻已切换'));

$('close').onclick = () => window.stagePanel.close();
$('x').onclick = () => window.stagePanel.close();
