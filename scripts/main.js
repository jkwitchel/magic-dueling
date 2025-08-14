const MODULE_ID = "magic-dueling";

const STANCES = {
  cast: { id: "cast", label: "Cast", tooltip: "Offense—beats Trick, loses to Shield" },
  trick: { id: "trick", label: "Trick", tooltip: "Feint—beats Shield, loses to Cast" },
  shield: { id: "shield", label: "Shield", tooltip: "Guard—beats Cast, loses to Trick" },
};

// PF2e core magic skills to visually highlight in UI and chat
const MAGIC_SKILL_LABELS = new Set(["arcana", "nature", "occultism", "religion"]);

function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

function generateId() {
  return foundry?.utils?.randomID?.() ?? (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
}

function rpsOutcome(a, b) {
  if (a === b) return 0; // tie
  if (
    (a === "cast" && b === "trick") ||
    (a === "trick" && b === "shield") ||
    (a === "shield" && b === "cast")
  )
    return 1; // a wins
  return -1; // b wins
}

function isPf2eActor(actor) {
  return actor?.system?.schema?.id?.startsWith?.("pf2e") || game.system?.id === "pf2e" && actor?.system;
}

function getActorSkillChoices(actor) {
  // Prefer PF2e's Statistic map if present (actor.skills), else fall back to actor.system.skills
  const choices = [];
  const statMap = actor?.skills ?? actor?.system?.skills ?? {};
  for (const [key, data] of Object.entries(statMap)) {
    const label = data?.label ?? data?.name ?? key.toUpperCase();
    const modifier = Number(
      data?.totalModifier ?? data?.mod ?? data?.modifier ?? data?.value ?? 0
    );
    if (Number.isFinite(modifier)) {
      const k = String(key).toLowerCase();
      const l = String(label).toLowerCase();
      const isMagic = MAGIC_SKILL_LABELS.has(l) || MAGIC_SKILL_LABELS.has(k);
      choices.push({ key, label, modifier, isMagic });
    }
  }
  // sort by localized label
  choices.sort((a, b) => a.label.localeCompare(b.label));
  return choices;
}

// Ante is informational only; no character resource interaction required.

function socketSend(targetUserId, event, payload) {
  // Prefer socketlib if present, but guard failures and fall back gracefully
  try {
    if (game.modules.get("socketlib")?.active && globalThis.socketlib) {
      const socket = globalThis.socketlib.registerModule(MODULE_ID);
      if (socket?.executeAsUser) return socket.executeAsUser(event, targetUserId, payload);
    }
  } catch (e) {
    console.warn(MODULE_ID, "socketlib send failed, using fallback", e);
  }
  // Fallback: use Foundry's game.socket for our module channel
  return new Promise((resolve) => {
    const requestId = generateId();
    const handler = (data) => {
      if (data?.requestId !== requestId) return;
      game.socket.off(`module.${MODULE_ID}`, handler);
      resolve(data?.response);
    };
    game.socket.on(`module.${MODULE_ID}`, handler);
    game.socket.emit(`module.${MODULE_ID}`, { type: event, payload, requestId, targetUserId });
    // If no response mechanism, resolve undefined after timeout to avoid leaks
    setTimeout(() => {
      game.socket.off(`module.${MODULE_ID}`, handler);
      resolve(undefined);
    }, 65_000);
  });
}

function registerSocketFallbackHandler() {
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    if (!data || (data.targetUserId && data.targetUserId !== game.user.id)) return;
    if (data.type === "prompt-accept") {
      const response = await DuelManager.promptAccept(data.payload);
      game.socket.emit(`module.${MODULE_ID}`, { requestId: data.requestId, response });
    } else if (data.type === "prompt-setup") {
      const response = await DuelManager.promptSetup(data.payload);
      game.socket.emit(`module.${MODULE_ID}`, { requestId: data.requestId, response });
    } else if (data.type === "opponent-ready") {
      DuelManager.receiveOpponentReady(data.payload);
      game.socket.emit(`module.${MODULE_ID}`, { requestId: data.requestId, response: true });
    }
  });
}

class DuelManager {
  static init() {
    game.settings.register(MODULE_ID, "allowAnyPlayerToInitiate", {
      name: "Allow any player to initiate",
      hint: "If disabled, only users who own both selected actors may initiate.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
    });

    game.settings.register(MODULE_ID, "acceptTimeoutSec", {
      name: "Accept timeout (seconds)",
      scope: "world",
      config: true,
      type: Number,
      default: 30,
      range: { min: 5, max: 300, step: 5 },
    });

    game.settings.register(MODULE_ID, "setupTimeoutSec", {
      name: "Setup timeout (seconds)",
      scope: "world",
      config: true,
      type: Number,
      default: 60,
      range: { min: 10, max: 600, step: 10 },
    });

    // HUD control
    Hooks.on("renderTokenHUD", (hud, html) => {
      try {
        const controlled = canvas.tokens.controlled;
        if (controlled.length !== 1) return;
        const token = controlled[0];
        if (!token?.actor?.isOwner || !isPf2eActor(token.actor)) return;
        const btn = $(`<div class="control-icon magic-duel" title="Magic Duel"><i class="fas fa-hat-wizard"></i></div>`);
        btn.on("click", () => DuelManager.initiateFromSelection());
        html.find(".col.left .control-buttons").append(btn);
      } catch (err) {
        console.error(MODULE_ID, "HUD button error", err);
      }
    });

    // Register socketlib handlers (if available)
    try {
      if (game.modules.get("socketlib")?.active && globalThis.socketlib) {
        const socket = globalThis.socketlib.registerModule(MODULE_ID);
        socket.register("prompt-accept", DuelManager.promptAccept);
        socket.register("prompt-setup", DuelManager.promptSetup);
        socket.register("opponent-ready", DuelManager.receiveOpponentReady);
      }
    } catch (e) {
      console.error(MODULE_ID, "socketlib registration failed", e);
    }

    // API for macros
    game.modules.get(MODULE_ID).api = {
      initiate: DuelManager.initiateFromSelection,
    };

    registerSocketFallbackHandler();
  }

  static async initiateFromSelection() {
    try {
      const selection = canvas.tokens.controlled.filter((t) => t.actor && isPf2eActor(t.actor));
      if (selection.length < 1 || selection.length > 2) {
        ui.notifications.error("Select one or two PF2e tokens you own to start a duel.");
        return;
      }

      // If one token is selected, but they have exactly one targeted PF2e token, use that as the target automatically
      if (selection.length === 1) {
        const challengerCandidate = selection[0];
        const targeted = Array.from(game.user.targets ?? []);
        const validTargets = targeted
          .filter((t) => t?.id !== challengerCandidate?.id)
          .filter((t) => t?.actor && isPf2eActor(t.actor));
        if (validTargets.length === 1) {
          const t = validTargets[0];
          return await DuelManager._startWithTokens({ challengerToken: challengerCandidate, targetToken: t });
        }
      }

      let challengerToken; let targetToken;
      if (selection.length === 2) {
        const owned = selection.filter((t) => t.actor?.isOwner);
        if (owned.length === 1) {
          challengerToken = owned[0];
          targetToken = selection.find((t) => t !== challengerToken);
        } else {
          // Ambiguous: prompt for who is the challenger
          const a = selection[0];
          const b = selection[1];
          const choice = await new Promise((resolve) => {
            new Dialog({
              title: "Select Challenger",
              content: `<p>Choose who is the challenger:</p>
                <div class="md-row">
                  <img src="${a.document.texture.src}" width="36" height="36"/>
                  <strong>${a.name}</strong>
                  <span>vs</span>
                  <img src="${b.document.texture.src}" width="36" height="36"/>
                  <strong>${b.name}</strong>
                </div>`,
              buttons: {
                a: { label: `${a.name} challenges`, callback: () => resolve("a") },
                b: { label: `${b.name} challenges`, callback: () => resolve("b") },
                cancel: { label: "Cancel", callback: () => resolve(null) },
              },
              default: "a",
              close: () => resolve(null),
            }).render(true);
          });
          if (!choice) return;
          challengerToken = choice === "a" ? a : b;
          targetToken = choice === "a" ? b : a;
        }
      } else {
        challengerToken = selection[0];
        // Prompt for target among player-owned tokens on scene
        const playerOwned = canvas.tokens.placeables.filter((t) => t !== challengerToken && t.actor && t.actor.hasPlayerOwner && isPf2eActor(t.actor));
        if (!playerOwned.length) {
          ui.notifications.warn("No valid target tokens owned by players in the scene.");
          return;
        }
        const choices = Object.fromEntries(playerOwned.map((t) => [t.id, `${t.name} (${t.actor.name})`]));
        const picked = await new Promise((resolve) => {
          new Dialog({
            title: "Select Duel Target",
            content: `<p>Select a target token:</p>
              <div class="form-group"><label>Target</label>
              <select name="target">${Object.entries(choices).map(([id, label]) => `<option value="${id}">${label}</option>`).join("")}</select>
              </div>`,
            buttons: {
              ok: { label: "OK", callback: (html) => resolve(html.find("select[name=target]").val()) },
              cancel: { label: "Cancel", callback: () => resolve(null) },
            },
            default: "ok",
            close: () => resolve(null),
          }).render(true);
        });
        if (!picked) return;
        targetToken = playerOwned.find((t) => t.id === picked);
      }

      if (!challengerToken || !targetToken) return;

      return await DuelManager._startWithTokens({ challengerToken, targetToken });
    } catch (err) {
      console.error(MODULE_ID, "initiate error", err);
      ui.notifications.error("Magic Duel failed to start. See console.");
    }
  }

  static async _startWithTokens({ challengerToken, targetToken }) {
    try {
      // Permission check
      const allowAny = getSetting("allowAnyPlayerToInitiate");
      if (!challengerToken.actor?.isOwner) {
        ui.notifications.error("You must own the challenger's actor to initiate a duel.");
        return;
      }
      if (!allowAny && !targetToken.actor?.isOwner) {
        ui.notifications.error("You do not have permission to duel an actor you don't own.");
        return;
      }

      // Consent on target's client
      const acceptTimeout = getSetting("acceptTimeoutSec") * 1000;
      const targetUserId = DuelManager._owningUserId(targetToken.actor, { requireActive: true, allowGM: true });
      if (!targetUserId) {
        ui.notifications.warn("No eligible user is available to accept the duel (no owner or GM online).");
        return;
      }
      const consentPayload = {
        challengerUserId: DuelManager._owningUserId(challengerToken.actor, { requireActive: false, allowGM: true }) ?? game.user.id,
        targetUserId,
        challenger: DuelManager._tokenLite(challengerToken),
        target: DuelManager._tokenLite(targetToken),
        timeoutMs: acceptTimeout,
      };

      const accepted = await DuelManager._promptAcceptTarget(targetUserId, consentPayload);
      if (!accepted) {
        ChatMessage.create({ content: `<p><strong>Magic Duel</strong>: ${targetToken.name} declined or did not respond.</p>` });
        return;
      }

      // Setup per client
      const setupTimeout = getSetting("setupTimeoutSec") * 1000;
      const duelId = generateId();

      const [challengerSetup, targetSetup] = await Promise.all([
        DuelManager.promptSetup({ duelId, who: "challenger", token: DuelManager._tokenLite(challengerToken), timeoutMs: setupTimeout, opponentUserId: targetUserId }),
        DuelManager._promptSetupTarget(targetUserId, { duelId, who: "target", token: DuelManager._tokenLite(targetToken), timeoutMs: setupTimeout, opponentUserId: game.user.id }),
      ]);

      if (!challengerSetup || !targetSetup) {
        ChatMessage.create({ content: `<p><strong>Magic Duel</strong>: Duel cancelled during setup.</p>` });
        return;
      }

      // Resolve
      await DuelManager.resolveAndAnnounce({
        challenger: { token: DuelManager._tokenLite(challengerToken), ...challengerSetup },
        target: { token: DuelManager._tokenLite(targetToken), ...targetSetup },
      });
    } catch (err) {
      console.error(MODULE_ID, "startWithTokens error", err);
      ui.notifications.error("Magic Duel failed to start. See console.");
    }
  }

  static _tokenLite(token) {
    return {
      id: token.id,
      name: token.name,
      img: token.document.texture.src,
      actorId: token.actor?.id,
      actorName: token.actor?.name,
      sceneId: canvas?.scene?.id,
    };
  }

  static _owningUserId(actor, { requireActive = true, allowGM = true } = {}) {
    const owners = game.users.filter((u) => !u.isGM && actor?.testUserPermission?.(u, "OWNER"));
    const owner = requireActive ? owners.find((u) => u.active) : owners[0];
    if (owner) return owner.id;
    if (allowGM) {
      const gms = game.users.filter((u) => u.isGM);
      const activeGM = requireActive ? gms.find((u) => u.active) : gms[0];
      if (activeGM) return activeGM.id;
    }
    return null;
  }

  static async _promptAcceptTarget(targetUserId, payload) {
    // Prefer socketlib to run a prompt on target client
    if (game.modules.get("socketlib")?.active && globalThis.socketlib) {
      try {
        const socket = globalThis.socketlib.registerModule(MODULE_ID);
        if (socket?.executeAsUser) return await socket.executeAsUser("prompt-accept", targetUserId, payload);
      } catch (e) {
        console.error(MODULE_ID, "socketlib accept failed, falling back", e);
      }
    }
    // Fallback own socket
    return socketSend(targetUserId, "prompt-accept", payload);
  }

  static async _promptSetupTarget(targetUserId, payload) {
    if (game.modules.get("socketlib")?.active && globalThis.socketlib) {
      try {
        const socket = globalThis.socketlib.registerModule(MODULE_ID);
        if (socket?.executeAsUser) return await socket.executeAsUser("prompt-setup", targetUserId, payload);
      } catch (e) {
        console.error(MODULE_ID, "socketlib setup failed, falling back", e);
      }
    }
    return socketSend(targetUserId, "prompt-setup", payload);
  }

  static async promptAccept({ challenger, target, timeoutMs }) {
    return new Promise((resolve) => {
      const dlg = new Dialog({
        title: "Magic Duel Challenge",
        content: `<div class="md-challenge">
          <p>${challenger.name} challenges ${target.name} to a Magic Duel.</p>
          <div class="md-row">
            <img src="${challenger.img}" width="48" height="48"/>
            <span>${challenger.name}</span>
            <span>vs</span>
            <img src="${target.img}" width="48" height="48"/>
            <span>${target.name}</span>
          </div>
        </div>`,
        buttons: {
          accept: { label: "Accept", callback: () => resolve(true) },
          decline: { label: "Decline", callback: () => resolve(false) },
        },
        default: "accept",
        close: () => resolve(false),
      }).render(true);
      setTimeout(() => {
        try { dlg.close({ force: true }); } catch {}
        resolve(false);
      }, Math.max(5_000, timeoutMs ?? 30_000));
    });
  }

  static async promptSetup({ duelId, who, token, timeoutMs, opponentUserId }) {
    const actor = game.actors.get(token.actorId);
    const skills = getActorSkillChoices(actor);
    if (!skills.length) return null;
    const anteOptions = [
      { value: "0", label: "0 (Cantrip)" },
      ...Array.from({ length: 10 }, (_, i) => i + 1).map((lvl) => ({ value: String(lvl), label: String(lvl) })),
    ];
    const content = `<form class="md-setup">
      <p>Select your skill and stance. This is private to you.</p>
      <div class="form-group">
        <label>Skill</label>
        <select name="skill">${skills.map((s) => {
          const star = s.isMagic ? "⭐ " : "";
          return `<option value="${s.key}" data-mod="${s.modifier}" data-magic="${s.isMagic ? "1" : "0"}">${star}${s.label} (${s.modifier >= 0 ? "+" : ""}${s.modifier})</option>`;
        }).join("")}</select>
      </div>
      <fieldset class="md-stances">
        <legend>Stance</legend>
        ${Object.values(STANCES).map((st) => `<label class="radio">
          <input type="radio" name="stance" value="${st.id}" ${st.id === "cast" ? "checked" : ""}>
          <span title="${st.tooltip}">${st.label}</span>
        </label>`).join("")}
      </fieldset>
      <div class="form-group">
        <label>Ante Spell Slot</label>
        <select name="ante">${anteOptions.map((o) => `<option value="${o.value}">${o.label}</option>`).join("")}</select>
      </div>
    </form>`;
    return new Promise((resolve) => {
      let resolved = false;
      const dlg = new Dialog({
        title: `Magic Duel Setup — ${who === "challenger" ? "Challenger" : "Target"}`,
        content,
        buttons: {
          ready: {
            label: "Ready",
            callback: (html) => {
              const skillKey = html.find("select[name=skill]").val();
              const stance = html.find("input[name=stance]:checked").val();
              const chosen = skills.find((s) => s.key === skillKey);
              const anteLevel = Math.max(0, Number(html.find("select[name=ante]").val() ?? 0));
              ui.notifications.info("Ready — waiting for opponent...");
              if (opponentUserId) DuelManager.notifyOpponentReady({ duelId, name: token.name, opponentUserId });
              resolved = true;
              resolve({ duelId, who, skillKey, skillLabel: chosen?.label ?? skillKey, modifier: chosen?.modifier ?? 0, stance, skillIsMagic: !!chosen?.isMagic, anteLevel });
            },
          },
          cancel: { label: "Cancel", callback: () => resolve(null) },
        },
        default: "ready",
        close: () => { if (!resolved) resolve(null); },
      }).render(true);
      setTimeout(() => { try { dlg.close({ force: true }); } catch {} if (!resolved) resolve(null); }, Math.max(10_000, timeoutMs ?? 60_000));
    });
  }

  static async notifyOpponentReady({ duelId, name, opponentUserId }) {
    // socketlib preferred
    try {
      if (game.modules.get("socketlib")?.active && globalThis.socketlib) {
        const socket = globalThis.socketlib.registerModule(MODULE_ID);
        if (socket?.executeAsUser) {
          await socket.executeAsUser("opponent-ready", opponentUserId, { duelId, name });
          return;
        }
      }
    } catch {}
    // fallback
    await socketSend(opponentUserId, "opponent-ready", { duelId, name });
  }

  static receiveOpponentReady({ name }) {
    ui.notifications.info(`${name} is ready.`);
  }

  static async resolveAndAnnounce({ challenger, target }) {
    const chalActor = game.actors.get(challenger.token.actorId);
    const targActor = game.actors.get(target.token.actorId);
    const cOutcome = rpsOutcome(challenger.stance, target.stance);
    let rpsBanner;
    if (cOutcome === 0) rpsBanner = `Tie — both chose ${STANCES[challenger.stance]?.label ?? challenger.stance}`;
    else if (cOutcome === 1) rpsBanner = `${STANCES[challenger.stance].label} beats ${STANCES[target.stance].label} → ${challenger.token.name} wins the duel`;
    else rpsBanner = `${STANCES[target.stance].label} beats ${STANCES[challenger.stance].label} → ${target.token.name} wins the duel`;

    // Rolls: d20 + modifier (v13: evaluate without async option)
    const cRoll = await new Roll(`1d20 + ${Number(challenger.modifier) || 0}`, {}).evaluate();
    const tRoll = await new Roll(`1d20 + ${Number(target.modifier) || 0}`, {}).evaluate();

    // Post separate messages: challenger roll, target roll, outcome
    const chalFlavor = `Magic Duel — Challenger: ${challenger.token.name} — ${STANCES[challenger.stance].label} — ${challenger.skillLabel}${challenger.anteLevel ? ` — Ante: L${challenger.anteLevel}` : ""}`;
    const targFlavor = `Magic Duel — Target: ${target.token.name} — ${STANCES[target.stance].label} — ${target.skillLabel}${target.anteLevel ? ` — Ante: L${target.anteLevel}` : ""}`;

    await cRoll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: chalActor }), flavor: chalFlavor });
    await tRoll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: targActor }), flavor: targFlavor });

    // Tie-breaker: stance first, then ante (higher level), then roll total
    let outcomeBy = "stance";
    let finalOutcome = cOutcome;
    if (finalOutcome === 0) {
      const ca = Number(challenger.anteLevel || 0);
      const ta = Number(target.anteLevel || 0);
      if (ca !== ta) { finalOutcome = ca > ta ? 1 : -1; outcomeBy = "ante"; }
      else if ((cRoll.total ?? 0) !== (tRoll.total ?? 0)) { finalOutcome = (cRoll.total ?? 0) > (tRoll.total ?? 0) ? 1 : -1; outcomeBy = "roll"; }
    }

    let banner;
    if (finalOutcome === 0) banner = `Tie — both chose ${STANCES[challenger.stance]?.label ?? challenger.stance}, equal ante, and equal roll`;
    else if (finalOutcome === 1) {
      if (outcomeBy === "stance") banner = `${STANCES[challenger.stance].label} beats ${STANCES[target.stance].label} → ${challenger.token.name} wins the duel`;
      else if (outcomeBy === "ante") banner = `Tie on stance. Higher ante (L${challenger.anteLevel || 0} vs L${target.anteLevel || 0}) → ${challenger.token.name} wins the duel`;
      else banner = `Tie on stance and ante. Higher roll (${cRoll.total} vs ${tRoll.total}) → ${challenger.token.name} wins the duel`;
    } else {
      if (outcomeBy === "stance") banner = `${STANCES[target.stance].label} beats ${STANCES[challenger.stance].label} → ${target.token.name} wins the duel`;
      else if (outcomeBy === "ante") banner = `Tie on stance. Higher ante (L${target.anteLevel || 0} vs L${challenger.anteLevel || 0}) → ${target.token.name} wins the duel`;
      else banner = `Tie on stance and ante. Higher roll (${tRoll.total} vs ${cRoll.total}) → ${target.token.name} wins the duel`;
    }

    const outcomeContent = `<div class="md-chat">
      <h3>Magic Duel — Outcome</h3>
      <div class="md-outcome"><strong>${banner}</strong></div>
    </div>`;

    await ChatMessage.create({ content: outcomeContent, speaker: ChatMessage.getSpeaker({ actor: chalActor || targActor }) });
  }
}

Hooks.once("ready", () => {
  DuelManager.init();
});

// Expose API as early as possible for macros executed before "ready"
Hooks.once("init", () => {
  try {
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = { initiate: DuelManager.initiateFromSelection };
    // Optional global for convenience
    globalThis.MagicDueling = { initiate: DuelManager.initiateFromSelection };
  } catch (e) {
    console.error(MODULE_ID, "Failed to expose early API", e);
  }
});


