# superpowers-progress

A Claude Code mod for the [superpowers](https://github.com/obra/superpowers) workflow: a progress bar above the prompt and a crew panel with a pixel crab for every subagent. It is a port of [savvy-progress](https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress) (MIT, by johnnyvizz) from savvy-flow to superpowers.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install superpowers-progress --marketplace lumen-limitless/claude-mods
```

From a shell:

```sh
claude plugin install superpowers-progress --marketplace lumen-limitless/claude-mods
```

Answer `y` to add the marketplace, then pick a scope; the user scope loads it in every session. A session that was already running picks it up with `/reload-plugins`.

## The progress bar

The bar spans the whole superpowers lifecycle, one segment per phase, with a tall tick at each hand-over:

| Brainstorm | Plan | Build | Review | Finish |
| --- | --- | --- | --- | --- |
| 0–10% | 10–20% | 20–85%, one short tick per plan task | 85–95% | 95–100% |

The pill names the phase: `Brainstorm`, `Spec written`, `Plan · 7 tasks`, `Tasks 3/7`, `Final review`, `Review clean`, `Finish`, `Done`. During the build a faint second layer shows the tasks handed out but not yet in the ledger. `×N` opens the crew panel; `✕` dismisses the bar until the next workflow.

## The crew panel

`/crew` toggles it, `/crew open` brings it forward, `/crew reset` clears the workflow. It shows the title, the five phases as a stepper, total cost, tokens and time, the task the controller is on, then every subagent (running, finished) and the plan tasks still waiting.

Every subagent is a crab dressed for its job, and every crab also gets its own name (Pinchy, Clawdia, Snips, ...) and accent color, so two implementers side by side are told apart:

| Role | Recognised by | Costume |
| --- | --- | --- |
| implementer | `Implement Task N: …` / `You are implementing Task` | hard hat; the wrench turns |
| task reviewer | `Review Task N (spec + quality)` | deerstalker; the magnifier sweeps |
| re-reviewer | `Re-review Task N fix round R` | visor and glasses; the clipboard's check blinks |
| final reviewer | `Review code changes` / `Senior Code Reviewer` | powdered wig and robe; the gavel bangs |
| fixer | rounds 4-5 (`you own it now`) or a `Fix …` dispatch | bandana; the hammer pounds |
| builder check | brainstorming's builder-check prompt | beret; the blueprint lifts |
| explorer | `Explore` agents | pirate; the cutlass fences |
| planner | `Plan` agents | wizard hat; the wand's star blinks |
| anything else | | a bow tie in the crab's own color |

On the desktop the crabs are SVG and animate with CSS. In the terminal they are drawn with half-block cells (15×7) and step their legs once a second while they work; finished crabs turn grey. Fix rounds 1-3 resume the same implementer, so the same crab goes back to work with `round 2`, `round 3`.

Each row shows the model, the task number, context fill, tokens, estimated cost and time. Cost is an estimate from token counts and a built-in price table (`PRICES` in `hooks/register.tsx`, list prices as of 2026-10-10), not a bill.

## How it follows superpowers

Superpowers is plain skills and reports nothing, so the mod reads what the workflow already leaves behind. Superpowers itself is not changed:

- **Phase:** the skills the main session loads, through the Skill tool or as a slash command: `brainstorming`, `writing-plans`, `subagent-driven-development` or `executing-plans`, `requesting-code-review`, `finishing-a-development-branch`. Skills a subagent loads (TDD, verification) are ignored.
- **Title:** the spec's `# heading` while brainstorming, then the plan's `# … Implementation Plan`.
- **Tasks:** the plan's `### Task N: name` headings, from the `Write` of a plan into `docs/superpowers/plans/` (or any markdown file shaped like one), and again whenever execution names the plan.
- **Done:** the SDD ledger at `.superpowers/sdd/<plan>/progress.md`. The workspace is found in the output of `sdd-workspace`, `task-brief`, `task-start` and `review-package`, or in any path a brief, report or package lives at. The ledger's `Task N: complete` lines count as done and its `Task N: fix round R/5` lines as fix rounds. It is re-read every two seconds while a plan runs. Once every task is in, the phase moves to the final review. When the workspace is deleted after a clean final review, the bar reads `Review clean`.
- **Current task:** `task-brief PLAN N` (subagent-driven) or `task-start PLAN N` (inline).
- **Done for good:** in the finish phase, a `gh pr create`, `git merge`, `git worktree remove` or `git branch -D` by the main session.

Inline execution (`executing-plans`) dispatches no subagents per task. The bar and the panel still follow the ledger, and the panel shows the task the main session is on.

## Worker step reports

Each subagent a superpowers template dispatches gets one line at the end of its brief asking it to call `mcp__superpowers-progress__step` with its own plan (`total`, then `done` and a `note` per step). The tool only draws the crab's progress bar. A worker that does not report shows its context fill in grey instead.

## Settings

Set these in `/config`, or for a mod loaded by hand in `~/.claude/settings.json` under `pluginConfigs`:

```json
{ "pluginConfigs": { "superpowers-progress": { "options": { "autoOpen": "superpowers", "workerSteps": "on" } } } }
```

- `autoOpen`: `superpowers` (default) opens the panel once per workflow when execution starts or a superpowers subagent starts; `any` also when any other subagent starts; `off` leaves it to `/crew`.
- `workerSteps`: `on` (default) or `off` for the step-report line in superpowers subagents' briefs.

## Developing

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```
