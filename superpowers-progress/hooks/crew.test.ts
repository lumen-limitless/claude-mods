import { expect, test } from 'claude-code/testing'

import { PLAN, PLAN_PATH, PLUGIN, STEP_TOOL, bandShows, crew, pane, skill, world } from './world'

const IMPLEMENT = 'You are implementing Task 1: Tokenizer\n\n## Task Description\n\nRead your task brief first.'
const REVIEW = "You are reviewing one task's implementation: first whether it matches its requirements."
const REREVIEW = "You are re-reviewing one task's fix round."
const FINAL = 'You are a Senior Code Reviewer with expertise in software architecture.'

test('terminal: every superpowers subagent is its own crab, briefed to report its steps', async ($, on) => {
  world(on, {})
  const { prompts, spawn, complete } = crew($, on)

  await spawn('Implement Task 1: Tokenizer', IMPLEMENT)
  await spawn('Review Task 1 (spec + quality)', REVIEW)
  await spawn('Find the config loader', 'Look around the repo.', 'Explore')

  // Superpowers' own dispatches get the step line; anyone else's brief is left alone.
  expect(prompts.a1).toContain(STEP_TOOL)
  expect(prompts.a2).toContain(STEP_TOOL)
  expect(prompts.a3).not.toContain(STEP_TOOL)

  // A superpowers subagent with no workflow on record starts one at the build.
  expect(await bandShows($, 'terminal', /^Building$/)).toBe(true)

  // Fix round 1 resumes the implementer: the same crab, round 2, briefed nothing new.
  await complete('a1')
  await spawn('Implement Task 1: Tokenizer', 'Fix these findings: ...', 'general-purpose', 'a1')
  expect(prompts.a1).not.toContain(STEP_TOOL)

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'superpowers-crew', props: pane as never })
  for (const name of ['Pinchy', 'Clawdia', 'Snips']) expect(await ui.find({ type: 'Text', text: new RegExp(`^${name}$`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /implementer/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /task reviewer/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /round 2/ })).toBeDefined()

  // One half-block crab per subagent: 15×7 cells of three u32s, base64.
  const rasters = await ui.findAll({ type: 'Raster' })
  expect(rasters.length).toBe(3)
  for (const r of rasters) {
    expect(r.props.columns).toBe(15)
    expect(r.props.rows).toBe(7)
    expect(String(r.props.cells).length).toBe((15 * 7 * 12 * 4) / 3)
  }
  // Each crab has its own accent, so even two of a role differ.
  const cells = new Set(rasters.map(r => String(r.props.cells)))
  expect(cells.size).toBe(3)
})

test('desktop: each role wears its own costume', async ($, on) => {
  world(on, {})
  const { spawn } = crew($, on)
  await spawn('Implement Task 2: Grammar', 'You are implementing Task 2: Grammar')
  await spawn('Review Task 2 (spec + quality)', REVIEW)
  await spawn('Re-review Task 2 fix round 1', REREVIEW)
  await spawn('Review code changes', FINAL)
  await spawn('Implement Task 2: Grammar', 'A prior implementer attempted this task 3 times; you own it now.')
  await spawn('Sketch the module layout', 'Plan it.', 'Plan')
  await spawn('Summarize the logs', 'Read them.')

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'superpowers-crew', props: pane as never })
  const drawn = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
  for (const costume of ['implementer', 'reviewer', 'rereviewer', 'judge', 'fixer', 'planner', 'crab']) {
    expect(drawn).toContain(`c-${costume} run`)
  }
  expect(drawn).toContain('final reviewer')
  expect(drawn).toContain('Task 2')
  expect(drawn).not.toContain('[object')
  expect(drawn).not.toContain('undefined')
})

test('the step tool draws a worker’s own progress, and only a worker can call it', async ($, on) => {
  world(on, {})
  const { spawn } = crew($, on)
  await spawn('Implement Task 1: Tokenizer', IMPLEMENT)

  expect(await $.tool.call({ tool: STEP_TOOL, agentId: 'a1', done: 1, total: 4, note: 'failing test' } as never)).toMatchObject({ result: 'ok' })
  expect(await $.tool.call({ tool: STEP_TOOL, done: 4, total: 4 } as never)).toMatchObject({ result: 'ignored: only subagents report steps' })

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'superpowers-crew', props: pane as never })
  expect(await ui.find({ type: 'Text', text: /1\/4 failing test/ })).toBeDefined()
})

test('workerSteps off leaves superpowers briefs as written', { options: { workerSteps: 'off' } }, async ($, on) => {
  world(on, {})
  const { prompts, spawn } = crew($, on)
  await spawn('Implement Task 1: Tokenizer', IMPLEMENT)
  expect(prompts.a1).toBe(IMPLEMENT)
})

test('terminal: an empty pane says so and draws no crabs', async ($, on) => {
  world(on, {})
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'superpowers-crew', props: pane as never })
  expect(await ui.find({ type: 'Text', text: /No crabs yet/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Raster' })).length).toBe(0)
})

test('the panel opens by itself once per workflow, and stays closed once closed', async ($, on) => {
  const opened: string[] = []
  world(on, {}, opened)
  const { spawn } = crew($, on)

  await skill($, 'superpowers:subagent-driven-development')
  expect(opened).toEqual(['superpowers-crew'])
  // The plan names the workflow after the panel opened; the person closed it meanwhile.
  await $.tool.call({ tool: 'Write', file_path: PLAN_PATH, content: PLAN } as never)
  await spawn('Implement Task 1: Tokenizer', IMPLEMENT)
  expect(opened).toEqual(['superpowers-crew'])

  // Any other subagent opens nothing under the default setting.
  await spawn('Summarize the logs', 'Read them.')
  expect(opened).toEqual(['superpowers-crew'])
})
