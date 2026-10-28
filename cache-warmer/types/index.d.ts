export type CacheTtl = '5m' | '1h'

/**
 * How the TTL in force was settled: the starting guess, a cache hit or miss
 * that proved it, the engine's model-switch report, or the person's toggle.
 */
export type TtlSource = 'assumed' | 'learned' | 'reported' | 'set'

export type Ttl = { value: CacheTtl; source: TtlSource }

/** The last request that read or wrote the main thread's prompt cache. */
export type Warmth = {
  /** When it was sent, in ms since the epoch; null before the first one. */
  at: number | null
  /** The prefix it cached: cache read + cache write + uncached input. */
  tokens: number
}

export type PingOutcome = 'hit' | 'rewrote' | 'uncached' | 'nothing-to-fork' | 'error'

export type Ping = { at: number; outcome: PingOutcome; detail: string | null }

export type Pings = { count: number; tokensRead: number; last: Ping | null }

declare module 'claude-code' {
  interface PluginState {
    'cache-warmer': {
      warmth: Warmth
      /** When you last did something here: a main-thread reply, or switching Keep warm on. */
      activeAt: number | null
      ttl: Ttl
      isKeepWarm: boolean
      isPinging: boolean
      pings: Pings
      now: number
    }
  }
}
