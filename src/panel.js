// 面板交互：尺寸滑杆（实时预览，松手存盘）+ 依赖路径配置（保存后重启生效）
const r = document.getElementById('r');
const sizeVal = document.getElementById('sizeVal');
const statusEl = document.getElementById('status');
const FIELDS = ['jingyuRepo', 'modelDir', 'pythonPath', 'stagePort', 'moodPort', 'dshSessionsDir'];
const box = (id) => document.getElementById(id);
let aspect = 380 / 680;

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
    box('interactive').checked = cfg.interactive !== false;
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

// 互动开关即时生效：改一下就存一下就广播，不用等「保存并重启」
box('interactive').addEventListener('change', async () => {
  const on = box('interactive').checked;
  try {
    await window.petCfg.save({ interactive: on });
    statusEl.className = 'hint good';
    statusEl.textContent = on ? '分区互动已开启。' : '分区互动已关闭，点她不会有反应了。';
  } catch (e) {
    statusEl.className = 'hint bad';
    statusEl.textContent = '切换失败：' + e.message;
  }
});

box('save').addEventListener('click', async () => {
  const patch = { dshWatch: box('dshWatch').checked, interactive: box('interactive').checked };
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
