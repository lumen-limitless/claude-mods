import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Flow, Panel, Phase, PlanTask, Role } from '../types'

// Adapted from savvy-progress by johnnyvizz (MIT): the band, the panel, the cost
// table and the pixel crabs. savvy-flow reports its progress through a tool;
// superpowers reports nothing, so here the flow is read from what superpowers
// already leaves behind: the skills the main session loads, the plan file, the
// SDD workspace and its ledger, and the descriptions its templates give subagents.

const flow = atom({ plugin: 'superpowers-progress', key: 'flow' } as const, null)
const agents = atom({ plugin: 'superpowers-progress', key: 'agents' } as const, [])
const panel = atom({ plugin: 'superpowers-progress', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  autoOpenedFor: '',
})
const now = atom({ plugin: 'superpowers-progress', key: 'now' } as const, 0)
const seq = atom({ plugin: 'superpowers-progress', key: 'seq' } as const, 0)

const STEP_TOOL = 'mcp__superpowers-progress__step'
// Added to the end of each superpowers subagent's brief: a tool that is merely
// listed goes unused, while the same request in the brief is followed.
const STEP_BRIEF = `

Progress reporting: before any other work, call \`${STEP_TOOL}\` with \`total\` (your plan in 3-8 steps) and \`done: 0\`; call it again with \`done\` and a few-word \`note\` as each step finishes. It only draws a progress bar.`
const PANE = 'superpowers-crew'
const PANE_TITLE = 'Crew'
const PHASES: readonly Phase[] = ['brainstorm', 'plan', 'build', 'review', 'finish']
// What a plan file or a ledger may ask the band and the panel to draw is bounded here.
const MAX_TASKS = 200
const MAX_TITLE = 120
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

// ---------------------------------------------------------------------------
// Reading superpowers.

const SKILL_PHASE: Record<string, Phase> = {
  brainstorming: 'brainstorm',
  'writing-plans': 'plan',
  'subagent-driven-development': 'build',
  'executing-plans': 'build',
  'requesting-code-review': 'review',
  'finishing-a-development-branch': 'finish',
}

const PHASE_WORD: Record<Phase, string> = {
  brainstorm: 'Brainstorm',
  plan: 'Plan',
  build: 'Build',
  review: 'Review',
  finish: 'Finish',
}

// The title a flow shows until a spec or a plan names it.
const PHASE_TITLE: Record<Phase, string> = {
  brainstorm: 'Brainstorming',
  plan: 'Writing the plan',
  build: 'Executing the plan',
  review: 'Code review',
  finish: 'Finishing the branch',
}

// `superpowers:brainstorming`, or the bare name where superpowers is installed as plain skills.
const phaseOfSkill = (skill: string): Phase | undefined => {
  skill = skill.trim().replace(/^\//, '')
  const cut = skill.indexOf(':')
  const owner = cut < 0 ? '' : skill.slice(0, cut)
  const name = (cut < 0 ? skill : skill.slice(cut + 1)).trim()
  if (owner && owner !== 'superpowers') return undefined
  return Object.hasOwn(SKILL_PHASE, name) ? SKILL_PHASE[name] : undefined
}

const rank = (p: Phase): number => PHASES.indexOf(p)

const blank = (phase: Phase, epoch = 0): Flow => ({
  epoch,
  title: PHASE_TITLE[phase],
  phase,
  isFinished: false,
  mode: '',
  hasSpec: false,
  hasPlan: false,
  planPath: '',
  workspace: '',
  tasks: [],
  done: 0,
  current: 0,
  isFinalReviewed: false,
})

// Whether entering `to` starts a new workflow rather than moving this one along.
const isNewFlowFor = (prev: Flow | null, to: Phase): boolean => {
  if (!prev || prev.isFinished) return true
  if (to === 'brainstorm') return prev.phase !== 'brainstorm'
  if (to === 'plan' || to === 'build') return rank(prev.phase) >= rank('review')
  return false
}

// Phases only move forward; `moveTo` lets writing-plans step a build back to plan.
const advance = (from: Phase, to: Phase): Phase => (rank(to) > rank(from) ? to : from)

const totalOf = (f: Flow): number => Math.max(f.tasks.length, f.done)
const isAllDone = (f: Flow): boolean => totalOf(f) > 0 && f.done >= totalOf(f)

const plain = (s: string): string => s.replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim()

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// "Parser Implementation Plan" → "Parser"; "Parser — Design" → "Parser".
const cleanTitle = (s: string): string =>
  clip(
    plain(s)
      .replace(/\s*[:\-–—]?\s*(implementation plan|design(\s+doc(ument)?)?|spec(ification)?)$/i, '')
      .trim(),
    MAX_TITLE,
  )

// The plan's `# Title` and its `### Task N: name` headings, code fences skipped,
// as writing-plans lays them out and task-brief reads them.
const parsePlan = (text: string): { title: string; tasks: { n: number; title: string }[] } => {
  let title = ''
  let isFenced = false
  const tasks: { n: number; title: string }[] = []
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      isFenced = !isFenced
      continue
    }
    if (isFenced) continue
    const h1 = /^#\s+(.+)$/.exec(line)
    if (h1 && !title) title = cleanTitle(h1[1] ?? '')
    const task = /^#{2,4}\s+Task\s+(\d+)\b\s*[:.\-–—]?\s*(.*)$/i.exec(line)
    const n = Number(task?.[1] ?? 0)
    if (task && n > 0 && tasks.length < MAX_TASKS && !tasks.some(t => t.n === n)) {
      tasks.push({ n, title: clip(plain(task[2] ?? '') || `Task ${n}`, MAX_TITLE) })
    }
  }
  return { title, tasks }
}

// Plans go to docs/superpowers/plans/ unless the person keeps them elsewhere;
// anywhere else a file counts by its shape.
const isPlanFile = (path: string, text: string): boolean =>
  /\/docs\/superpowers\/plans\/[^/]+\.md$/.test(path) ||
  (/\.md$/i.test(path) && /^#\s.*implementation plan/im.test(text) && /^#{2,4}\s+Task\s+1\b/im.test(text))

const isSpecFile = (path: string): boolean => /\/docs\/superpowers\/specs\/[^/]+\.md$/.test(path)

// The ledger both executors keep: `# SDD ledger — plan: <path>`, then
// `Task N: complete (...)` and `Task N: fix round R/5 (...)` lines.
const parseLedger = (text: string): { done: Set<number>; rounds: Map<number, number>; plan: string } => {
  const done = new Set<number>()
  const rounds = new Map<number, number>()
  const plan = /^#\s*SDD ledger\s*[—–-]+\s*plan:\s*(.+?)\s*$/m.exec(text)?.[1] ?? ''
  for (const line of text.split('\n')) {
    const complete = /^\W*Task\s+(\d+):\s*complete\b/i.exec(line)
    if (complete) done.add(Number(complete[1]))
    const fix = /^\W*Task\s+(\d+):\s*fix round\s+(\d+)/i.exec(line)
    if (fix) rounds.set(Number(fix[1]), Math.max(rounds.get(Number(fix[1])) ?? 0, Number(fix[2])))
  }
  return { done, rounds, plan }
}

// `<repo>/.superpowers/sdd/<plan-slug>`: printed by sdd-workspace, inside every
// brief, report and review-package path, and the folder the ledger lives in.
const WORKSPACE = /(\/[^\s'"`]*?\/\.superpowers\/sdd\/[^\s'"`/.][^\s'"`/]*)/
const workspaceIn = (s: string): string => WORKSPACE.exec(s)?.[1]?.replace(/[),;:]+$/, '') ?? ''
const rootOf = (ws: string): string => ws.replace(/\/\.superpowers\/sdd\/[^/]+$/, '')

// A merge, a PR, or a removed worktree or branch: finishing-a-development-branch's outcomes.
const FINISHED_BY = /\bgh\s+pr\s+create\b|\bgit\s+merge\b|\bgit\s+worktree\s+remove\b|\bgit\s+branch\s+-D\b/

// ---------------------------------------------------------------------------
// The crew: who each subagent is, by the templates superpowers dispatches.

const ROLES: Record<Role, { word: string; short: string; color: string }> = {
  implementer: { word: 'implementer', short: 'impl', color: '#378ADD' },
  reviewer: { word: 'task reviewer', short: 'review', color: '#D85A30' },
  rereviewer: { word: 're-reviewer', short: 're-review', color: '#BA7517' },
  judge: { word: 'final reviewer', short: 'final', color: '#7F77DD' },
  fixer: { word: 'fixer', short: 'fix', color: '#E0607E' },
  architect: { word: 'builder check', short: 'builder', color: '#1D9E75' },
  scout: { word: 'explorer', short: 'explore', color: '#5B8C5A' },
  planner: { word: 'planner', short: 'plan', color: '#0F9BB0' },
  crab: { word: 'subagent', short: 'agent', color: '#888780' },
}

// The roles superpowers' own templates dispatch.
const SP_ROLES: ReadonlySet<Role> = new Set<Role>(['implementer', 'reviewer', 'rereviewer', 'judge', 'fixer', 'architect'])

// Descriptions first (the templates fix them), then the prompts' opening lines.
const roleOf = (type: string, description: string, prompt: string): Role => {
  const d = description.trim()
  const p = prompt.slice(0, 4000)
  const bare = type.replace(/^[^:]*:/, '')
  if (/^re-?review\b/i.test(d) || /\bYou are re-reviewing\b/i.test(p)) return 'rereviewer'
  if (/^review task\b/i.test(d) || /\bYou are reviewing one task/i.test(p)) return 'reviewer'
  if (/\bSenior Code Reviewer\b/i.test(p) || /^review (code )?changes\b/i.test(d) || /\b(final|whole[- ]branch) review\b/i.test(d)) return 'judge'
  if (/handed a design document and asked to put together a plan/i.test(p) || /\bbuilder[- ]check\b/i.test(d)) return 'architect'
  if (/\byou own it now\b/i.test(p) || /^fix\b/i.test(d) || /\bfix (wave|round|findings)\b/i.test(d)) return 'fixer'
  if (/^implement task\b/i.test(d) || /\bYou are implementing Task\b/i.test(p)) return 'implementer'
  if (bare === 'Explore') return 'scout'
  if (bare === 'Plan') return 'planner'
  return 'crab'
}

const taskOf = (description: string, prompt: string): number =>
  Number(/\bTask\s+(\d+)\b/i.exec(description)?.[1] ?? /\bTask\s+(\d+)\b/i.exec(prompt.slice(0, 400))?.[1] ?? 0)

// Every crab hatched gets its own name and accent, so two implementers side by side differ.
const NAMES = [
  'Pinchy', 'Clawdia', 'Snips', 'Shelly', 'Bubbles', 'Coral', 'Sandy', 'Barnacle',
  'Kelp', 'Nipper', 'Scuttle', 'Pebble', 'Reef', 'Marina', 'Krill', 'Hermit',
  'Dune', 'Ripple', 'Briny', 'Clampy', 'Sprat', 'Wavelet', 'Tidepool', 'Sunny',
]
const HUES = ['#E5484D', '#0090FF', '#46A758', '#F76B15', '#8E4EC6', '#12A594', '#D6409F', '#FFC53D', '#3E63DD', '#AD7F58']

const nameOf = (i: number): string =>
  (NAMES[i % NAMES.length] ?? 'Crab') + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : '')
const hueOf = (i: number): string => HUES[i % HUES.length] ?? '#888780'

// ---------------------------------------------------------------------------
// Progress: the bar runs across the whole lifecycle, the build taking most of it.

const SEG: Record<Phase, readonly [number, number]> = {
  brainstorm: [0, 0.1],
  plan: [0.1, 0.2],
  build: [0.2, 0.85],
  review: [0.85, 0.95],
  finish: [0.95, 1],
}

const within = (p: Phase, k: number): number => {
  const [a, b] = SEG[p]
  return a + (b - a) * Math.max(0, Math.min(1, k))
}

const taskRatio = (f: Flow, extra = 0): number => (totalOf(f) ? Math.min(1, (f.done + extra) / totalOf(f)) : 0)

const ratio = (f: Flow): number => {
  if (f.isFinished) return 1
  if (f.phase === 'brainstorm') return within('brainstorm', f.hasSpec ? 1 : 0.4)
  if (f.phase === 'plan') return within('plan', f.hasPlan ? 1 : 0.4)
  if (f.phase === 'build') return within('build', taskRatio(f))
  if (f.phase === 'review') return within('review', f.isFinalReviewed ? 1 : 0.4)
  return within('finish', 0.5)
}

// Tasks handed out and not yet in the ledger: the band's faint second layer.
const inFlight = (f: Flow, list: AgentRun[]): number => {
  const busy = new Set(list.filter(a => a.status === 'running' && a.task > 0).map(a => a.task))
  if (f.current) busy.add(f.current)
  return [...busy].filter(n => !f.tasks.some(t => t.n === n && t.isDone)).length
}

const label = (f: Flow): string => {
  if (f.isFinished) return 'Done'
  if (f.phase === 'brainstorm') return f.hasSpec ? 'Spec written' : 'Brainstorm'
  if (f.phase === 'plan') return f.tasks.length ? `Plan · ${f.tasks.length} tasks` : 'Plan'
  if (f.phase === 'build') return totalOf(f) ? `Tasks ${f.done}/${totalOf(f)}` : 'Building'
  if (f.phase === 'review') return f.isFinalReviewed ? 'Review clean' : 'Final review'
  return 'Finish'
}

const phaseChip = (f: Flow, p: Phase): string =>
  p === 'build' && totalOf(f) && rank(f.phase) >= rank('build') ? `Build ${f.done}/${totalOf(f)}` : PHASE_WORD[p]

// ---------------------------------------------------------------------------
// The band: one SVG row on the desktop (it wraps sibling elements onto new
// lines), text on the terminal.

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

const H = 22
const BAR_H = 16
const CRAB_W = 26
// The crab's drawing grid is 30 units wide, props included.
const CRAB_BOX = 30
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// CJK, fullwidth forms and emoji advance about 1em.
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹏！-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em; good enough to size a slot.
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Zmw@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const rowSvg = (f: Flow, W: number, isWorking: boolean, flying: number): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(f.title, 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const color = f.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(f))
  const runW = f.phase === 'build' && !f.isFinished ? Math.round(BAR_W * within('build', taskRatio(f, flying))) : 0
  const dots: string[] = []

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  // Handed to workers, not yet in the ledger: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }

  // Tall ticks where one phase hands over to the next, short ones between tasks.
  const ticks: string[] = []
  const tick = (k: number, h: number) => {
    const x = Math.round(BAR_W * k)
    if (x > fillW + 4 && x < BAR_W - 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - h / 2}" width="1.5" height="${h}" rx="0.75"/>`)
  }
  for (const p of PHASES.slice(1)) tick(SEG[p][0], 10)
  const total = totalOf(f)
  if (total > 1 && total <= 40) for (let i = 1; i < total; i++) tick(within('build', i / total), 5)

  const text = label(f)
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = `${Math.round(ratio(f) * 100)}%`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${f.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${f.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${f.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${f.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${f.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(W - CRAB_W + 1, 0, 'captain', ACCENT, false, isWorking, 0.8)}
</svg>`
}

const barText = (f: Flow, width: number): string => {
  const filled = Math.round(width * ratio(f))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------
// Cost and context, as savvy-progress estimates them.

// USD per million tokens: input, output, cache read, cache write. The first row that
// matches a model id wins, so a release sits above its family. The engine reports
// tokens, not money, so the panel's cost is an estimate (list prices as of
// 2026-10-10); cache writes are priced at the 1-hour rate Claude Code writes on a
// subscription.
type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

// Haiku 5.5 is priced by prompt length: a request whose prompt (input, cache reads and
// cache writes together) is over 100,000 tokens pays these prices instead.
const HAIKU_LONG_PROMPT = 100_000
const HAIKU_LONG: Price = [0.5, 2.5, 0.05, 1]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string, prompt: number): Price => {
  const id = model.toLowerCase()
  if (prompt > HAIKU_LONG_PROMPT && /haiku-5-5/.test(id)) return HAIKU_LONG
  return PRICES.find(([re]) => re.test(id))?.[1] ?? [4, 20, 0.2, 8]
}

// `isRequest` says the usage is one model request, which is what a prompt-length price
// is set by; a turn's sum is priced at the model's ordinary prices.
const costOf = (model: string, u: Usage, isRequest: boolean): number => {
  const prompt = isRequest ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0
  const [i, o, r, w] = priceOf(model, prompt)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

// Haiku 4.5 and the Claude 3 models have a 200K window; the rest, Haiku 5.5 included, 1M.
const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

// "Opus 5.5 · low" for a run, or just the model when no effort was seen.
const runModel = (a: AgentRun): string => (a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model))

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// Plan tasks no run has picked up yet and the ledger has not closed.
const upNextOf = (f: Flow | null, list: AgentRun[]): PlanTask[] => {
  if (!f || f.isFinished) return []
  const started = new Set(list.filter(a => a.task > 0).map(a => a.task))
  return f.tasks.filter(t => !t.isDone && !started.has(t.n))
}

const role = (r: string): (typeof ROLES)[Role] => (Object.hasOwn(ROLES, r) ? ROLES[r as Role] : ROLES.crab)

// The role word, or the agent type for a crab no template dispatched.
const roleWord = (a: AgentRun): string => (a.role === 'crab' ? a.type : role(a.role).word)

// ---------------------------------------------------------------------------
// The crabs. Pixel Clawd from DockCrab (Clawdy), by way of savvy-progress: a 24×18
// crab on a 30×28 grid, one costume per role. The body keeps the brand clay; the
// crab's own accent colors its costume.

const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Implementer: engineer in a hard hat; the wrench turns a bolt.
  implementer: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Task reviewer: detective in a deerstalker; the magnifier sweeps and glints.
  reviewer: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Re-reviewer: inspector in a visor cap and glasses; the check on the clipboard blinks.
  rereviewer: (f, t) => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....cccccccccc....', '..cccccccccccccc..', '.cccccccccccccccc.', '.cccccccccccccccc.'], { c: t })
    f(2, 9, 21, 1, '#3A3A3C')
    for (const x of [8, 18]) {
      f(x, 11, 4, 1, '#2B2B2B'); f(x, 14, 4, 1, '#2B2B2B'); f(x, 12, 1, 2, '#2B2B2B'); f(x + 3, 12, 1, 2, '#2B2B2B')
    }
    f(12, 12, 6, 1, '#2B2B2B')
    stamp(f, 23, 1, ['..kk..', 'bbbbbb', 'bwwwwb', 'bwwwwb', 'bwwwwb', 'bwwwwb', 'bwwwwb', 'bbbbbb'], { k: '#8E929A', b: '#7A4A26', w: '#F8F6F1' })
    stamp(f, 24, 3, ['...g', '..g.', 'g.g.', '.g..'], { g: '#3B9C5F' }, 'ck')
  },
  // Final reviewer: judge in a powdered wig and robe; the gavel bangs.
  judge: (f, t) => {
    crabBody(f, -4, 'gv')
    stamp(f, 5, 4, ['....wwwwwwwwwwww....', '..wwwgwwwgwwwgwwww..', '.wwwwwwwwwwwwwwwwww.', 'wwgwwwwwwwwwwwwwwgww', 'www..............www', 'wgw..............wgw', 'www.................', 'wgw.................', 'www.................'], { w: '#F4F3EE', g: '#D2D1C8' })
    f(7, 18, 16, 4, '#2B2B2B'); f(7, 18, 16, 1, t); f(14, 18, 2, 3, '#F4F3EE')
    f(25, 4, 5, 3, '#5A3519', 'gv'); f(27, 7, 1, 3, '#A0703F', 'gv')
  },
  // Fixer: bandana and a hammer that pounds twice as fast as anyone walks.
  fixer: (f, t) => {
    crabBody(f, -4, 'hm')
    stamp(f, 6, 6, ['...rrrrrrrrrrrr...', '.rrrwrrrrrwrrrrwr.', 'rrrrrrrrrrrrrrrrrr', 'rrrwrrrrrrrrwrrrrr'], { r: t, w: '#F8F6F1' })
    f(2, 8, 4, 2, t); f(1, 10, 3, 2, t)
    stamp(f, 23, 3, ['ssssss', 'shssss', 'ssssss', '..bb..', '..bb..', '..bb..', '..bb..'], { s: '#8E929A', h: '#C9CCD2', b: '#7A4A26' }, 'hm')
  },
  // Builder check: architect in a beret, holding up the rolled blueprint.
  architect: (f, t) => {
    crabBody(f, -4, 'bp')
    stamp(f, 6, 5, ['........kk........', '....tttttttttt....', '..tttttttttttttt..', '.ttttttttttttttttt', '..dddddddddddddd..'], { t, k: INK, d: '#3A3A3C' })
    stamp(f, 21, 2, ['.bbbbbbb.', 'bbwbbwbbb', 'bbbbbbbbb', '.bbbbbbb.'], { b: '#2F6FB5', w: '#CFE3F7' }, 'bp')
    f(25, 6, 1, 4, '#2F6FB5', 'bp')
  },
  // Explorer: pirate scouting the code; the cutlass fences.
  scout: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  // Planner: wizard hat; the star on the wand blinks.
  planner: (f, t) => {
    crabBody(f, -4)
    stamp(f, 8, 0, ['.......tt.....', '......tttt....', '......ttyt....', '.....tttttt...', '....ttyttttt..', '....tttttttt..', '...tttttttytt.', '..tttttttttttt'], { t, y: '#F8F6F1' })
    f(5, 8, 20, 2, '#2B2B2B')
    f(26, 4, 1, 6, '#7A4A26')
    stamp(f, 25, 1, ['.y.', 'yyy', '.y.'], { y: '#F5C542' }, 'star')
  },
  // Any other subagent: a plain crab in its own bow tie.
  crab: (f, t) => {
    crabBody(f)
    stamp(f, 12, 17, ['tt..tt', 'ttkktt', 'tt..tt'], { t, k: '#2B2B2B' })
  },
  // The main session, on the band: the captain.
  captain: f => {
    crabBody(f)
    stamp(f, 7, 5, ['...wwwwwwwwww...', '.wwwwwwggwwwwww.', 'wwwwwwggggwwwwww', 'nnnnnnnnnnnnnnnn'], { w: '#F8F6F1', g: '#F5C542', n: '#1F3A5F' })
    f(6, 9, 18, 1, INK)
  },
}

const costumeOf = (costume: string): ((f: Fill, t: string) => void) =>
  COSTUMES[costume] ?? COSTUMES.crab ?? ((f: Fill) => crabBody(f))

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
@keyframes blink{50%{opacity:.15}}
.c-implementer.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-reviewer.run .it{animation:scan 1s steps(1) infinite}
.c-reviewer.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-rereviewer.run .ck{animation:blink .5s steps(1) infinite}
.c-judge.run .gv{transform-origin:0 100%;animation:bang .5s steps(1) infinite}
.c-fixer.run .hm{transform-origin:0 100%;animation:bang .25s steps(1) infinite}
@keyframes bang{50%{transform:rotate(-25deg)}}
.c-architect.run .bp{animation:lift 1s ease-in-out infinite}
@keyframes lift{50%{transform:translateY(-2px)}}
.c-scout.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
.c-planner.run .star{animation:blink .5s steps(1) infinite}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const crab = (x: number, y: number, costume: string, hue: string, dim = false, isWalking = false, scale = CRAB_SCALE): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  costumeOf(costume)(f, hue)
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

// --- terminal crabs: the same costumes as half-block cells, each cell two
// square pixels, at half the grid: 15 columns by 7 rows.

const RASTER_COLS = 15
const RASTER_ROWS = 7
const SPRITE_W = 30
const SPRITE_H = 26
const DEFAULT_COLOR = 0x01000000
// Pixels that blink on the desktop are hidden on odd frames here.
const BLINKING: ReadonlySet<string> = new Set(['gl', 'ck', 'star'])

const parseColor = (c: string): number | null => {
  if (/^#[0-9a-f]{6}$/i.test(c)) return parseInt(c.slice(1), 16)
  if (/^#[0-9a-f]{3}$/i.test(c)) return parseInt([...c.slice(1)].map(d => d + d).join(''), 16)
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(c)
  if (!m) return null
  // Glass and other see-through paint: solid when mostly opaque, else left out.
  if (Number(m[4] ?? 1) < 0.5) return null
  return (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3])
}

// Toward a mid grey, for the crabs that have finished.
const dimColor = (c: number): number => {
  const mix = (v: number) => Math.round(v * 0.45 + 0x8a * 0.55)
  return (mix((c >> 16) & 255) << 16) | (mix((c >> 8) & 255) << 8) | mix(c & 255)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const base64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '='
  }
  return out
}

// The sprite at full size, shifted a pixel left so the body, eyes and legs fall
// on whole 2×2 blocks; `frame` lifts one leg pair and blinks the blinking props.
const spritePixels = (costume: string, hue: string, frame: number): (number | null)[] => {
  const px: (number | null)[] = new Array<number | null>(SPRITE_W * SPRITE_H).fill(null)
  const lifted = frame % 2 ? 'la' : 'lb'
  const f: Fill = (x, y, w, h, c, cls = 'bd') => {
    if (frame % 2 && BLINKING.has(cls)) return
    const color = parseColor(c)
    if (color === null) return
    const dy = cls === lifted ? -2 : 0
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const X = x + i - 1
        const Y = y + j + dy
        if (X >= 0 && X < SPRITE_W && Y >= 0 && Y < SPRITE_H) px[Y * SPRITE_W + X] = color
      }
    }
  }
  costumeOf(costume)(f, hue)
  return px
}

const CLAY_RGB = parseInt(CLAY.slice(1), 16)

// Each 2×2 block becomes its most common color; a tie goes to the detail over
// the body clay, and a block three-quarters empty is empty.
const downsample = (px: (number | null)[]): (number | null)[] => {
  const out: (number | null)[] = []
  const W2 = SPRITE_W / 2
  const H2 = SPRITE_H / 2
  for (let by = 0; by < H2; by++) {
    for (let bx = 0; bx < W2; bx++) {
      const counts = new Map<number, number>()
      let empty = 0
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const c = px[(by * 2 + dy) * SPRITE_W + bx * 2 + dx] ?? null
        if (c === null) empty++
        else counts.set(c, (counts.get(c) ?? 0) + 1)
      }
      if (empty >= 3) {
        out.push(null)
        continue
      }
      let best: number | null = null
      let bestN = 0
      for (const [c, n] of counts) {
        if (n > bestN || (n === bestN && best === CLAY_RGB)) {
          best = c
          bestN = n
        }
      }
      out.push(best)
    }
  }
  return out
}

const rasterCache = new Map<string, string>()

// The Raster's cells: `[codePoint, foreground, background]` per cell, row-major,
// little-endian u32s, base64.
const crabCells = (costume: string, hue: string, frame: number, dim: boolean): string => {
  const key = `${costume}|${hue}|${frame % 2}|${dim}`
  const hit = rasterCache.get(key)
  if (hit) return hit
  const small = downsample(spritePixels(costume, hue, frame))
  const at = (x: number, y: number): number | null => (y < SPRITE_H / 2 ? (small[y * (SPRITE_W / 2) + x] ?? null) : null)
  const paint = (c: number | null): number | null => (c === null ? null : dim ? dimColor(c) : c)
  const view = new DataView(new ArrayBuffer(RASTER_COLS * RASTER_ROWS * 12))
  let o = 0
  const put = (v: number) => {
    view.setUint32(o, v >>> 0, true)
    o += 4
  }
  for (let row = 0; row < RASTER_ROWS; row++) {
    for (let col = 0; col < RASTER_COLS; col++) {
      const top = paint(at(col, row * 2))
      const bottom = paint(at(col, row * 2 + 1))
      if (top === null && bottom === null) {
        put(0x20); put(DEFAULT_COLOR); put(DEFAULT_COLOR)
      } else if (top === null) {
        put(0x2584); put(bottom ?? DEFAULT_COLOR); put(DEFAULT_COLOR)
      } else {
        put(0x2580); put(top); put(bottom ?? DEFAULT_COLOR)
      }
    }
  }
  const cells = base64(new Uint8Array(view.buffer))
  rasterCache.set(key, cells)
  return cells
}

// ---------------------------------------------------------------------------
// Panel drawings for the desktop: each row is one SVG, as the band is.

// The pane's backdrop: a dotted grid as tall as the content laid over it; the
// row SVGs are transparent, so it shows through between their marks.
const GRID_STEP = 16
// A Text or Button row on the desktop is about 20px; the grid errs taller.
const LINE_H = 24
// The engine refuses an Svg taller than 4096px, so a long grid is stacked from
// tiles of at most this height; a multiple of GRID_STEP keeps the dots aligned.
const GRID_TILE = 4096
const gridTiles = (H: number) => Array.from({ length: Math.ceil(H / GRID_TILE) }, (_, i) => Math.min(GRID_TILE, H - i * GRID_TILE))
const gridSvg = (W: number, H: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>.d{fill:#d9d8d4}@media (prefers-color-scheme: dark){.d{fill:#3a3a38}}</style>
<defs><pattern id="g" width="${GRID_STEP}" height="${GRID_STEP}" patternUnits="userSpaceOnUse"><circle class="d" cx="${GRID_STEP / 2}" cy="${GRID_STEP / 2}" r="1"/></pattern></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
</svg>`

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

const headerHeight = (f: Flow | null): number => (f ? 60 : 0) + 44

// Title, the five phases as chips, then cost, tokens and time.
const headerSvg = (W: number, f: Flow | null, t: ReturnType<typeof totals>): string => {
  const gap = 6
  const tw = (W - gap * 2) / 3
  const top = f ? 60 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="${top}" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="${top + 16}" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="${top + 33}" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  let head = ''
  if (f) {
    const cg = 4
    const cw = (W - cg * (PHASES.length - 1)) / PHASES.length
    const chips = PHASES.map((p, i) => {
      const isPast = f.isFinished || rank(p) < rank(f.phase)
      const isNow = !f.isFinished && p === f.phase
      const x = i * (cw + cg)
      const text = fitText(`${isPast ? '✓ ' : ''}${phaseChip(f, p)}`, 11, cw - 8)
      const fill = isNow ? `fill="${ACCENT}"` : isPast ? `fill="${DONE}" fill-opacity="0.18"` : 'class="k"'
      const ink = isNow ? 'fill="#ffffff"' : isPast ? `fill="${DONE}"` : 'class="m"'
      return `<rect x="${x}" y="28" width="${cw}" height="22" rx="11" ${fill}/><text x="${x + cw / 2}" y="43" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" ${ink}>${xml(text)}</text>`
    }).join('')
    head = `<text class="t" x="0" y="15" font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(f.title, 14, W))}</text>${chips}`
  }
  return svg(W, headerHeight(f), `${head}${tile(0, 'Cost', '≈' + fmtCost(t.cost))}${tile(1, 'Tokens', fmtTokens(t.tokens))}${tile(2, 'Time', fmtTime(t.time))}`)
}

// The task's own progress when the worker reports steps; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

const metaOf = (a: AgentRun): string[] => {
  const meta = [a.name, runModel(a)]
  if (a.task) meta.push(`Task ${a.task}`)
  if (a.round > 1) meta.push(`round ${a.round}`)
  if (a.status === 'failed') meta.push('error')
  return meta
}

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const color = role(a.role).color
  const ctx = ctxOf(a)
  const barW = W - 42 - 22
  const progress = progressOf(a)
  const stats = `ctx ${ctx}% · ${fmtTokens(a.contextTokens)}  ≈${fmtCost(a.costUsd)}  ${fmtTime(elapsed(a, at))}`
  const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : ''
  const stepsW = Math.max(0, barW - textWidth(stats, 11) - 12)
  // Without reported steps the bar falls back to the context, drawn grey.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  return svg(
    W,
    66,
    `${crab(0, 14, a.role, a.hue, false, a.status === 'running')}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, barW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(roleWord(a))}</tspan><tspan class="s">  ${xml(fitText(metaOf(a).join('  ·  '), 11, barW - textWidth(roleWord(a), 11) - 8))}</tspan></text>
${steps && stepsW > 30 ? `<text class="t" x="42" y="49" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(steps, 11, stepsW))}</text>` : ''}
<text class="s" x="${42 + barW}" y="49" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<rect class="k" x="42" y="55" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="42" y="55" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${color}"`}/>
${statusMark(W - 8, 16, a.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

const upNextSvg = (W: number, t: PlanTask, isCurrent: boolean): string => {
  const color = ROLES.implementer.color
  const textW = W - 42 - 22
  const meta = isCurrent ? 'in progress · main session' : t.fixRound ? `fix round ${t.fixRound}` : 'waiting'
  return svg(
    W,
    46,
    `${crab(0, 6, 'implementer', color, !isCurrent, isCurrent)}
<text class="${isCurrent ? 't' : 's'}" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${t.n}. ${t.title}`, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">implementer</tspan><tspan class="m">  ${xml(meta)}</tspan></text>
${statusMark(W - 8, 16, isCurrent ? 'running' : 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], upNext: PlanTask[], t: ReturnType<typeof totals>): string => {
  const icons = [
    ...list.filter(a => a.status === 'running').map(a => ({ k: a.role as string, hue: a.hue, c: role(a.role).color, isRunning: true, dim: false })),
    ...list.filter(a => a.status !== 'running').map(a => ({ k: a.role as string, hue: a.hue, c: role(a.role).color, isRunning: false, dim: false })),
    ...upNext.map(() => ({ k: 'implementer', hue: ROLES.implementer.color, c: ROLES.implementer.color, isRunning: false, dim: true })),
  ]
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((ic, i) => crab(i * 36, 0, ic.k, ic.hue, ic.dim, ic.isRunning) + (ic.isRunning ? `<circle class="live" cx="${i * 36 + 32}" cy="4" r="3" fill="${ic.c}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" x="${x}" y="21" font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" x="${W}" y="21" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// --- terminal text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }

// ---------------------------------------------------------------------------

const readText = async ($: EngineInterface, path: string): Promise<string | null> => {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

// What a tool call printed, or '' for an error or a deny.
const outputOf = (res: unknown): string => {
  const r = res as { deny?: string; isError?: boolean; result?: { stdout?: unknown }; text?: unknown }
  if (r.deny !== undefined || r.isError) return ''
  if (typeof r.result?.stdout === 'string') return r.result.stdout
  return typeof r.text === 'string' ? r.text : ''
}

const isOk = (res: unknown): boolean => {
  const r = res as { deny?: string; isError?: boolean }
  return r.deny === undefined && !r.isError
}

// Module scope is fine: a reload only reads the ledger once more.
let ledgerSeen = { ws: '', text: '' }

// Opens the crew pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  return true
}

// Once per workflow (or per key): never reopens a pane the person closed.
async function autoOpen($: EngineInterface, mode: string, key: string, isSuperpowers: boolean): Promise<void> {
  if (mode === 'off' || (!isSuperpowers && mode !== 'any')) return
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  void $.ui.open({ id: PANE, title: PANE_TITLE })
}

// A new workflow starts with a clean list; agents still running stay.
async function clearFinished($: EngineInterface): Promise<void> {
  await update($, agents, list => list.filter(a => a.status === 'running'))
}

async function moveTo($: EngineInterface, to: Phase, patch: Partial<Flow> = {}): Promise<Flow | null> {
  const isFresh = isNewFlowFor(await read($, flow), to)
  if (isFresh) await clearFinished($)
  const at = await $.clock.now()
  return update($, flow, p => {
    const base = isFresh || !p ? blank(to, at) : p
    const phase = to === 'plan' && base.phase === 'build' ? 'plan' : advance(base.phase, to)
    return { ...base, ...patch, phase }
  })
}

async function adoptPlan($: EngineInterface, path: string, text: string): Promise<void> {
  const parsed = parsePlan(text)
  const prev = await read($, flow)
  // Another plan while one is building or later is a new workflow.
  const isOther = !!prev && !prev.isFinished && !!prev.planPath && prev.planPath !== path && rank(prev.phase) >= rank('build')
  const isFresh = !prev || prev.isFinished || isOther
  if (isFresh) await clearFinished($)
  const at = await $.clock.now()
  await update($, flow, p => {
    const base = isFresh || !p ? blank('plan', at) : p
    const tasks = parsed.tasks.map(t => {
      const old = base.tasks.find(o => o.n === t.n)
      return { ...t, isDone: old?.isDone ?? false, fixRound: old?.fixRound ?? 0 }
    })
    return {
      ...base,
      title: parsed.title || base.title,
      planPath: path,
      hasPlan: true,
      tasks,
      phase: rank(base.phase) < rank('plan') ? 'plan' : base.phase,
    }
  })
}

async function applyLedger($: EngineInterface, ws: string, text: string): Promise<void> {
  const { done, rounds } = parseLedger(text)
  await update($, flow, p => {
    if (!p || p.isFinished) return p
    const tasks = p.tasks.map(t => ({ ...t, isDone: done.has(t.n), fixRound: rounds.get(t.n) ?? 0 }))
    const next: Flow = { ...p, workspace: ws, tasks, done: Math.max(done.size, tasks.filter(t => t.isDone).length) }
    if (done.has(next.current)) next.current = 0
    // Every task in: the final review is next, in both executors.
    if (next.phase === 'build' && isAllDone(next)) next.phase = 'review'
    return next
  })
}

async function refreshLedger($: EngineInterface): Promise<void> {
  const f = await read($, flow)
  if (!f || f.isFinished || !f.workspace) return
  const ws = f.workspace
  const text = await readText($, `${ws}/progress.md`)
  if (text === null) {
    // The workspace is deleted once the final review is clean: SDD's step before finishing.
    const isGone = !(await $.fs.exists(ws).catch(() => true))
    if (isGone) {
      await update($, flow, p =>
        p && p.workspace === ws
          ? { ...p, workspace: '', isFinalReviewed: rank(p.phase) >= rank('build'), phase: advance(p.phase, 'review') }
          : p,
      )
    }
    return
  }
  if (ledgerSeen.ws === ws && ledgerSeen.text === text) return
  ledgerSeen = { ws, text }
  await applyLedger($, ws, text)
}

// A workspace path seen anywhere: adopt its plan and ledger, or re-read the ledger.
async function noteWorkspace($: EngineInterface, ws: string): Promise<void> {
  const f = await read($, flow)
  if (f && !f.isFinished && f.workspace === ws) return refreshLedger($)
  const ledger = await readText($, `${ws}/progress.md`)
  const marker = await readText($, `${ws}/plan-path`)
  if (ledger === null && marker === null) return
  const ref = marker?.trim() || (ledger ? parseLedger(ledger).plan : '')
  const planPath = ref ? (ref.startsWith('/') ? ref : `${rootOf(ws)}/${ref}`) : ''
  const planText = planPath ? await readText($, planPath) : null
  if (planPath && planText !== null) await adoptPlan($, planPath, planText)
  await moveTo($, 'build', { workspace: ws })
  ledgerSeen = { ws: '', text: '' }
  await refreshLedger($)
}

async function noteSpec($: EngineInterface, text: string): Promise<void> {
  const f = await read($, flow)
  if (f && !f.isFinished && f.phase !== 'brainstorm') return
  if (!f || f.isFinished) await moveTo($, 'brainstorm')
  const title = cleanTitle(/^#\s+(.+)$/m.exec(text)?.[1] ?? '')
  await update($, flow, p => (p ? { ...p, hasSpec: true, title: title || p.title } : p))
}

async function onSkill($: EngineInterface, mode: string, skill: string): Promise<void> {
  const to = phaseOfSkill(skill)
  if (!to) return
  const f = await read($, flow)
  // requesting-code-review also runs between tasks; only a finished build moves on.
  if (to === 'review' && f && !f.isFinished && f.phase === 'build' && !isAllDone(f)) return
  const patch: Partial<Flow> = to === 'build' ? { mode: /executing-plans$/.test(skill) ? 'inline' : 'subagents' } : {}
  const next = await moveTo($, to, patch)
  if (to === 'build' && next) await autoOpen($, mode, `flow:${next.epoch}`, true)
}

async function watchFile($: EngineInterface, path: string, content: string | null, agentId?: string): Promise<void> {
  const ws = workspaceIn(path)
  if (ws) return noteWorkspace($, ws)
  // Specs and plans are the main session's; a worker writing a markdown file is not planning.
  if (agentId) return
  if (isSpecFile(path)) {
    const text = content ?? (await readText($, path))
    if (text) await noteSpec($, text)
  } else if (isPlanFile(path, content ?? '')) {
    const text = content ?? (await readText($, path))
    if (text) await adoptPlan($, path, text)
  }
}

async function watchBash($: EngineInterface, command: string, stdout: string, isDone: boolean, agentId?: string): Promise<void> {
  const ws = workspaceIn(stdout) || workspaceIn(command)
  if (ws) await noteWorkspace($, ws)
  if (agentId || !isDone) return
  // `task-brief PLAN N` (subagent-driven) and `task-start PLAN N` (inline) name the task in hand.
  const started = /\b(task-start|task-brief)\s+\S+\s+(\d+)\b/.exec(command)
  if (started) {
    if (started[1] === 'task-start') await moveTo($, 'build', { mode: 'inline' })
    const n = Number(started[2])
    await update($, flow, p => (p && !p.isFinished && !p.tasks.some(t => t.n === n && t.isDone) ? { ...p, current: n } : p))
  }
  if (/progress\.md|task-done/.test(command)) await refreshLedger($)
  const f = await read($, flow)
  if (f && !f.isFinished && f.phase === 'finish' && FINISHED_BY.test(command)) {
    await update($, flow, p => (p ? { ...p, isFinished: true, current: 0 } : p))
  }
}

export const register: Register = (on, options) => {
  const autoOpenMode = String(options.autoOpen ?? 'superpowers')
  const wantsSteps = String(options.workerSteps ?? 'on') !== 'off'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'step',
      description:
        'For subagents in a superpowers workflow: report progress on your own task to the crew panel. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
      // In every agent's tool list, not behind ToolSearch: workers do not go looking for it.
      isDeferred: false,
    })
    await $.command.register({
      name: 'crew',
      description: 'Show or hide the superpowers crew panel; `/crew open` brings it forward, `/crew reset` clears the workflow',
    })

    // Ticks the running crabs' clocks each second, and every other second picks
    // up ledger lines however they were written.
    let ticks = 0
    $.clock.every(1000, () => {
      void (async () => {
        ticks++
        const list = await read($, agents)
        if (list.some(a => a.status === 'running')) {
          const at = await $.clock.now()
          await update($, now, () => at)
        }
        if (ticks % 2 === 0) await refreshLedger($)
      })().catch(() => undefined)
    })
    return started
  })

  on('command.run', { command: 'crew' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    if (arg === 'open') {
      const at = await $.clock.now()
      await update($, now, () => at)
      await $.ui.open({ id: PANE, title: PANE_TITLE })
      return { text: 'Crew panel opened.' }
    }
    if (arg === 'reset') {
      await update($, flow, () => null)
      await clearFinished($)
      return { text: 'Superpowers workflow cleared.' }
    }
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Crew panel opened.' : 'Crew panel closed.' }
  })

  // The skills the main session loads set the phase; a worker loading TDD does not.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const res = await next(e)
    if (!e.agentId && isOk(res)) await onSkill($, autoOpenMode, String(e.skill ?? '')).catch(() => undefined)
    return res
  })

  // A skill typed as a slash command (`/superpowers:brainstorming`).
  on('prompt.submit', async ($, e, next) => {
    const res = await next(e)
    if (e.command?.name) await onSkill($, autoOpenMode, e.command.name).catch(() => undefined)
    return res
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const res = await next(e)
    await watchBash($, String(e.command ?? ''), outputOf(res), isOk(res), e.agentId).catch(() => undefined)
    return res
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const res = await next(e)
    if (isOk(res)) await watchFile($, String(e.file_path ?? ''), String(e.content ?? ''), e.agentId).catch(() => undefined)
    return res
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const res = await next(e)
    if (isOk(res)) await watchFile($, String(e.file_path ?? ''), null, e.agentId).catch(() => undefined)
    return res
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    let matched = false
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        matched = true
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: clip(input.note?.trim() ?? '', 80) || undefined }
      }),
    )
    return { result: matched ? 'ok' : `ignored: no panel row for agent ${agentId}` }
  })

  on('agent.spawn', async ($, e, next) => {
    const kind = roleOf(e.subagentType, e.description, e.prompt)
    const isSuperpowers = SP_ROLES.has(kind)
    // A resume's prompt cannot be rewritten; it is the message the agent wakes to.
    const isUnbriefed = isSuperpowers && wantsSteps && !e.resume && !e.prompt.includes(STEP_TOOL)
    const started = await next(isUnbriefed ? { ...e, prompt: e.prompt + STEP_BRIEF } : e)
    if (started.deny !== undefined) return started
    const at = await $.clock.now()

    // Fix rounds 1-3 resume the implementer: the same crab goes back to work.
    const resumed = e.resume?.agentId
    if (resumed) {
      let isKnown = false
      await update($, agents, list =>
        list.map((a): AgentRun => {
          if (a.agentId !== resumed) return a
          isKnown = true
          return { ...a, status: 'running', endedAt: undefined, round: a.round + 1, stepDone: undefined, stepTotal: undefined, stepNote: undefined }
        }),
      )
      if (isKnown) {
        await update($, now, () => at)
        return started
      }
    }

    const i = await update($, seq, n => n + 1)
    const task = isSuperpowers ? taskOf(e.description, e.prompt) : 0
    await update($, agents, list => {
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round: 1,
        role: kind,
        task,
        name: nameOf(Math.max(0, i - 1)),
        hue: hueOf(Math.max(0, i - 1)),
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)

    if (isSuperpowers) {
      const f = await read($, flow)
      const isOpen = !!f && !f.isFinished
      if (kind === 'architect') {
        if (!isOpen) await moveTo($, 'brainstorm')
      } else if (kind === 'judge') {
        if (!isOpen || (f.phase === 'build' && isAllDone(f))) await moveTo($, 'review')
      } else if (!isOpen || rank(f.phase) < rank('build')) {
        await moveTo($, 'build')
      }
      if (task && kind === 'implementer') {
        await update($, flow, p => (p && !p.isFinished && !p.tasks.some(t => t.n === task && t.isDone) ? { ...p, current: task } : p))
      }
      const g = await read($, flow)
      await autoOpen($, autoOpenMode, `flow:${g?.epoch ?? 0}`, true)
    } else {
      await autoOpen($, autoOpenMode, 'any-agent', false)
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map((a): AgentRun =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage, true),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map((a): AgentRun => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage, false),
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const upNext = upNextOf(f, list)
    const t = totals(list, at)
    const shown = f
    const current = f && !f.isFinished && f.current ? f.tasks.find(x => x.n === f.current) : undefined
    const nowLine = current ? `Now: Task ${current.n} · ${current.title}` : ''

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? 'Expand' : 'Collapse'}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const isEmpty = list.length === 0 && upNext.length === 0
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} tokens, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )
      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1}>
            <Svg source={compactSvg(W, list, upNext, t)} alt={`${list.length} crabs, ${summary}`} width={W} height={32} />
            {toggleCompact}
          </Box>
        )
      }
      const shownDone = p.isDoneCollapsed ? 0 : finished.length
      const lines = 1 + (nowLine ? 1 : 0) + (isEmpty ? 1 : 0) + (running.length > 0 ? 1 : 0) + (finished.length > 0 ? 1 : 0) + (upNext.length > 0 ? 1 : 0)
      const gridH = headerHeight(shown) + lines * LINE_H + (running.length + shownDone) * 66 + upNext.length * 46
      return (
        <Box flexDirection="column">
          {/* The grid sizes the pane; the content is placed over it, as an
              absolute Box paints over the siblings before it. */}
          {gridTiles(gridH).map((tileH, i) => (
            <Svg key={`grid-${i}`} source={gridSvg(W, tileH)} alt="dotted grid" width={W} height={tileH} />
          ))}
          <Box flexDirection="column" position="absolute" top={0} left={0} right={0}>
            <Svg
              source={headerSvg(W, shown, t)}
              alt={shown ? `${shown.title}: ${label(shown)}; ${summary}` : summary}
              width={W}
              height={headerHeight(shown)}
            />
            {toggleCompact}
            {nowLine && <Text dimColor>{nowLine}</Text>}
            {isEmpty && <Text dimColor>No crabs yet.</Text>}
            {running.length > 0 && section('h-run', `Running · ${running.length}`)}
            {running.map(a => (
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.name} the ${roleWord(a)}: ${a.description}, running`} width={W} height={66} />
            ))}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed &&
              finished.map(a => (
                <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.name} the ${roleWord(a)}: ${a.description}, ${a.status}`} width={W} height={66} />
              ))}
            {upNext.length > 0 && section('h-next', `Up next · ${upNext.length}`)}
            {upNext.map(task => (
              <Svg
                key={`next-${task.n}`}
                source={upNextSvg(W, task, task.n === f?.current)}
                alt={`${task.n}. ${task.title}: ${task.n === f?.current ? 'in progress' : 'waiting'}`}
                width={W}
                height={46}
              />
            ))}
          </Box>
        </Box>
      )
    }

    // Terminal and the rest: the crew as half-block crabs where the surface has
    // a Raster, then the same rows in text.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const frame = Math.floor(at / 1000)

    const stepper = shown ? (
      <Text wrap="truncate-end">
        {PHASES.map((ph, i) => {
          const isPast = shown.isFinished || rank(ph) < rank(shown.phase)
          const isNow = !shown.isFinished && ph === shown.phase
          return (
            <Text key={ph} color={isNow ? ACCENT : isPast ? DONE : undefined} bold={isNow} dimColor={!isNow && !isPast}>
              {i ? ' › ' : ''}
              {isPast ? '✓' : isNow ? '●' : '○'} {phaseChip(shown, ph)}
            </Text>
          )
        })}
      </Text>
    ) : null

    const crew =
      e.surface === 'terminal' && 'Raster' in ui && list.length > 0
        ? (() => {
      const { Raster } = ui
      const perRow = Math.max(1, Math.floor((cols + 1) / (RASTER_COLS + 1)))
      const crabs = [...running, ...finished].slice(0, perRow * (p.isCompact ? 3 : 2))
      const more = list.length - crabs.length
      const rows: AgentRun[][] = []
      for (let i = 0; i < crabs.length; i += perRow) rows.push(crabs.slice(i, i + perRow))
      return (
        <Box flexDirection="column" marginTop={1}>
          {rows.map((row, r) => (
            <Box key={`crew-${r}`} flexDirection="row" gap={1} marginBottom={1}>
              {row.map(a => (
                <Box key={`crab-${a.id}`} flexDirection="column" width={RASTER_COLS}>
                  <Raster
                    key={`raster-${a.id}`}
                    columns={RASTER_COLS}
                    rows={RASTER_ROWS}
                    cells={crabCells(a.role, a.hue, a.status === 'running' ? frame : 0, a.status !== 'running')}
                  />
                  <Text color={a.hue} bold wrap="truncate-end">
                    {a.name}
                  </Text>
                  <Text color={a.status === 'running' ? role(a.role).color : undefined} dimColor={a.status !== 'running'} wrap="truncate-end">
                    {STATUS_GLYPH[a.status]} {role(a.role).short}
                    {a.task ? ` T${a.task}` : ''}
                  </Text>
                </Box>
              ))}
            </Box>
          ))}
          {more > 0 && <Text dimColor>+{more} more</Text>}
        </Box>
      )
          })()
        : null

    const row = (a: AgentRun) => {
      const color = role(a.role).color
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''} · ` : ''
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={a.hue}>▣</Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text wrap="truncate-end">
            {'  '}
            <Text color={color}>{roleWord(a)}</Text>
            <Text dimColor> · {metaOf(a).join(' · ')}</Text>
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
            <Text dimColor>
              {' '}
              {steps}ctx {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
            </Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {shown ? `${shown.title} · ${label(shown)}` : 'Superpowers crew'}
          </Text>
          {toggleCompact}
        </Box>
        {stepper}
        <Text dimColor>
          ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} tokens · {fmtTime(t.time)}
        </Text>
        {nowLine && <Text color={ROLES.implementer.color} wrap="truncate-end">{nowLine}</Text>}
        {crew}
        {p.isCompact ? (
          crew ? null : (
            <Text wrap="truncate-end">
              {[...running, ...finished].map(a => (
                <Text key={a.id} color={role(a.role).color}>
                  {STATUS_GLYPH[a.status]}{' '}
                </Text>
              ))}
              {upNext.map(task => (
                <Text key={`next-${task.n}`} dimColor>
                  ◷{' '}
                </Text>
              ))}
            </Text>
          )
        ) : (
          <Box flexDirection="column" marginTop={crew ? 0 : 1}>
            {isEmpty && <Text dimColor>No crabs yet.</Text>}
            {running.length > 0 && <Text dimColor>Running · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
            {upNext.length > 0 && <Text dimColor>Up next · {upNext.length}</Text>}
            {upNext.map(task => (
              <Box key={`next-${task.n}`} flexDirection="column" marginBottom={1}>
                <Text dimColor={task.n !== f?.current} wrap="truncate-end">
                  <Text color={ROLES.implementer.color}>▢</Text> {task.n}. {task.title} {task.n === f?.current ? '●' : '◷'}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {'  '}implementer · {task.n === f?.current ? 'in progress · main session' : task.fixRound ? `fix round ${task.fixRound}` : 'waiting'}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, flow)
    if (f === null || e.props.hasSurvey) return next(e)
    // Draw this row with the other mods' bands beneath it. Claude Code's own placeholder ({ type: 'engine' }) is
    // never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const crewSize = list.length + upNextOf(f, list).length
    const isWorking = list.some(a => a.status === 'running')
    const crewButton = <Button key="superpowers-crew" label={`×${crewSize}`} plain onPress={() => void togglePane($)} />
    const percent = `${Math.round(ratio(f) * 100)}%`
    const dismiss = <Button key="superpowers-dismiss" label="✕" plain role="dismiss" onPress={() => update($, flow, () => null)} />

    // The terminal's element table is completed with an `Svg` that draws nothing: test the surface too.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={rowSvg(f, width, isWorking, inFlight(f, list))} alt={`${f.title}: ${label(f)}, ${percent}`} width={width} height={H} />
            {crewButton}
            {dismiss}
          </Box>
          {below}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 34))
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Box width={titleW} flexShrink={0}>
            <Text color={f.isFinished ? DONE : ACCENT}>● </Text>
            <Text wrap="truncate-end">{f.title}</Text>
          </Box>
          <Text color={f.isFinished ? DONE : ACCENT}>{barText(f, width)}</Text>
          <Text bold>{label(f)}</Text>
          <Text dimColor>{percent}</Text>
          <Text color={CLAY}>{isWorking ? '🦀' : '▣'}</Text>
          {crewButton}
          {dismiss}
        </Box>
        {below}
      </Box>
    )
  })
}
