# cache-warmer

A Claude Code mod: a small **Cache** pane that counts down how long the main
conversation's prompt cache has left, with a **Keep warm** toggle.

While Keep warm is on, shortly before the cache would lapse (1 minute ahead
for a 5-minute TTL, 3 minutes ahead for a 1-hour TTL) the mod sends a hidden
ping with `$.model.fork`. The ping reruns the main thread's last request plus
one short line ("reply ok") with every tool denied. It reads the cached
prefix, which resets the TTL, and adds nothing to the conversation. Each ping
costs one cache read of the context plus a few output tokens. The pane shows
how many pings went out and how many tokens they read.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cache-warmer --marketplace lumen-limitless/claude-mods
```

From a shell:

```sh
claude plugin install cache-warmer --marketplace lumen-limitless/claude-mods
```

Answer `y` to add the marketplace, then pick a scope; the user scope loads it in every session. A session that was already running picks it up with `/reload-plugins`.

## The pane

```
● warm  41:07 left
██████████████████████░░░░░░░░░░░░
TTL 1h (learned) · 118k cached
[ Keep warm: on ] [ TTL 1h ]
next ping in 38:07 · off in 23h
2 pings · 236k read · hit 18m ago
```

- `k` toggles Keep warm and `t` flips the TTL while the pane has focus.
- `/cache-warmer` opens the pane; `/cache-warmer on` and `/cache-warmer off`
  set Keep warm.
- While Keep warm is on, the status line shows the minutes left.

## When it holds off

- **24 hours without a turn:** Keep warm turns itself off, with a notice.
  Your replies and switching Keep warm on both restart the clock. On a
  1-hour TTL with Claude Opus 5.5, about 24 pings cost roughly 60% of one
  rebuild, which stays under the break-even point (about 40 pings).
- **Small contexts:** while the cached conversation is under the
  `minContext` setting (`/config`, default `50k`; also `any`, `25k`,
  `100k`, `200k`), Keep warm stays on but sends no pings. A small context is
  cheap to rebuild, and a ping's fixed cost is a larger share of it.

## How it knows the TTL

The engine doesn't report the cache TTL on each request, so the mod works it
out:

- **assumed**: it starts at 1h, unless you set a value earlier.
- **learned**: a request that hit the cache more than 5 minutes after the
  last one proves the TTL is 1h. A request that had to rewrite the cache
  after 5 to 59 minutes means it is 5m.
- **reported**: a model switch reports `cache_ttl`, and the mod takes it.
- **set**: the `TTL` button, which is remembered across sessions as the
  starting value.

Keep warm only keeps a warm cache warm. If the cache already lapsed (the
machine slept, say), the mod waits for your next turn to rewrite it. The
exception is switching Keep warm on, which re-warms a cold cache right away.
If a ping shows prompt caching is off, Keep warm turns itself off.

## Develop

```
claude plugin validate .
claude plugin test .
```
