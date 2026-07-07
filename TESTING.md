# Manual Testing Guide — Foundry VTT v14

Automated tests cover the pure duel math (`npm test`). The checklist below covers
the Foundry-side behavior that can't be unit-tested without launching Foundry.

Run through this in a **v14** world using the **PF2e** system. Where "cross-client"
is mentioned, use a second browser/user connected to the same world.

## Setup / load

- [ ] Module enables cleanly in **Manage Modules** with no errors.
- [ ] World loads with **no console errors** attributable to `magic-dueling`.
- [ ] The three settings appear under **Game Settings → Configure Settings**:
      allow-any-player, accept timeout, setup timeout.

## Token HUD button

- [ ] Selecting **one owned PF2e token** shows the wizard-hat button on the Token HUD.
- [ ] The button is visually consistent with the other Token HUD control icons.
- [ ] Selecting a non-owned or non-PF2e token does **not** show the button.
- [ ] Opening/closing the HUD repeatedly does **not** create duplicate buttons.

## Initiating a duel

- [ ] Duel can be initiated with **two selected tokens** (owner is inferred, or you
      are asked who the challenger is when ambiguous).
- [ ] Duel can be initiated with **one selected token + one target**.
- [ ] `game.modules.get("magic-dueling").api.initiate()` works from a macro.
- [ ] `MagicDueling.initiate()` works from a macro.
- [ ] Selecting zero or 3+ tokens produces a clear notification, not an error.

## Accept / decline prompt

- [ ] The **target's player** receives an Accept / Decline prompt.
- [ ] Clicking **Accept** continues to setup.
- [ ] Clicking **Decline** posts a clean "declined or did not respond" chat message.
- [ ] Closing the prompt window (X / Escape) is treated as decline.
- [ ] Letting the prompt **time out** posts/handles cleanly (no hang).

## Setup prompts

- [ ] Both setup dialogs appear **privately** — each player only sees their own.
- [ ] Magic skills (Arcana, Nature, Occultism, Religion) are highlighted with ⭐.
- [ ] The ante selector only offers 0–10; invalid values are prevented/clamped.
- [ ] Dialogs use native window chrome, open at a sane width, and can be dragged.
- [ ] Cancelling or timing out a setup prompt posts a clean "cancelled" chat message.

## Results / outcomes

- [ ] Three chat messages post: challenger roll, target roll, outcome banner.
- [ ] **Stance winner** works (Cast beats Trick, Trick beats Shield, Shield beats Cast).
- [ ] **Ante tiebreaker** works when stances match (higher ante wins).
- [ ] **Roll tiebreaker** works when stance and ante match (higher roll wins).
- [ ] **Tie outcome** works when stance, ante, and roll all match.
- [ ] Chat output is readable in both **light and dark** Foundry UI themes.

## Sockets / connectivity

- [ ] **Same-client** GM/player testing works (initiate and respond as the same user).
- [ ] **Cross-client** testing works (challenger on one client, target on another).
- [ ] With **socketlib disabled/absent**, the native fallback still delivers prompts.
- [ ] With **socketlib enabled/installed**, the socketlib path works.
- [ ] Only the intended recipient receives each private prompt (no duplicate prompts
      on other connected clients).

## Known limitations

- The ante is informational only; the module never spends spell slots or edits actors.
- Skill modifiers are read from the target actor's data on the recipient client, so
  the target's player (or an active GM owner) must be online to complete a duel.
