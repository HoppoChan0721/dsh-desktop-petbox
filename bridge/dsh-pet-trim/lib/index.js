// dsh-pet-trim — 把桌宠会话的工具目录砍到只剩它真用得上的那几个。
//
// ── 为什么需要 ────────────────────────────────────────────────────────
// DSH 的工具注册表在宿主平面：插件一注册，工具就对**所有** agent 可见，preset 只能
// 选呈现方式（native / ptc），选不了内容。桌宠那条会话本来就只说话，却要为一整套
// 干活工具付 schema 的钱——实测 41 个工具、37934 字符，约等于九千多 token，每轮都付。
//
// dsh-tools 给了按作用域掩码的 API：ctx.tools.restrict({ allow, deny })。调用作用域
// 就是插件的挂载作用域，而这个插件挂在桌宠 preset 里，所以限制只落到桌宠 agent 身上。
// dsh-tools 的 README 原话：「隐藏工具的限制会为该 agent 移除其全部 schema 成本」。
//
// ── 怎么用 ────────────────────────────────────────────────────────────
// 挂进桌宠 preset 的 plugins 列表，config.allow 写要留下的工具名：
//
//   - id: pet-trim
//     name: dsh-pet-trim
//     config:
//       allow:
//         - mnemon_recall
//
// 名字里有一个对不上就整个 restrict 失败（dsh-tools 对未知名字抛错），所以这里先拿
// ctx.tools.schemas() 对照一遍现存的工具名，只把真实存在的交给 restrict。没装记忆
// 插件的人 allow 里那个名字不存在 → keep 为空 → 退化成「全部 deny」。两条路都不会
// 让桌宠会话空着 41 个工具跑。
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
export const inject = ['tools']

const DEFAULTS = ['mnemon_recall']

export function apply(ctx, config = {}) {
  const want = Array.isArray(config.allow) && config.allow.length ? config.allow : DEFAULTS

  const lift = (fn) => {
    if (typeof fn === 'function') ctx.on('dispose', fn)
  }

  // 首选 allow：不依赖「此刻有哪些工具已注册」，直接声明保留集，剩下的全被移走。
  // dsh-tools 对未知名字抛错（有人没装记忆插件就属于这种），那时再退到 deny 全量。
  try {
    lift(ctx.tools.restrict({ allow: want }))
    log(`restricted: allow=${want.join(',')}`)
    return
  } catch (e) {
    log('allow failed: ' + (e && e.message))
  }

  let visible = []
  try {
    visible = (ctx.tools.schemas() || []).map((s) => s && s.name).filter(Boolean)
  } catch (e) {
    log('schemas() failed: ' + (e && e.message))
  }
  if (!visible.length) {
    log('no visible tools, nothing to trim')
    return
  }

  try {
    lift(ctx.tools.restrict({ deny: visible }))
    log(`restricted: deny all ${visible.length} tools (none of wanted found: ${want.join(',')})`)
  } catch (e) {
    // 掩码失败不该把桌宠会话搞崩，退回原来的模样继续说话
    log('deny failed: ' + (e && e.message))
  }
}
