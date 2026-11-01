#!/usr/bin/env node
// 给鲸语仓库打「桌宠舞台」补丁。
// 为什么需要：壳子要的东西原版鲸语没有 —— ?stage=1 的无 UI 舞台、preserveDrawingBuffer（像素级穿透要读 alpha）、
// 场景命中框 data-hit、以及把 engine/model 暴露到 window 上给壳子接管。
// 设计原则：只做最小插入，跑两遍结果一样（幂等），找不到锚点就明确报错而不是静默改坏。
//
//   node patch/apply-jingyu.mjs --repo "D:/jingyu-live2d-agent"          # 打补丁（自动备份）
//   node patch/apply-jingyu.mjs --repo "..." --check                    # 只看状态，不写
//   node patch/apply-jingyu.mjs --repo "..." --revert                   # 从 .whale-pet-bak 还原
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
const CHECK = args.includes('--check');
const REVERT = args.includes('--revert');
const repo = getArg('--repo') || process.env.WHALE_PET_REPO || '';

if (!repo) {
  console.error('用法：node patch/apply-jingyu.mjs --repo <鲸语仓库目录> [--check|--revert]');
  process.exit(2);
}
const webDir = path.join(repo, 'web');
const files = { app: path.join(webDir, 'app.mjs'), engine: path.join(webDir, 'engine.mjs') };
for (const [k, f] of Object.entries(files)) {
  if (!fs.existsSync(f)) { console.error(`找不到 ${k}: ${f}（--repo 要指到含 server.py 和 web/ 的那一层）`); process.exit(2); }
}

const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, s) => fs.writeFileSync(f, s, 'utf8');
const MARK = 'whale-pet-patch';
const bak = (f) => f + '.whale-pet-bak';

function backupOnce(f) { if (!fs.existsSync(bak(f))) fs.copyFileSync(f, bak(f)); }

// —— app.mjs 补丁：四处最小插入 ——
function patchApp(src) {
  const notes = [];
  let s = src;

  if (!s.includes(`${MARK}:stage-mode`)) {
    if (s.includes('const stageMode=')) notes.push('app.mjs：已有 stageMode（手改过或旧补丁），跳过');
    else {
      const anchor = 'const comparisonMode=search.get(\'comparison\')===\'1\';';
      if (!s.includes(anchor)) throw new Error('app.mjs 锚点 1 缺失（comparisonMode 行），鲸语版本可能变了');
      s = s.replace(anchor, anchor +
        `\n// ${MARK}:stage-mode — 桌宠/直播舞台：无 UI、可读像素、暴露 engine\n` +
        `const stageMode=search.get('stage')==='1'||search.get('stage')==='true'||search.get('view')==='stage';\n` +
        `if(stageMode)document.documentElement.classList.add('stage-mode');`);
      notes.push('app.mjs：插入 stageMode 判定');
    }
  }
  if (!s.includes(`${MARK}:preserve`)) {
    if (s.includes('preserveDrawingBuffer')) notes.push('app.mjs：已有 preserveDrawingBuffer，跳过');
    else {
      const anchor = "powerPreference:'high-performance'";
      if (!s.includes(anchor)) throw new Error('app.mjs 锚点 2 缺失（PIXI.Application powerPreference），鲸语版本可能变了');
      s = s.replace(anchor, `// ${MARK}:preserve — 像素级穿透要能读 canvas alpha\n${anchor},preserveDrawingBuffer:!!(search.get('stage'))`);
      notes.push('app.mjs：preserveDrawingBuffer');
    }
  }
  if (!s.includes(`${MARK}:expose`)) {
    if (s.includes('__stageEngine')) notes.push('app.mjs：已有 __stageEngine 暴露，跳过');
    else {
      const anchor = "$('scene').dataset.ready='true';";
      if (!s.includes(anchor)) throw new Error('app.mjs 锚点 3 缺失（scene dataset.ready），鲸语版本可能变了');
      s = s.replace(anchor, anchor +
        `\n  if(stageMode){// ${MARK}:expose — 壳子从这里接管：指针、命中框\n` +
        `    $('gaze-toggle')&&($('gaze-toggle').checked=true);window.__stageEngine=engine;window.__stageModel=model;\n` +
        `    if(window.petCursor&&typeof window.petCursor.on==='function')window.petCursor.on(c=>{if(!engine)return;engine.pointer=c?{x:c.x,y:c.y}:null;engine.gaze=c?{x:c.x,y:c.y}:null;});\n` +
        `    setInterval(()=>{try{const b=model.getBounds();$('scene').dataset.hit=[b.x,b.y,b.width,b.height].map(n=>n.toFixed(1)).join(',');}catch{}},200);}`);
      notes.push('app.mjs：暴露 __stageEngine / 指针订阅 / data-hit 命中框');
    }
  }
  return { s, notes };
}

// —— engine.mjs 补丁：加一个 pointer 阶段（优先级 15，介于 idle 和 gaze 之间）——
function patchEngine(src) {
  const notes = [];
  let s = src;
  if (!s.includes(`${MARK}:pointer`)) {
    if (s.includes('applyPointer')) notes.push('engine.mjs：已有 applyPointer（手改过），跳过');
    else {
    const anchor = 'export class MotionEngine{';
    if (!s.includes(anchor)) throw new Error('engine.mjs 锚点 1 缺失（MotionEngine 类），鲸语版本可能变了');
    s = s.replace(anchor,
      `// ${MARK}:pointer — 指针追踪幅度（参数刻度）：AngleX 转头/上身，AngleY 俯仰，LeanInput 前后探身\n` +
      `const PTR={x:18,y:12,z:14,lean:26,px:4};\n` + anchor);
    const addAnchor = `.add('idle',10,c=>this.applyIdle(c))`;
    if (!s.includes(addAnchor)) throw new Error('engine.mjs 锚点 2 缺失（idle 阶段注册），鲸语版本可能变了');
    s = s.replace(addAnchor, addAnchor + `.add('pointer',15,c=>this.applyPointer(c))`);
    const methodAnchor = '  applyMotion(';
    if (!s.includes(methodAnchor)) throw new Error('engine.mjs 锚点 3 缺失（applyMotion），鲸语版本可能变了');
    s = s.replace(methodAnchor,
      `  // ${MARK}:pointer 留三成待机底噪，头和上身跟着指针走；指针靠下时 LeanInput 让身子前探，髋腿由作者物理带着弯\n` +
      `  applyPointer({set,target}){\n` +
      `    const p=this.pointer;if(!p)return;\n` +
      `    const x=Math.max(-1,Math.min(1,p.x)),y=Math.max(-1,Math.min(1,p.y));\n` +
      `    const add=(id,v,keep=0.35)=>set(id,(target.get(id)??0)*keep+v);\n` +
      `    add('AngleX',x*PTR.x);add('AngleY',y*PTR.y);add('AngleZ',x*PTR.z,0.3);\n` +
      `    add('LeanInput',y*PTR.lean,0.2);add('PositionX',x*PTR.px,0.3);\n` +
      `  }\n` + methodAnchor);
    notes.push('engine.mjs：新增 pointer 阶段（头/上身/前探/侧移）');
    }
  }
  return { s, notes };
}

function state(f, pairs) {
  const s = read(f);
  return pairs.map(([k, probe]) => `${k}: ${s.includes(`${MARK}:${k}`) ? '已打' : s.includes(probe) ? '已存在（手改）' : '未打'}`).join('  ');
}

if (REVERT) {
  let n = 0;
  for (const f of Object.values(files)) {
    if (fs.existsSync(bak(f))) { fs.copyFileSync(bak(f), f); n++; console.log('还原 ' + f); }
  }
  console.log(n ? `还原完成（${n} 个文件）` : '没有找到备份（.whale-pet-bak），可能从没打过补丁');
  process.exit(0);
}

if (CHECK) {
  console.log('app.mjs    ' + state(files.app, [['stage-mode', 'const stageMode='], ['preserve', 'preserveDrawingBuffer'], ['expose', '__stageEngine']]));
  console.log('engine.mjs ' + state(files.engine, [['pointer', 'applyPointer']]));
  process.exit(0);
}

try {
  const appSrc = read(files.app), engSrc = read(files.engine);
  const app = patchApp(appSrc);
  const eng = patchEngine(engSrc);
  const notes = [...app.notes, ...eng.notes];
  const changed = app.s !== appSrc || eng.s !== engSrc;
  if (!changed) {
    console.log(notes.map((n) => ' = ' + n).join('\n') || '已经是最新状态。');
    console.log('\n没有改动任何文件。');
    process.exit(0);
  }
  backupOnce(files.app); backupOnce(files.engine);
  write(files.app, app.s);
  write(files.engine, eng.s);
  console.log(notes.map((n) => ' + ' + n).join('\n'));
  console.log('\n打完。重启鲸语（server.py）后，壳子才能用 ?stage=1 和指针追踪。');
  console.log('还原：node patch/apply-jingyu.mjs --repo "<同一个目录>" --revert');
} catch (e) {
  console.error('补丁失败：' + e.message);
  console.error('没有写入任何文件。请检查鲸语版本，或手动对照 README 里的「补丁清单」。');
  process.exit(1);
}
