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
//
// 注意运行时快照那条：dsh-persona 自己就有 `includeRuntimeContext: false`，是官方开关，
// 桌宠预设里直接写在 persona 那一行更省事。所以本插件的 suppressContext 默认关着，
// 只在想不装 persona 开关、或者要单独压制时打开。
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
// harness:identity 是第一方那句固定开场白；另外两段是 persona 插件落前缀和后缀的地方。
// 其余段（工具指导、插件各自的规矩、harness 源码路径、Web 表层说明…）桌宠一条也用不上。
const DEFAULT_SECTIONS = ['harness:identity', 'deployment:persona-prefix', 'deployment:persona-suffix']

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
// suppressRuntimeContext() 把调用作用域的动态上下文整体压制，时间戳也一起去。
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

  trimTools(ctx, allow)
  trimSections(ctx, keepSections)
  if (suppressContext) trimContext(ctx)
}
