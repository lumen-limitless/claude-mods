import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The world beneath the plugin in its tests: a file system held in `files`, and
// Skill, Write and Bash calls that succeed, Bash printing what superpowers'
// scripts print.

export const PLUGIN = 'superpowers-progress'
export const STEP_TOOL = 'mcp__superpowers-progress__step'
export const WS = '/repo/.superpowers/sdd/2026-10-22-parser'
export const PLAN_PATH = '/repo/docs/superpowers/plans/2026-10-22-parser.md'
export const PLAN = `# Parser Implementation Plan

> **For agentic workers:** use superpowers:subagent-driven-development.

## Global Constraints

\`\`\`md
### Task 9: inside a fence, not a task
\`\`\`

### Task 1: Tokenizer

- [ ] Step 1: write the failing test

### Task 2: **Grammar**

### Task 3: Wire the CLI
`
export const LEDGER_HEAD = '# SDD ledger — plan: docs/superpowers/plans/2026-10-22-parser.md\n'

export const band = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} }
export const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

// `opened` collects the ids of the panes the plugin opens.
export function world(on: On, files: Record<string, string>, opened: string[] = []): void {
  mock.clock(on, { now: Date.parse('2026-10-22T10:00:00Z') })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text } as never
  })
  on('fs.exists', (_$, e) => ({ value: Object.keys(files).some(k => k === e.path || k.startsWith(e.path + '/')) }) as never)
  // The engine's own band: nothing of its own to draw.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', { tool: 'Skill' }, () => ({ result: { success: true } }) as never)
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create' } }) as never)
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }) as never)
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    const command = String(e.command)
    const n = /\b(?:task-brief|task-start)\s+\S+\s+(\d+)/.exec(command)?.[1]
    const stdout = /sdd-workspace/.test(command)
      ? `${WS}\n`
      : /task-start/.test(command)
        ? `brief: ${WS}/task-${n}-brief.md\nbase: 0123456789abcdef\n`
        : /task-brief/.test(command)
          ? `wrote ${WS}/task-${n}-brief.md: 40 lines\n`
          : ''
    return { result: { stdout, stderr: '', interrupted: false } } as never
  })
}

export const skill = ($: Engine, name: string, agentId?: string) =>
  $.tool.call({ tool: 'Skill', skill: name, ...(agentId ? { agentId } : {}) } as never)

export const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command } as never)

// Whether the band shows `re`: in a Text on the terminal, in the row's Svg on the desktop.
export async function bandShows($: Engine, surface: 'terminal' | 'desktop', re: RegExp): Promise<boolean> {
  const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: band as never })
  try {
    if (surface === 'desktop') return (await ui.findAll({ type: 'Svg' })).some(el => re.test(String(el.props.source)))
    return (await ui.find({ type: 'Text', text: re })) !== undefined
  } finally {
    await ui.unmount()
  }
}

// Spawns a subagent the way an Agent call does; the agent ids count up from a1.
export function crew($: Engine, on: On, model = 'claude-haiku-5-5') {
  const prompts: Record<string, string> = {}
  let n = 0
  on('agent.spawn', (_$, e) => {
    const agentId = e.resume?.agentId ?? `a${++n}`
    prompts[agentId] = e.prompt
    return { model, agentId }
  })
  const spawn = (description: string, prompt: string, subagentType = 'general-purpose', resume?: string) =>
    $.agent.spawn({
      tool_use_id: `t${n + 1}`,
      prompt,
      description,
      subagentType,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
      ...(resume ? { resume: { agentId: resume } } : {}),
    } as never)
  const complete = (agentId: string) =>
    ($.turn.complete as (e: unknown) => Promise<unknown>)({ agentId, reason: 'answer', answer: 'DONE' })
  return { prompts, spawn, complete }
}
