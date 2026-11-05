// dsh-pet-trim — 把桌宠会话缩小到只剩「说话」：工具目录留几个，系统提示留几段。
//
// ── 为什么需要 ────────────────────────────────────────────────────────
// DSH 的注册表都在宿主平面：插件一注册，工具和提示词段就对**所有** agent 可见，
// preset 只能选呈现方式（native / ptc），选不了内容。桌宠那条会话只说话，却要为
// 整套干活装备付钱。实测它的请求体：
//
//   工具 schema   41 个 / 37934 字符   ← 约九千多 token
//   系统提示      12589 字符           ← 人设+身体卡只占四千，其余是各插件塞的
//   热记忆快照     4021 字符 / 每轮
//
// 而她的输出是十个字。三件事都用 DSH 自己的按作用域 API 治：
//
//   1) ctx.tools.restrict({ allow })          → 工具目录
//   2) 'system-prompt/assemble' 过滤器        → 系统提示段
//   3) ctx.systemPrompt.suppressRuntimeContext() → 每轮追加的运行时快照
//
// 三者都是「按调用作用域」生效，而插件的挂载作用域就是 preset，所以只影响桌宠 agent。
//
// ── 怎么用 ────────────────────────────────────────────────────────────
// 挂进桌宠 preset 的 plugins 列表：
//
//   - id: pet-trim
//     name: dsh-pet-trim
//     config:
//       allow:            # 要留下的工具名；留空 → 全部拒绝
//         - mnemon_recall
//       keepSections:     # 要留下的系统提示段名；留空 → 只留下面三个默认段
//         - harness:identity
//         - deployment:persona-prefix
//         - deployment:persona-suffix
//       suppressContext: true   # 关掉每轮的运行时快照（时间戳、热记忆…）
//       clock: true             # 自己补一行「现在是 …」，补上被压掉的时间
//
// 时间那条要多说一句：运行时快照被压掉之后模型不知道现在几点，桌宠就会问「天亮了没」
// 这种没法接的话，而快照里有用的也就时间这一条。所以默认注册一个 pet:now 段，文本是
// 「现在是 {{petNow}}。」，变量每次组装求值。段和变量都是作用域的，主会话看不到。
// `clock: false` 关掉它，模型就真的两眼一抹黑了。
// 每一项都能单独关：`allow: []` 什么都不留，`keepSections: '*'` 保留全部段，
// `suppressContext: false` 不动快照。
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LOG = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'logs', 'pet-trim.log') : ''
function log(msg) {
  if (!LOG) return
  try {
    mkdirSync(join(LOG, '..'), { recursive: true })
    appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

export const name = 'pet-trim'
export const inject = ['tools', 'systemPrompt']

const DEFAULT_TOOLS = ['mnemon_recall']
// harness:identity 是第一方那句固定开场白；中间两段是 persona 插件落前缀和后缀的地方；
// pet:now 是本插件自己补的一行时间（详见 trimClock）。
// 其余段（工具指导、插件各自的规矩、harness 源码路径、Web 表层说明…）桌宠一条也用不上。
const DEFAULT_SECTIONS = ['harness:identity', 'deployment:persona-prefix', 'deployment:persona-suffix', 'pet:now']

// ---- 0) 时间 ----
// 运行时快照被整段压掉之后（persona 的 includeRuntimeContext: false），模型连现在几点都
// 不知道，桌宠就会问「天亮了没」这种没法接的话。而快照里真正有用也就时间这一条。
// 所以这里自己补：注册一个变量，每次组装求值，再放一个只在这个 agent 生效的段引用它。
// 变量与段都是作用域的，主会话看不到，不会污染那边的提示词。
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function nowText() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${WEEK[d.getDay()]}`
}

function trimClock(ctx) {
  try {
    ctx.effect(() => ctx.systemPrompt.variable('petNow', () => nowText()), 'pet-trim.variable()')
    // order 10300 排在 persona 后缀（10200）之后，等于人设尾巴上补一句
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'pet:now',
      order: 10300,
      text: '现在是 {{petNow}}。',
    }), 'pet-trim.section()')
    log('clock: section pet:now registered')
  } catch (e) {
    log('clock: failed: ' + (e && e.message))
  }
}

// ---- 1) 工具目录 ----
function trimTools(ctx, want) {
  const lift = (fn) => {
    if (typeof fn === 'function') ctx.on('dispose', fn)
  }

  // 首选 allow：不依赖「此刻有哪些工具已注册」，直接声明保留集，剩下的全被移走。
  // dsh-tools 对未知名字抛错（有人没装记忆插件就属于这种），那时再退到 deny 全量。
  if (want.length) {
    try {
      lift(ctx.tools.restrict({ allow: want }))
      log(`tools: allow=${want.join(',')}`)
      return
    } catch (e) {
      log('tools: allow failed: ' + (e && e.message))
    }
  }

  let visible = []
  try {
    visible = (ctx.tools.schemas() || []).map((s) => s && s.name).filter(Boolean)
  } catch (e) {
    log('tools: schemas() failed: ' + (e && e.message))
  }
  if (!visible.length) {
    log('tools: nothing visible, skip')
    return
  }
  try {
    lift(ctx.tools.restrict({ deny: visible }))
    log(`tools: deny all ${visible.length}`)
  } catch (e) {
    log('tools: deny failed: ' + (e && e.message))
  }
}

// ---- 2) 系统提示段 ----
function trimSections(ctx, keep) {
  const all = keep === '*'
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next()
    if (all || !out || !Array.isArray(out.sections)) return out
    try {
      const dropped = out.sections.filter((s) => !keep.includes(s && s.name))
      const kept = out.sections.filter((s) => keep.includes(s && s.name))
      if (!kept.length) {
        // 一个都没匹配上：别把提示词删空，原样放行
        log('prompt: no section matched, left untouched')
        return out
      }
      for (const s of dropped) log(`prompt: drop ${s.name} (${(s.text || '').length} chars)`)
      return { ...out, sections: kept }
    } catch (e) {
      log('prompt: filter failed: ' + (e && e.message))
      return out
    }
  })
  log(`prompt: keeping ${keep.join(',')}`)
}

// ---- 3) 运行时快照 ----
// 热记忆快照走的是 runtime context（user 角色的快照，不是系统提示段），每轮追加一次。
// 桌宠预设里用 dsh-persona 的 includeRuntimeContext: false 就压掉了，那边更省事。
// 这个开关留着给「不挂 persona、想单独压制」的场景，默认关。
// 时间不会再丢：trimClock 补了一个只在这个 agent 生效的时间段。
function trimContext(ctx) {
  try {
    const lift = ctx.systemPrompt.suppressRuntimeContext()
    if (typeof lift === 'function') ctx.on('dispose', lift)
    log('context: runtime context suppressed')
  } catch (e) {
    log('context: suppress failed: ' + (e && e.message))
  }
}

export function apply(ctx, config = {}) {
  const allow = Array.isArray(config.allow) ? config.allow : DEFAULT_TOOLS
  const keepSections = typeof config.keepSections === 'string'
    ? config.keepSections
    : Array.isArray(config.keepSections) ? config.keepSections : DEFAULT_SECTIONS
  const suppressContext = config.suppressContext === true
  const clock = config.clock !== false

  trimTools(ctx, allow)
  if (clock) trimClock(ctx)
  trimSections(ctx, keepSections)
  if (suppressContext) trimContext(ctx)
}
