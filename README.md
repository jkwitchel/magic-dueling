# Magic Dueling (PF2e)

Information-only dueling helper for Pathfinder 2e. Two players each pick a skill,
a stance (Cast / Trick / Shield), and an informational ante, then the module rolls
and posts the results as chat messages.

The module is **information-only**: it does **not** spend spell slots, mutate actors,
or automate any PF2e resources. The ante is a number for the story only.

## Compatibility

- Foundry VTT: **v14 verified** (minimum v13).
- System: Pathfinder 2e (`pf2e`) 5.0.0+.
- Optional: `socketlib` 1.0.0+ (not required — the module falls back to Foundry's
  native socket).

## Installation

- Foundry Setup → Add-on Modules → Install Module → paste the manifest URL:
  `https://raw.githubusercontent.com/jkwitchel/magic-dueling/main/module.json`
- Or copy this folder into your Foundry `Data/modules` directory and restart Foundry.
- Enable it in your world under **Game Settings → Manage Modules**.

## Starting a duel

You can start a duel two ways:

1. **Token HUD button** — select a PF2e token you own and click the wizard-hat
   button (🧙) on the Token HUD.
2. **Macro / API** — run either of these from a macro:

```js
game.modules.get("magic-dueling").api.initiate();
// or the convenience global:
MagicDueling.initiate();
```

### Picking challenger and target

- Select **two** PF2e tokens (challenger + target), **or**
- Select **one** PF2e token you own and **target** one other PF2e token.

If two tokens are selected but ownership is ambiguous, you'll be asked who the
challenger is. If only one is selected with no target, you'll be asked to pick a
player-owned target token.

### The flow

1. The target's player receives an **Accept / Decline** prompt (with a timeout).
2. Each player privately picks a **skill**, a **stance**, and an **ante**.
   Magic skills (Arcana, Nature, Occultism, Religion) are highlighted with a ⭐.
3. The module rolls `1d20 + skill modifier` for each side and posts three chat
   messages: the challenger's roll, the target's roll, and the outcome banner.

## How the outcome is decided

Stance is a rock/paper/scissors match:

- **Cast beats Trick**
- **Trick beats Shield**
- **Shield beats Cast**

If both players pick the same stance, tiebreakers apply in order:

1. **Higher ante** wins.
2. If the ante is also tied, the **higher roll** wins.
3. If everything is equal, it's a **tie**.

## Settings

- **Allow any player to initiate** — if disabled, only users who own both actors
  can initiate.
- **Accept timeout (seconds)** — how long the accept prompt waits.
- **Setup timeout (seconds)** — how long each setup prompt waits.

## Troubleshooting

- **The wizard-hat button doesn't appear.** Make sure you own the selected token's
  actor, the actor is a PF2e actor, and exactly one token is selected.
- **The target never gets a prompt.** Verify both users own their respective tokens
  and the target's player is **online**.
- **Nothing happens at all.** Confirm the module is **enabled** in Manage Modules
  and that you're running the PF2e system.
- **socketlib.** It is **optional**. The module works with the native socket, but
  installing `socketlib` can make cross-client prompts more reliable.

## Development

- Entry point: `scripts/main.js` (Foundry-specific glue).
- Pure duel math: `scripts/logic.js` (no Foundry globals, unit-testable).
- Styles: `styles/magic-dueling.css`.
- No build step — reload Foundry (F5) to test changes.

### Tests

Pure duel logic is covered by Node's built-in test runner (no external framework):

```bash
npm test
```

## Links

- Project: <https://github.com/jkwitchel/magic-dueling>
- Manifest: <https://raw.githubusercontent.com/jkwitchel/magic-dueling/main/module.json>

## License

MIT
