/** The superpowers lifecycle, in order. */
export type Phase = 'brainstorm' | 'plan' | 'build' | 'review' | 'finish'

/** One `### Task N:` of the plan, with what the SDD ledger says of it. */
export type PlanTask = {
  n: number
  title: string
  isDone: boolean
  /** The last `Task N: fix round R/5` line, 0 for none. */
  fixRound: number
}

export type Flow = {
  /** When the workflow started; names it for the panel's open-once rule. */
  epoch: number
  title: string
  phase: Phase
  isFinished: boolean
  /** subagent-driven-development or executing-plans; '' before execution starts. */
  mode: 'subagents' | 'inline' | ''
  hasSpec: boolean
  hasPlan: boolean
  /** Absolute path of the plan file, '' until one is seen. */
  planPath: string
  /** Absolute path of the plan's `.superpowers/sdd/<slug>` workspace. */
  workspace: string
  tasks: PlanTask[]
  /** Tasks the ledger records complete; can exceed what the plan parse found. */
  done: number
  /** The task the controller is on (task-brief / task-start), 0 for none. */
  current: number
  /** The workspace was deleted after the final review came back clean. */
  isFinalReviewed: boolean
}

export type Role =
  | 'implementer'
  | 'reviewer'
  | 'rereviewer'
  | 'judge'
  | 'fixer'
  | 'architect'
  | 'scout'
  | 'planner'
  | 'crab'

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  /** 1, then +1 each time the run is resumed (fix rounds 1-3). */
  round: number
  role: Role
  /** The plan task the run works on, 0 for none. */
  task: number
  /** This crab's own name and accent color. */
  name: string
  hue: string
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

declare module 'claude-code' {
  interface PluginState {
    'superpowers-progress': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      now: number
      /** Crabs hatched this session: picks the next name and color. */
      seq: number
    }
  }
}
