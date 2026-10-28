# claude-mods

Two Claude Code mods, in one plugin marketplace:

| Mod | What it does |
| --- | --- |
| [cache-warmer](cache-warmer/README.md) | A small **Cache** pane that counts down the prompt cache's life, with a **Keep warm** toggle that refreshes it with a hidden ping before it expires. |
| [superpowers-progress](superpowers-progress/README.md) | A progress bar above the prompt for [superpowers](https://github.com/obra/superpowers) workflows, plus a crew panel (`/crew`) with a pixel crab for every subagent. |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cache-warmer --marketplace lumen-limitless/claude-mods
/plugin install superpowers-progress --marketplace lumen-limitless/claude-mods
```

From a shell:

```sh
claude plugin install cache-warmer --marketplace lumen-limitless/claude-mods
claude plugin install superpowers-progress --marketplace lumen-limitless/claude-mods
```

The first one asks `Add marketplace?`: answer `y`, then pick a scope. The user scope loads the mod in every session.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `lumen-limitless/claude-mods`, then Add plugin.

## Update

After new commits land here:

```sh
claude plugin marketplace update lumen-mods
```

Then `/reload-plugins` in a running session, or start a new one.

## License

MIT. superpowers-progress is adapted from [savvy-progress](https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress) by johnnyvizz (MIT); see [superpowers-progress/LICENSE](superpowers-progress/LICENSE).
