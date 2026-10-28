import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { CacheTtl, PingOutcome, Pings, Ttl, Warmth } from '../types'

const PANE = 'cache-warmer'
const PANE_OPEN = { id: PANE, title: 'Cache', rows: 6, columns: 34 } as const

const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
// How long before the entry lapses a keep-warm ping goes out.
const LEAD_MS: Record<CacheTtl, number> = { '5m': 60_000, '1h': 3 * 60_000 }
const RETRY_MS = 30_000
// A gap a five-minute entry could not have survived.
const PAST_FIVE_MINUTES = 5 * 60_000 + 20_000
// Keep warm stops after this long without a turn: past it, odds are nobody comes back.
const AUTO_OFF_MS = 24 * 60 * 60_000
// The `minContext` option's picks, in tokens.
const MIN_CONTEXT: Record<string, number> = {
  any: 0,
  '25k': 25_000,
  '50k': 50_000,
  '100k': 100_000,
  '200k': 200_000,
}
const PING_PROMPT =
  'Prompt-cache keep-alive ping from the cache-warmer mod; nobody reads the reply. Do not use tools. Reply with exactly: ok'

const NO_WARMTH: Warmth = { at: null, tokens: 0 }
const NO_PINGS: Pings = { count: 0, tokensRead: 0, last: null }
const ASSUMED: Ttl = { value: '1h', source: 'assumed' }

const warmth = atom({ plugin: 'cache-warmer', key: 'warmth' } as const, NO_WARMTH)
const activeAt = atom({ plugin: 'cache-warmer', key: 'activeAt' } as const, null)
const ttl = atom({ plugin: 'cache-warmer', key: 'ttl' } as const, ASSUMED)
const isKeepWarm = atom({ plugin: 'cache-warmer', key: 'isKeepWarm' } as const, false)
const isPinging = atom({ plugin: 'cache-warmer', key: 'isPinging' } as const, false)
const pings = atom({ plugin: 'cache-warmer', key: 'pings' } as const, NO_PINGS)
const now = atom({ plugin: 'cache-warmer', key: 'now' } as const, 0)

// The entry was alive when the cache served at least half of what it last
// held, or more than the request had to write.
function outcomeOf(usage: ModelUsage, lastTokens: number): PingOutcome {
  const served = usage.cache_read_input_tokens
  const written = usage.cache_creation_input_tokens
  if (served === 0 && written === 0) return 'uncached'

  return served >= Math.min(written, lastTokens / 2) ? 'hit' : 'rewrote'
}

// What a request sent `gap` ms after the cache was last touched proves.
function learnTtl(gap: number, outcome: PingOutcome): CacheTtl | undefined {
  if (gap <= PAST_FIVE_MINUTES) return undefined
  if (outcome === 'hit') return '1h'
  if (outcome === 'rewrote' && gap < TTL_MS['1h'] - 60_000) return '5m'

  return undefined
}

const prefixOf = (usage: ModelUsage) =>
  usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.input_tokens

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`

  return `${Math.round(s / 3600)}h ago`
}

function span(ms: number): string {
  return ms >= 3_600_000 ? `${Math.ceil(ms / 3_600_000)}h` : `${Math.max(1, Math.ceil(ms / 60_000))}m`
}

function size(tokens: number): string {
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(1)}M`
  if (tokens >= 1e3) return `${Math.round(tokens / 1e3)}k`

  return String(tokens)
}

// Per load: a reload starts these over, as it does the timer; $.state keeps the rest.
// Main-thread requests streaming now: each refreshes the entry itself.
let stepsInFlight = 0
// The last request of any loop, subagents' too, for judging the TTL by a gap.
let touchedAt: number | null = null
let isPingOut = false
let retryAt = 0
let isRewarmAsked = false
let shownStatus: string | undefined = ''
let loggedError = ''
// The smallest cached context worth a ping, from the `minContext` option.
let minTokens = MIN_CONTEXT['50k'] ?? 50_000

async function noteRequest(
  $: EngineInterface,
  at: number,
  usage: ModelUsage,
  isMain: boolean,
): Promise<PingOutcome> {
  const since = touchedAt
  touchedAt = Math.max(touchedAt ?? at, at)
  const last = await read($, warmth)
  const outcome = outcomeOf(usage, last.tokens)
  // A subagent's prefix is its own: it neither shows nor keeps the main entry's life.
  if (!isMain) return outcome

  const from = since ?? last.at
  const learned = from === null ? undefined : learnTtl(at - from, outcome)
  if (learned !== undefined) {
    await update($, ttl, () => ({ value: learned, source: 'learned' }))
  }
  if (outcome !== 'uncached') {
    await update($, warmth, () => ({ at, tokens: prefixOf(usage) }))
  }

  return outcome
}

async function ping($: EngineInterface) {
  isPingOut = true
  await update($, isPinging, () => true)
  try {
    const at = await $.clock.now()
    const reply = await $.model.fork({ prompt: PING_PROMPT })
    let outcome: PingOutcome
    let detail: string | null = null
    if (reply.isAnswered || reply.reason === 'empty-reply') {
      outcome = await noteRequest($, at, reply.usage, true)
    } else if (reply.reason === 'nothing-to-fork') {
      outcome = 'nothing-to-fork'
    } else {
      outcome = 'error'
      detail =
        reply.reason === 'api-error'
          ? `${reply.error}${reply.status === null ? '' : ` ${reply.status}`}`
          : reply.reason
    }

    if (outcome === 'uncached') {
      await update($, isKeepWarm, () => false)
      $.ui.toast('cache-warmer: prompt caching looks off, so Keep warm stopped')
    }
    if (outcome === 'error' || outcome === 'nothing-to-fork') {
      retryAt = at + RETRY_MS
    }
    const served = 'usage' in reply ? reply.usage.cache_read_input_tokens : 0
    const sent = outcome === 'nothing-to-fork' ? 0 : 1
    await update($, pings, was => ({
      count: was.count + sent,
      tokensRead: was.tokensRead + served,
      last: { at, outcome, detail },
    }))
  } finally {
    isPingOut = false
    await update($, isPinging, () => false)
  }
}

function statusOf(isOn: boolean, isSmall: boolean, leftMs: number | null): string | undefined {
  if (!isOn) return undefined
  if (leftMs === null) return 'keep-warm on'
  if (isSmall) return `keep-warm on · context under ${size(minTokens)}`

  return leftMs > 0 ? `keep-warm on · cache ${Math.ceil(leftMs / 60_000)}m left` : 'keep-warm on · cache cold'
}

function showStatus($: EngineInterface, text: string | undefined) {
  if (text === shownStatus) return

  shownStatus = text
  $.ui.status(text)
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)
  const isRewarm = isRewarmAsked
  isRewarmAsked = false

  let isOn = await read($, isKeepWarm)
  const since = await read($, activeAt)
  if (isOn && since !== null && t - since >= AUTO_OFF_MS) {
    await update($, isKeepWarm, () => false)
    isOn = false
    $.ui.toast('cache-warmer: Keep warm turned off after 24h without a turn')
  }

  const { at, tokens } = await read($, warmth)
  const { value } = await read($, ttl)
  const expiresAt = at === null ? null : at + TTL_MS[value]
  const isSmall = tokens < minTokens
  showStatus($, statusOf(isOn, isSmall, expiresAt === null ? null : expiresAt - t))
  if (!isOn || isSmall || expiresAt === null || isPingOut || stepsInFlight > 0 || t < retryAt) {
    return
  }

  // Keep a warm entry warm. A lapsed one (the machine slept) waits for the
  // next turn to write it again, unless Keep warm was just switched on.
  const isDue = t < expiresAt ? t >= expiresAt - LEAD_MS[value] : isRewarm
  if (isDue) await ping($)
}

async function setKeepWarm($: EngineInterface, fn: (was: boolean) => boolean) {
  let isOn = false
  await update($, isKeepWarm, was => (isOn = fn(was)))
  retryAt = 0
  isRewarmAsked = isOn
  if (!isOn) return

  // Switching it on counts as a turn for the auto-off.
  const t = await $.clock.now()
  await update($, activeAt, () => t)
}

async function flipTtl($: EngineInterface) {
  let value: CacheTtl = '1h'
  await update($, ttl, (was): Ttl => {
    value = was.value === '1h' ? '5m' : '1h'

    return { value, source: 'set' }
  })
  await $.store.set('ttl', value)
}

export const register: Register = (on, options) => {
  minTokens = MIN_CONTEXT[String(options.minContext)] ?? minTokens

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache-warmer',
      description: 'Show the prompt cache pane; "on" or "off" sets Keep warm',
      argumentHint: '[on|off]',
    })

    const kept = await $.store.get('ttl')
    if ((kept === '5m' || kept === '1h') && (await read($, ttl)).source === 'assumed') {
      const value: CacheTtl = kept
      await update($, ttl, () => ({ value, source: 'set' }))
    }

    const t = await $.clock.now()
    await update($, now, () => t)
    // A load counts as activity, so a Keep warm left on still has an end.
    if ((await read($, activeAt)) === null) await update($, activeAt, () => t)
    $.clock.every(1000, () => {
      void tick($).catch((error: unknown) => {
        const text = `cache-warmer: ${String(error)}`
        if (text === loggedError) return
        loggedError = text
        $.ui.log(text)
      })
    })
    void $.ui.open(PANE_OPEN)

    return next(e)
  })

  on('command.run', { command: 'cache-warmer' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await setKeepWarm($, () => arg === 'on')

      return { text: `Keep warm is ${arg}.` }
    }
    await $.ui.open(PANE_OPEN)

    return { text: 'Cache pane opened.' }
  })

  on('turn.step', async function* ($, e, next) {
    const at = await $.clock.now()
    const isMain = e.agentId === undefined
    if (isMain) stepsInFlight += 1
    try {
      const result = yield* next(e)
      try {
        if (isMain) await update($, activeAt, () => at)
        if (result.usage !== null) await noteRequest($, at, result.usage, isMain)
      } catch {
        // The countdown missing one request never costs the turn its reply.
      }

      return result
    } finally {
      if (isMain) stepsInFlight = Math.max(0, stepsInFlight - 1)
    }
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    await update($, ttl, () => ({ value: e.cache_ttl, source: 'reported' }))
    // The new model has no entry yet; its first reply writes one.
    touchedAt = null
    await update($, warmth, () => NO_WARMTH)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      touchedAt = null
      retryAt = 0
      await update($, warmth, () => NO_WARMTH)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const t = await read($, now)
    const { at, tokens } = await read($, warmth)
    const since = await read($, activeAt)
    const { value, source } = await read($, ttl)
    const isOn = await read($, isKeepWarm)
    const isBusy = await read($, isPinging)
    const { count, tokensRead, last } = await read($, pings)

    const lifeMs = TTL_MS[value]
    const leftMs = at === null ? null : Math.min(lifeMs, at + lifeMs - t)
    const width = Math.max(8, Math.min(e.props.bodyColumns, 40))
    const filled = leftMs === null ? 0 : Math.round((Math.max(0, leftMs) / lifeMs) * width)
    const tone =
      leftMs === null || leftMs <= 0 ? 'inactive' : leftMs <= LEAD_MS[value] ? 'warning' : 'success'

    const headline =
      leftMs === null
        ? '○ no cache yet'
        : leftMs > 0
          ? `● warm  ${clock(leftMs)} left`
          : `○ cold, lapsed ${ago(-leftMs)}`
    const plan = !isOn
      ? 'Keep warm is off'
      : isBusy
        ? 'pinging…'
        : leftMs === null
          ? 'waiting for the first reply'
          : tokens < minTokens
            ? `holds off below ${size(minTokens)} context`
            : leftMs <= 0
              ? 'resumes after the next turn'
              : `next ping in ${clock(leftMs - LEAD_MS[value])}${since === null ? '' : ` · off in ${span(since + AUTO_OFF_MS - t)}`}`
    const history =
      last === null
        ? 'no pings yet'
        : `${count} ping${count === 1 ? '' : 's'} · ${size(tokensRead)} read · ${last.outcome}${last.detail === null ? '' : ` (${last.detail})`} ${ago(t - last.at)}`

    return (
      <Box flexDirection="column">
        <Text color={tone} weight="bold" tabular wrap="truncate-end">
          {headline}
        </Text>
        <Box>
          <Text color={tone}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(width - filled)}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          TTL {value} ({source}){tokens > 0 ? ` · ${size(tokens)} cached` : ''}
        </Text>
        <Box gap={1}>
          <Button
            key="keep-warm"
            label={isOn ? 'Keep warm: on' : 'Keep warm: off'}
            hotkey="k"
            variant={isOn ? 'primary' : 'secondary'}
            onPress={() => void setKeepWarm($, was => !was)}
          />
          <Button key="ttl" label={`TTL ${value}`} hotkey="t" onPress={() => void flipTtl($)} />
        </Box>
        <Text dimColor tabular wrap="truncate-end">
          {plan}
        </Text>
        <Text dimColor wrap="truncate-end">
          {history}
        </Text>
      </Box>
    )
  })
}
