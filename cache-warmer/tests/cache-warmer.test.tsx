import { expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { HookStream, ModelUsage, On, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

const T0 = 1_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const PANE = {
  plugin: 'cache-warmer',
  component: 'Pane',
  requestId: 'cache-warmer',
  props: {
    title: 'Cache',
    isFocused: false,
    bodyColumns: 34,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

// The person typing `/cache-warmer on` at the prompt.
const TYPED = {
  command: 'cache-warmer',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const usage = (read: number, written: number): ModelUsage => ({
  input_tokens: 10,
  output_tokens: 2,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: written,
})

// The engine beneath the mod: a clock, a store, and the calls it makes.
function engine(on: On, store: Record<string, unknown>, forkUsage: () => ModelUsage) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, store)
  const forks: string[] = []
  const toasts: string[] = []
  let stepUsage = usage(90_000, 2_000)
  on('command.register', () => ({ value: { command: 'cache-warmer' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('model.fork', (_, e) => {
    forks.push(e.prompt)

    return { value: { isAnswered: true, text: 'ok', usage: forkUsage() } }
  })
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { ...stepUsage, model: e.model },
    }
  })

  return {
    clock,
    forks,
    toasts,
    setStepUsage: (next: ModelUsage) => {
      stepUsage = next
    },
  }
}

type Stepper = {
  turn: { step: (input: TurnStepInput) => HookStream<TurnStepChunk, TurnStepResult> }
}

// The mock clock resolves at most 10,000 waits per advance: walk long spans an hour at a time.
async function pass(clock: MockClock, ms: number) {
  for (let left = ms; left > 0; left -= HOUR) await clock.advance(Math.min(HOUR, left))
}

async function reply($: Stepper, turnId: string) {
  const step = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of step) {
    // The mock answers with no chunks.
  }

  return step.result
}

test('keeps a warm cache warm with a hidden ping a minute before it lapses', async ($, on) => {
  const world = engine(on, { ttl: '5m' }, () => usage(92_000, 0))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await reply($, 't1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /● warm/ }))?.text).toBe('● warm  5:00 left')
    expect((await ui.find({ type: 'Text', text: /TTL/ }))?.text).toBe('TTL 5m (set) · 92k cached')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'keep-warm' })
  await world.clock.advance(4 * MINUTE - 1_500)
  expect(world.forks).toHaveLength(0)
  expect((await ui.find({ type: 'Text', text: /next ping/ }))?.text).toBe('next ping in 0:02 · off in 24h')

  await world.clock.advance(2_000)
  expect(world.forks).toHaveLength(1)
  expect((await ui.find({ type: 'Text', text: /● warm/ }))?.text).toBe('● warm  5:00 left')
  expect((await ui.find({ type: 'Text', text: /ping ·/ }))?.text).toBe('1 ping · 92k read · hit 0s ago')

  // One ping per lapse window, not one per tick.
  await world.clock.advance(4 * MINUTE)
  expect(world.forks).toHaveLength(2)
  await ui.unmount()
})

test('learns the hour TTL from a hit after a gap longer than five minutes', async ($, on) => {
  const world = engine(on, { ttl: '5m' }, () => usage(92_000, 0))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await reply($, 't1')
  await world.clock.advance(10 * MINUTE)
  world.setStepUsage(usage(92_000, 500))
  await reply($, 't2')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /TTL/ }))?.text).toBe('TTL 1h (learned) · 93k cached')
  expect((await ui.find({ type: 'Text', text: /● warm/ }))?.text).toBe('● warm  60:00 left')
  expect(world.forks).toHaveLength(0)
  await ui.unmount()
})

test('a keep-warm ping that had to rewrite the entry teaches the five-minute TTL', async ($, on) => {
  const world = engine(on, {}, () => usage(4_000, 88_000))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await reply($, 't1')
  await $.command.run({ ...TYPED, args: 'on' })
  await world.clock.advance(57 * MINUTE + 500)
  expect(world.forks).toHaveLength(1)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /TTL/ }))?.text).toBe('TTL 5m (learned) · 92k cached')
  expect((await ui.find({ type: 'Text', text: /next ping/ }))?.text).toBe('next ping in 4:00 · off in 24h')
  await ui.unmount()
})

test('stops keeping warm when prompt caching is off', async ($, on) => {
  const world = engine(on, { ttl: '5m' }, () => usage(0, 0))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await reply($, 't1')
  await $.command.run({ ...TYPED, args: 'on' })
  await world.clock.advance(4 * MINUTE + 500)
  expect(world.forks).toHaveLength(1)
  expect(world.toasts).toEqual(['cache-warmer: prompt caching looks off, so Keep warm stopped'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Keep warm is/ }))?.text).toBe('Keep warm is off')
  await world.clock.advance(10 * MINUTE)
  expect(world.forks).toHaveLength(1)
  await ui.unmount()
})

test('holds off while the cached context is under 50k', async ($, on) => {
  const world = engine(on, { ttl: '5m' }, () => usage(30_000, 0))
  world.setStepUsage(usage(28_000, 2_000))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await reply($, 't1')
  await $.command.run({ ...TYPED, args: 'on' })
  await world.clock.advance(10 * MINUTE)
  expect(world.forks).toHaveLength(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /holds off/ }))?.text).toBe('holds off below 50k context')
  await ui.unmount()
})

test('a lower minContext warms a smaller context', { options: { minContext: '25k' } }, async ($, on) => {
  const world = engine(on, { ttl: '5m' }, () => usage(30_000, 0))
  world.setStepUsage(usage(28_000, 2_000))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await reply($, 't1')
  await $.command.run({ ...TYPED, args: 'on' })
  await world.clock.advance(4 * MINUTE + 500)
  expect(world.forks).toHaveLength(1)
})

test(
  'turns Keep warm off 24 hours after the last turn',
  { timeoutMs: 300_000 },
  async ($, on) => {
    const world = engine(on, { ttl: '1h' }, () => usage(92_000, 0))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await reply($, 't1')
    await $.command.run({ ...TYPED, args: 'on' })

    // A turn halfway through starts the 24 hours again.
    await pass(world.clock, 12 * HOUR)
    await reply($, 't2')
    await pass(world.clock, 12 * HOUR + MINUTE)
    expect(world.toasts).toEqual([])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /next ping/ }))?.text).toMatch(/· off in 12h$/)

    await pass(world.clock, 12 * HOUR)
    expect(world.toasts).toEqual(['cache-warmer: Keep warm turned off after 24h without a turn'])
    expect((await ui.find({ type: 'Text', text: /Keep warm is/ }))?.text).toBe('Keep warm is off')

    const sent = world.forks.length
    await pass(world.clock, 3 * HOUR)
    expect(world.forks).toHaveLength(sent)
    await ui.unmount()
  },
)
