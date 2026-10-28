import { expect, test } from 'claude-code/testing'

import { LEDGER_HEAD, PLAN, PLAN_PATH, WS, bandShows, bash, skill, world } from './world'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band follows a superpowers workflow from brainstorm to done`, async ($, on) => {
    const files: Record<string, string> = {}
    world(on, files)
    // No workflow, no band.
    expect(await bandShows($, surface, /Brainstorm/)).toBe(false)

    await skill($, 'superpowers:brainstorming')
    expect(await bandShows($, surface, /Brainstorm/)).toBe(true)

    await $.tool.call({ tool: 'Write', file_path: '/repo/docs/superpowers/specs/2026-10-22-parser-design.md', content: '# Parser — Design\n\nWhat it is.' } as never)
    expect(await bandShows($, surface, /Spec written/)).toBe(true)
    expect(await bandShows($, surface, /^Parser$|>Parser</)).toBe(true)

    await skill($, 'superpowers:writing-plans')
    await $.tool.call({ tool: 'Write', file_path: PLAN_PATH, content: PLAN } as never)
    // Three tasks: the heading inside the code fence is not one.
    expect(await bandShows($, surface, /Plan · 3 tasks/)).toBe(true)

    await skill($, 'superpowers:subagent-driven-development')
    files[`${WS}/plan-path`] = 'docs/superpowers/plans/2026-10-22-parser.md\n'
    files[PLAN_PATH] = PLAN
    files[`${WS}/progress.md`] = `${LEDGER_HEAD}Task 1: complete (commits abc1234..def5678, review clean)\n`
    await bash($, 'bash /x/skills/subagent-driven-development/scripts/sdd-workspace docs/superpowers/plans/2026-10-22-parser.md')
    expect(await bandShows($, surface, /Tasks 1\/3/)).toBe(true)

    // requesting-code-review between tasks keeps the build going.
    await skill($, 'superpowers:requesting-code-review')
    expect(await bandShows($, surface, /Tasks 1\/3/)).toBe(true)

    files[`${WS}/progress.md`] +=
      'Task 2: fix round 1/5 (2 addressed, 0 open — naming; commits a1b2c3d..e4f5a6b)\n' +
      '- Task 2: complete (commits a1b2c3d..e4f5a6b, review clean)\n' +
      'Task 3: complete (commits 1111111..2222222, tests: npm test → 12 passed)\n'
    await bash($, `printf '%s\\n' "Task 3: complete" >> ${WS}/progress.md`)
    // Every task in: the final review is next.
    expect(await bandShows($, surface, /Final review/)).toBe(true)

    // A clean final review deletes the workspace.
    for (const k of Object.keys(files)) if (k.startsWith(WS)) delete files[k]
    await bash($, `rm -rf ${WS}`)
    expect(await bandShows($, surface, /Review clean/)).toBe(true)

    await skill($, 'superpowers:finishing-a-development-branch')
    expect(await bandShows($, surface, /Finish/)).toBe(true)
    await bash($, 'gh pr create --title "Parser" --body "..."')
    expect(await bandShows($, surface, /Done/)).toBe(true)
  })
}

test('the skills a subagent loads, and other plugins’ skills, do not move the phase', async ($, on) => {
  world(on, {})
  await skill($, 'superpowers:brainstorming')
  await skill($, 'superpowers:finishing-a-development-branch', 'a1')
  await skill($, 'other-kit:writing-plans')
  expect(await bandShows($, 'terminal', /^Brainstorm$/)).toBe(true)
  // Superpowers installed as plain skills has no prefix.
  await skill($, 'writing-plans')
  expect(await bandShows($, 'terminal', /^Plan$/)).toBe(true)
})

test('a new brainstorm after a finished workflow starts over', async ($, on) => {
  world(on, {})
  await skill($, 'superpowers:finishing-a-development-branch')
  await bash($, 'git merge --no-ff feature/parser')
  expect(await bandShows($, 'terminal', /^Done$/)).toBe(true)
  await skill($, 'superpowers:brainstorming')
  expect(await bandShows($, 'terminal', /^Brainstorm$/)).toBe(true)
})

test('inline execution: task-start names the task in hand and the ledger counts it', async ($, on) => {
  const files: Record<string, string> = {
    [`${WS}/plan-path`]: 'docs/superpowers/plans/2026-10-22-parser.md\n',
    [PLAN_PATH]: PLAN,
    [`${WS}/progress.md`]: `${LEDGER_HEAD}Task 1: complete (commits a..b, tests: npm test → ok)\n`,
  }
  world(on, files)
  await skill($, 'superpowers:executing-plans')
  await bash($, `bash /x/skills/executing-plans/scripts/task-start ${PLAN_PATH} 2`)
  expect(await bandShows($, 'terminal', /Tasks 1\/3/)).toBe(true)

  const ui = await $.ui.mount({
    plugin: 'superpowers-progress',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'superpowers-crew',
    props: { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as never,
  })
  expect(await ui.find({ type: 'Text', text: /Now: Task 2 · Grammar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Up next · 2/ })).toBeDefined()
})
