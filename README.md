# opencode-model-cost

Live per-model tokens, cost, and TPS in the [OpenCode](https://opencode.ai) TUI.

Shows the model split of the current session tree next to the prompt, updated in real time:

```
glm-5.3 89k·$2.10·12.3tps  glm-5.3-flash 12k·$0.09  local 34k
```

Each entry shows the model, its cumulative token count (input + output + reasoning),
its cumulative cost (hidden when $0), and a live tokens-per-second meter while that
model is actively streaming.

## Why

OpenCode's built-in stats show totals per session. Once you run multiple models — a
flagship main agent delegating to cheap flash subagents, or a free local lane — you
lose sight of who is actually spending what. This plugin breaks the session tree
down per model, live, so you can see the split while you work.

## Requirements

- OpenCode `>= 1.3.14`
- The TUI (the plugin does nothing in CLI/web mode)

## Install

Add the plugin to your TUI config (`~/.config/opencode/tui.json` or the `tui.json`
of your project):

```json
{
  "plugin": ["opencode-model-cost"]
}
```

Or install via the CLI:

```bash
opencode plugin opencode-model-cost
```

Then restart OpenCode.

## How it works

- Reads every assistant message in the viewed session's tree — the session itself
  plus all subagent child sessions (attributed via `parentID`)
- Groups cumulative tokens and cost per model
- Tracks streaming text deltas to compute a per-model live TPS (5-second rolling
  window, byte-based token estimate)
- Renders into the `session_prompt_right` slot next to the prompt, in muted theme
  color

## Limitations

- Subagent sessions from previous TUI runs only appear once they stream again;
  the viewed session's own history is always included
- Token counts exclude cache reads/writes to keep the display readable; use
  `opencode stats` for full accounting
- TPS is an estimate based on streamed text bytes (~5 bytes per token)

## License

MIT
