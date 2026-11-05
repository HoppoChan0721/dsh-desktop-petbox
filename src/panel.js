// 面板交互：尺寸滑杆（实时预览，松手存盘）+ 依赖路径配置（保存后重启生效）
const r = document.getElementById('r');
const sizeVal = document.getElementById('sizeVal');
const statusEl = document.getElementById('status');
const FIELDS = ['jingyuRepo', 'modelDir', 'pythonPath', 'stagePort', 'moodPort', 'dshSessionsDir'];
const box = (id) => document.getElementById(id);
let aspect = 380 / 680;

// ---- 帧率：30 / 60 / 90 预设 + 自定义（0 = 不限）----
const fpsSel = box('fps');
const fpsCustom = box('fpsCustom');
const fpsVal = box('fpsVal');

function fpsFromUi() {
  if (fpsSel.value === 'custom') {
    const n = Number(fpsCustom.value);
    return Number.isFinite(n) && n >= 0 && n <= 240 && fpsCustom.value.trim() !== '' ? Math.round(n) : null;
  }
  return Number(fpsSel.value);
}

function paintFps(n) {
  const v = Number.isFinite(n) ? Math.max(0, Math.min(240, Math.round(n))) : 60;
  fpsVal.textContent = v === 0 ? '不限' : v + ' fps';
  if (v === 30 || v === 60 || v === 90) {
    fpsSel.value = String(v);
    fpsCustom.value = '';
    fpsCustom.hidden = true;
  } else {
    fpsSel.value = 'custom';
    fpsCustom.value = String(v);
    fpsCustom.hidden = false;
  }
}

async function applyFps(n) {
  if (n === null || !Number.isFinite(n)) {
    statusEl.className = 'hint bad';
    statusEl.textContent = '帧率要填 0–240 之间的整数（0 = 不限）。';
    return;
  }
  const v = Math.max(0, Math.min(240, Math.round(n)));
  try {
    await window.petCfg.save({ stageFps: v });
    paintFps(v);
    statusEl.className = 'hint good';
    statusEl.textContent = v === 0 ? '帧率已设为不限，正在重载舞台…' : `帧率已设为 ${v} fps，正在重载舞台…`;
  } catch (e) {
    statusEl.className = 'hint bad';
    statusEl.textContent = '设置帧率失败：' + e.message;
  }
}

fpsSel.addEventListener('change', () => {
  if (fpsSel.value === 'custom') {
    fpsCustom.hidden = false;
    fpsCustom.focus();
    return;
  }
  fpsCustom.hidden = true;
  applyFps(Number(fpsSel.value));
});

fpsCustom.addEventListener('change', () => applyFps(fpsFromUi()));
fpsCustom.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyFps(fpsFromUi()); } });

const readSize = () => {
  const h = Number(r.value);
  const w = Math.round(h * aspect);
  sizeVal.textContent = w + ' × ' + h;
  return { w, h };
};

function paintStatus(res) {
  if (!res) { statusEl.textContent = ''; return; }
  if (res.problems && res.problems.length) {
    statusEl.className = 'hint bad';
    statusEl.innerHTML = '还差：' + res.problems.map((p) => `<br>· ${p}`).join('');
  } else {
    statusEl.className = 'hint good';
    statusEl.textContent = '依赖齐全，可以启动。';
  }
}

async function loadConfig() {
  try {
    const { cfg, resolved } = await window.petCfg.get();
    for (const id of FIELDS) {
      const v = cfg[id];
      box(id).value = v === null || v === undefined ? '' : String(v);
    }
    box('dshWatch').checked = !!cfg.dshWatch;
    paintFps(Number(cfg.stageFps));
    paintStatus(resolved);
  } catch (e) {
    statusEl.className = 'hint bad';
    statusEl.textContent = '读配置失败：' + e.message;
  }
}

(async () => {
  try {
    const s = await window.petSize.get();
    if (s && s.h) {
      aspect = s.aspect || s.w / s.h;
      r.min = String(s.min || 420);
      r.max = String(s.max || 1400);
      r.value = String(Math.min(Number(r.max), Math.max(Number(r.min), Math.round(s.h / 10) * 10)));
    }
  } catch {}
  readSize();
  loadConfig();
})();

r.addEventListener('input', () => { const { w, h } = readSize(); window.petSize.preview(w, h); });
r.addEventListener('change', () => { const { w, h } = readSize(); window.petSize.commit(w, h); });

for (const btn of document.querySelectorAll('[data-pick]')) {
  btn.addEventListener('click', async () => {
    const id = btn.dataset.pick;
    try {
      const picked = await window.petCfg.pick(id);
      if (picked) box(id).value = picked;
    } catch {}
  });
}

// 互动开关的即时切换已挪到托盘「互动 / 说话」两组，面板这里只管要填值的项。

box('save').addEventListener('click', async () => {
  const patch = { dshWatch: box('dshWatch').checked };
  const fv = fpsFromUi();
  if (fv !== null) patch.stageFps = fv;
  for (const id of FIELDS) {
    const v = box(id).value.trim();
    if (id === 'stagePort' || id === 'moodPort') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) patch[id] = n;
    } else {
      patch[id] = v;
    }
  }
  try {
    const resolved = await window.petCfg.save(patch);
    paintStatus(resolved);
    if (resolved.ok) {
      statusEl.textContent = '依赖齐全，正在重启…';
      setTimeout(() => window.petCfg.restart(), 600);
    } else {
      statusEl.innerHTML += '<br>· 补齐上面的项后保存；重启后再从托盘「设置…」进来改。';
    }
  } catch (e) {
    statusEl.className = 'hint bad';
    statusEl.textContent = '保存失败：' + e.message;
  }
});

box('reset').onclick = () => {
  aspect = 380 / 680;
  r.value = '680';
  const { w, h } = readSize();
  window.petSize.commit(w, h);
};
box('close').onclick = () => window.petSize.close();
box('x').onclick = () => window.petSize.close();
