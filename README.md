# Magic Dueling (PF2e)

Information-only dueling helper for Pathfinder 2e. Players select a skill and stance (Cast / Trick / Shield), then roll with a consolidated ChatMessage to streamline duels without complex automation.

## Compatibility
- Foundry VTT: 13+ (via manifest `compatibility` field)
- System: Pathfinder 2e (`pf2e`) 5.0.0+
- Optional: `socketlib` 1.0.0+

## Installation
- Foundry Setup → Add-on Modules → Install Module → paste manifest URL:
  `https://raw.githubusercontent.com/your-org/foundryvtt-magic-duel/main/module.json`
- Or copy this folder into your Foundry `Data/modules` directory and restart Foundry.

## Usage
1. Enable: Game Settings → Manage Modules → Magic Dueling (PF2e).
2. Choose stance (Cast / Trick / Shield), pick a skill, roll. The module posts a consolidated ChatMessage for quick duel resolution.

## Development
- Entry: `scripts/main.js`; styles: `styles/magic-dueling.css`.
- No build step; reload Foundry (F5) to test changes.
- For local dev, clone or symlink `magic-dueling` into your `Data/modules` directory.

## Links
- Project: `https://github.com/your-org/foundryvtt-magic-duel`
- Manifest: `https://raw.githubusercontent.com/your-org/foundryvtt-magic-duel/main/module.json`

## License
MIT
