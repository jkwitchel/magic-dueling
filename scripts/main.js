import {
  STANCES,
  clampAnte,
  isMagicSkill,
  normalizeStance,
  resolveDuel,
  stanceLabel,
} from "./logic.js";

const MODULE_ID = "magic-dueling";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const HUD_BUTTON_CLASS = "magic-duel-hud-btn";

/* -------------------------------------------- */
/*  Foundry helpers                             */
/* -------------------------------------------- */

function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

function generateId() {
  return (
    foundry?.utils?.randomID?.() ??
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  );
}

function isPf2eActor(actor) {
  return (
    actor?.system?.schema?.id?.startsWith?.("pf2e") ||
    (game.system?.id === "pf2e" && !!actor?.system)
  );
}

/**
 * Build the private skill list for an actor, tagging PF2e magic skills.
 * Foundry-specific: reads the PF2e Statistic map or the raw system data.
 */
function getActorSkillChoices(actor) {
  const choices = [];
  const statMap = actor?.skills ?? actor?.system?.skills ?? {};
  for (const [key, data] of Object.entries(statMap)) {
    const label = data?.label ?? data?.name ?? String(key).toUpperCase();
    const modifier = Number(
      data?.totalModifier ?? data?.mod ?? data?.modifier ?? data?.value ?? 0,
    );
    if (!Number.isFinite(modifier)) continue;
    choices.push({ key, label, modifier, isMagic: isMagicSkill({ key, label }) });
  }
  choices.sort((a, b) => a.label.localeCompare(b.label));
  return choices;
}

/* -------------------------------------------- */
/*  DialogV2 helper                             */
/* -------------------------------------------- */

/**
 * Render a DialogV2 with a deterministic timeout. Closing/cancelling/timeout
 * all resolve with `undefined` so callers can treat them as decline/cancel.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.content
 * @param {number} [opts.width]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.modal]
 * @param {Array<{action: string, label: string, default?: boolean,
 *   value?: any, resolve?: Function}>} opts.buttons
 * @returns {Promise<any>} the selected button's value, or undefined
 */
async function runDialog({ title, content, width = 360, timeoutMs, modal = false, buttons }) {
  const DialogV2 = foundry.applications.api.DialogV2;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    const dlg = new DialogV2({
      window: { title },
      position: { width, height: "auto" },
      modal,
      content,
      buttons: buttons.map((b) => ({
        action: b.action,
        label: b.label,
        default: b.default ?? false,
        callback: async (event, button, dialog) => {
          try {
            const value = b.resolve ? await b.resolve(event, button, dialog) : b.value;
            finish(value);
            return value;
          } catch (err) {
            console.error(MODULE_ID, "dialog button error", err);
            finish(undefined);
            return undefined;
          }
        },
      })),
    });

    // Any close (window control, Escape, post-button auto-close, timeout)
    // funnels through here. `finish` ignores calls after the first.
    const origClose = dlg.close.bind(dlg);
    dlg.close = async (options) => {
      const result = await origClose(options);
      finish(undefined);
      return result;
    };

    dlg.render({ force: true });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(undefined);
        try {
          dlg.close();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
    }
  });
}

/* -------------------------------------------- */
/*  Socket transport (socketlib + native)       */
/* -------------------------------------------- */

function getSocketlib() {
  try {
    if (game.modules.get("socketlib")?.active && globalThis.socketlib) {
      return globalThis.socketlib.registerModule(MODULE_ID);
    }
  } catch (e) {
    console.warn(MODULE_ID, "socketlib unavailable", e);
  }
  return null;
}

/**
 * Send a request to a specific user and await their response.
 * Prefers socketlib; falls back to the native module socket channel.
 */
async function socketRequest(targetUserId, event, payload, { timeoutMs } = {}) {
  if (typeof targetUserId !== "string" || !targetUserId) {
    console.warn(MODULE_ID, "socketRequest called without a valid targetUserId");
    return undefined;
  }

  const socket = getSocketlib();
  if (socket?.executeAsUser) {
    try {
      return await socket.executeAsUser(event, targetUserId, payload);
    } catch (e) {
      console.warn(MODULE_ID, "socketlib request failed, using native fallback", e);
    }
  }

  return nativeSocketRequest(targetUserId, event, payload, { timeoutMs });
}

function nativeSocketRequest(targetUserId, event, payload, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    const requestId = generateId();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      game.socket.off(SOCKET_CHANNEL, handler);
      resolve(value);
    };
    const handler = (data) => {
      if (!data || data.kind !== "response" || data.requestId !== requestId) return;
      finish(data.response);
    };
    game.socket.on(SOCKET_CHANNEL, handler);
    game.socket.emit(SOCKET_CHANNEL, {
      kind: "request",
      type: event,
      payload,
      requestId,
      targetUserId,
      senderUserId: game.user.id,
    });
    // Deterministic ceiling; the remote prompt resolves well before this.
    const wait = Math.max(5_000, Number(timeoutMs) || 60_000) + 10_000;
    setTimeout(() => finish(undefined), wait);
  });
}

function registerNativeSocketHandler() {
  game.socket.on(SOCKET_CHANNEL, async (data) => {
    if (!data || data.kind !== "request") return;
    // Only the intended recipient handles a request; avoids duplicate prompts
    // when every connected client receives the broadcast.
    if (data.targetUserId !== game.user.id) return;
    if (typeof data.requestId !== "string" || typeof data.type !== "string") return;

    let response;
    try {
      response = await handleRemoteRequest(data.type, data.payload);
    } catch (err) {
      console.error(MODULE_ID, "remote request handler failed", err);
      response = undefined;
    }
    game.socket.emit(SOCKET_CHANNEL, {
      kind: "response",
      requestId: data.requestId,
      response,
    });
  });
}

async function handleRemoteRequest(type, payload) {
  switch (type) {
    case "prompt-accept":
      return DuelManager.promptAccept(payload);
    case "prompt-setup":
      return DuelManager.promptSetup(payload);
    case "opponent-ready":
      return DuelManager.receiveOpponentReady(payload);
    default:
      console.warn(MODULE_ID, "unknown socket request type", type);
      return undefined;
  }
}

/* -------------------------------------------- */
/*  Duel manager                                */
/* -------------------------------------------- */

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

    Hooks.on("renderTokenHUD", DuelManager.onRenderTokenHUD);

    // Register socketlib request handlers when available.
    const socket = getSocketlib();
    if (socket) {
      try {
        socket.register("prompt-accept", DuelManager.promptAccept);
        socket.register("prompt-setup", DuelManager.promptSetup);
        socket.register("opponent-ready", DuelManager.receiveOpponentReady);
      } catch (e) {
        console.error(MODULE_ID, "socketlib registration failed", e);
      }
    }

    registerNativeSocketHandler();

    DuelManager.exposeApi();
  }

  static exposeApi() {
    const api = { initiate: DuelManager.initiateFromSelection };
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api = api;
    // Intentional convenience global for macros.
    globalThis.MagicDueling = api;
  }

  /* -------------------- HUD -------------------- */

  static onRenderTokenHUD(hud, html) {
    try {
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root) return;

      const controlled = canvas.tokens.controlled;
      if (controlled.length !== 1) return;
      const token = controlled[0];
      if (!token?.actor?.isOwner || !isPf2eActor(token.actor)) return;

      // Avoid duplicates on repeated HUD renders.
      if (root.querySelector(`.${HUD_BUTTON_CLASS}`)) return;

      const sample = root.querySelector(".control-icon");
      const tag = sample?.tagName?.toLowerCase() === "button" ? "button" : "div";
      const btn = document.createElement(tag);
      if (tag === "button") btn.type = "button";
      btn.className = `control-icon ${HUD_BUTTON_CLASS}`;
      btn.dataset.tooltip = "Magic Duel";
      btn.setAttribute("aria-label", "Magic Duel");
      btn.innerHTML = `<i class="fas fa-hat-wizard"></i>`;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        DuelManager.initiateFromSelection();
      });

      const col = root.querySelector(".col.left") ?? root.querySelector(".col.right") ?? root;
      const container = col.querySelector(".control-buttons") ?? col;
      container.appendChild(btn);
    } catch (err) {
      console.error(MODULE_ID, "HUD button error", err);
    }
  }

  /* ----------------- Initiation ---------------- */

  static async initiateFromSelection() {
    try {
      const selection = canvas.tokens.controlled.filter((t) => t.actor && isPf2eActor(t.actor));
      if (selection.length < 1 || selection.length > 2) {
        ui.notifications.error("Select one or two PF2e tokens you own to start a duel.");
        return;
      }

      // One selected token + exactly one valid target → use the target.
      if (selection.length === 1) {
        const challengerCandidate = selection[0];
        const targeted = Array.from(game.user.targets ?? []);
        const validTargets = targeted
          .filter((t) => t?.id !== challengerCandidate?.id)
          .filter((t) => t?.actor && isPf2eActor(t.actor));
        if (validTargets.length === 1) {
          return await DuelManager._startWithTokens({
            challengerToken: challengerCandidate,
            targetToken: validTargets[0],
          });
        }
      }

      let challengerToken;
      let targetToken;

      if (selection.length === 2) {
        const owned = selection.filter((t) => t.actor?.isOwner);
        if (owned.length === 1) {
          challengerToken = owned[0];
          targetToken = selection.find((t) => t !== challengerToken);
        } else {
          const [a, b] = selection;
          const choice = await runDialog({
            title: "Select Challenger",
            width: 360,
            content: `<div class="magic-dueling-dialog">
              <p>Choose who is the challenger:</p>
              <div class="magic-dueling-row">
                <img src="${a.document.texture.src}" width="36" height="36" alt=""/>
                <strong>${a.name}</strong>
                <span>vs</span>
                <img src="${b.document.texture.src}" width="36" height="36" alt=""/>
                <strong>${b.name}</strong>
              </div>
            </div>`,
            buttons: [
              { action: "a", label: `${a.name} challenges`, default: true, value: "a" },
              { action: "b", label: `${b.name} challenges`, value: "b" },
              { action: "cancel", label: "Cancel", value: undefined },
            ],
          });
          if (!choice) return;
          challengerToken = choice === "a" ? a : b;
          targetToken = choice === "a" ? b : a;
        }
      } else {
        challengerToken = selection[0];
        const playerOwned = canvas.tokens.placeables.filter(
          (t) =>
            t !== challengerToken &&
            t.actor &&
            t.actor.hasPlayerOwner &&
            isPf2eActor(t.actor),
        );
        if (!playerOwned.length) {
          ui.notifications.warn("No valid target tokens owned by players in the scene.");
          return;
        }
        const options = playerOwned
          .map((t) => `<option value="${t.id}">${t.name} (${t.actor.name})</option>`)
          .join("");
        const picked = await runDialog({
          title: "Select Duel Target",
          width: 360,
          content: `<form class="magic-dueling-dialog">
            <div class="form-group">
              <label>Target</label>
              <select name="target">${options}</select>
            </div>
          </form>`,
          buttons: [
            {
              action: "ok",
              label: "OK",
              default: true,
              resolve: (event, button, dialog) =>
                dialog.element.querySelector("select[name=target]")?.value,
            },
            { action: "cancel", label: "Cancel", value: undefined },
          ],
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
      const allowAny = getSetting("allowAnyPlayerToInitiate");
      if (!challengerToken.actor?.isOwner) {
        ui.notifications.error("You must own the challenger's actor to initiate a duel.");
        return;
      }
      if (!allowAny && !targetToken.actor?.isOwner) {
        ui.notifications.error("You do not have permission to duel an actor you don't own.");
        return;
      }

      const acceptTimeout = getSetting("acceptTimeoutSec") * 1000;
      const targetUserId = DuelManager._owningUserId(targetToken.actor, {
        requireActive: true,
        allowGM: true,
      });
      if (!targetUserId) {
        ui.notifications.warn(
          "No eligible user is available to accept the duel (no owner or GM online).",
        );
        return;
      }

      const consentPayload = {
        challenger: DuelManager._tokenLite(challengerToken),
        target: DuelManager._tokenLite(targetToken),
        timeoutMs: acceptTimeout,
      };

      const accepted = await socketRequest(targetUserId, "prompt-accept", consentPayload, {
        timeoutMs: acceptTimeout,
      });
      if (!accepted) {
        await ChatMessage.create({
          content: `<div class="magic-dueling-chat"><p><strong>Magic Duel:</strong> ${targetToken.name} declined or did not respond.</p></div>`,
        });
        return;
      }

      const setupTimeout = getSetting("setupTimeoutSec") * 1000;
      const duelId = generateId();

      const [challengerSetup, targetSetup] = await Promise.all([
        DuelManager.promptSetup({
          duelId,
          who: "challenger",
          token: DuelManager._tokenLite(challengerToken),
          timeoutMs: setupTimeout,
          opponentUserId: targetUserId,
        }),
        socketRequest(
          targetUserId,
          "prompt-setup",
          {
            duelId,
            who: "target",
            token: DuelManager._tokenLite(targetToken),
            timeoutMs: setupTimeout,
            opponentUserId: game.user.id,
          },
          { timeoutMs: setupTimeout },
        ),
      ]);

      if (!challengerSetup || !targetSetup) {
        await ChatMessage.create({
          content: `<div class="magic-dueling-chat"><p><strong>Magic Duel:</strong> Duel cancelled during setup.</p></div>`,
        });
        return;
      }

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

  /* -------------------- Prompts (run on recipient client) ------------- */

  static async promptAccept(payload) {
    const { challenger, target, timeoutMs } = payload ?? {};
    if (!challenger?.name || !target?.name) {
      console.warn(MODULE_ID, "promptAccept received an incomplete payload", payload);
      return false;
    }
    const result = await runDialog({
      title: "Magic Duel Challenge",
      width: 360,
      timeoutMs: Math.max(5_000, Number(timeoutMs) || 30_000),
      content: `<div class="magic-dueling-dialog">
        <p>${challenger.name} challenges ${target.name} to a Magic Duel.</p>
        <div class="magic-dueling-row">
          <img src="${challenger.img}" width="48" height="48" alt=""/>
          <span>${challenger.name}</span>
          <span>vs</span>
          <img src="${target.img}" width="48" height="48" alt=""/>
          <span>${target.name}</span>
        </div>
      </div>`,
      buttons: [
        { action: "accept", label: "Accept", default: true, value: true },
        { action: "decline", label: "Decline", value: false },
      ],
    });
    return result === true;
  }

  static async promptSetup(payload) {
    const { duelId, who, token, timeoutMs, opponentUserId } = payload ?? {};
    if (!token?.actorId) {
      console.warn(MODULE_ID, "promptSetup received an incomplete payload", payload);
      return null;
    }
    const actor = game.actors.get(token.actorId);
    const skills = getActorSkillChoices(actor);
    if (!skills.length) {
      console.warn(MODULE_ID, "promptSetup found no skills for actor", token.actorId);
      return null;
    }

    const anteOptions = [
      { value: "0", label: "0 (Cantrip)" },
      ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
    ];

    const content = `<form class="magic-dueling-dialog magic-dueling-setup">
      <p>Select your skill and stance. This is private to you.</p>
      <div class="form-group">
        <label>Skill</label>
        <select name="skill">${skills
          .map((s) => {
            const star = s.isMagic ? "&#11088; " : "";
            const sign = s.modifier >= 0 ? "+" : "";
            const cls = s.isMagic ? ' class="magic-dueling-magic"' : "";
            return `<option value="${s.key}"${cls}>${star}${s.label} (${sign}${s.modifier})</option>`;
          })
          .join("")}</select>
      </div>
      <fieldset class="magic-dueling-stances">
        <legend>Stance</legend>
        ${Object.values(STANCES)
          .map(
            (st) => `<label class="magic-dueling-stance">
          <input type="radio" name="stance" value="${st.id}" ${st.id === "cast" ? "checked" : ""}>
          <span title="${st.tooltip}">${st.label}</span>
        </label>`,
          )
          .join("")}
      </fieldset>
      <div class="form-group">
        <label>Ante Spell Slot</label>
        <select name="ante">${anteOptions
          .map((o) => `<option value="${o.value}">${o.label}</option>`)
          .join("")}</select>
      </div>
    </form>`;

    const result = await runDialog({
      title: `Magic Duel Setup — ${who === "challenger" ? "Challenger" : "Target"}`,
      width: 360,
      timeoutMs: Math.max(10_000, Number(timeoutMs) || 60_000),
      content,
      buttons: [
        {
          action: "ready",
          label: "Ready",
          default: true,
          resolve: (event, button, dialog) => {
            const form = dialog.element.querySelector("form");
            const skillKey = form?.elements?.skill?.value;
            const stance = normalizeStance(form?.elements?.stance?.value) ?? "cast";
            const anteLevel = clampAnte(form?.elements?.ante?.value);
            const chosen = skills.find((s) => s.key === skillKey);
            ui.notifications.info("Ready — waiting for opponent...");
            if (opponentUserId) {
              DuelManager.notifyOpponentReady({ duelId, name: token.name, opponentUserId });
            }
            return {
              duelId,
              who,
              skillKey,
              skillLabel: chosen?.label ?? skillKey,
              modifier: chosen?.modifier ?? 0,
              stance,
              skillIsMagic: !!chosen?.isMagic,
              anteLevel,
            };
          },
        },
        { action: "cancel", label: "Cancel", value: null },
      ],
    });

    return result ?? null;
  }

  static async notifyOpponentReady({ duelId, name, opponentUserId }) {
    if (!opponentUserId) return;
    try {
      await socketRequest(opponentUserId, "opponent-ready", { duelId, name });
    } catch (e) {
      console.warn(MODULE_ID, "notifyOpponentReady failed", e);
    }
  }

  static receiveOpponentReady(payload) {
    const name = payload?.name;
    if (name) ui.notifications.info(`${name} is ready.`);
    return true;
  }

  /* -------------------- Resolution ------------- */

  static async resolveAndAnnounce({ challenger, target }) {
    const chalActor = game.actors.get(challenger.token.actorId);
    const targActor = game.actors.get(target.token.actorId);

    const cRoll = await new Roll(`1d20 + ${Number(challenger.modifier) || 0}`).evaluate();
    const tRoll = await new Roll(`1d20 + ${Number(target.modifier) || 0}`).evaluate();

    const chalFlavor = `Magic Duel — Challenger: ${challenger.token.name} — ${stanceLabel(
      challenger.stance,
    )} — ${challenger.skillLabel}${challenger.anteLevel ? ` — Ante: L${challenger.anteLevel}` : ""}`;
    const targFlavor = `Magic Duel — Target: ${target.token.name} — ${stanceLabel(
      target.stance,
    )} — ${target.skillLabel}${target.anteLevel ? ` — Ante: L${target.anteLevel}` : ""}`;

    await cRoll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: chalActor }),
      flavor: chalFlavor,
    });
    await tRoll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: targActor }),
      flavor: targFlavor,
    });

    const outcome = resolveDuel({
      challengerStance: challenger.stance,
      targetStance: target.stance,
      challengerAnte: challenger.anteLevel,
      targetAnte: target.anteLevel,
      challengerRoll: cRoll.total,
      targetRoll: tRoll.total,
    });

    const banner = DuelManager._buildBanner(outcome, challenger, target, cRoll, tRoll);

    const outcomeContent = `<div class="magic-dueling-chat">
      <h3>Magic Duel — Outcome</h3>
      <div class="magic-dueling-outcome"><strong>${banner}</strong></div>
    </div>`;

    await ChatMessage.create({
      content: outcomeContent,
      speaker: ChatMessage.getSpeaker({ actor: chalActor || targActor }),
    });
  }

  static _buildBanner(outcome, challenger, target, cRoll, tRoll) {
    const cName = challenger.token.name;
    const tName = target.token.name;
    const cStance = stanceLabel(challenger.stance);
    const tStance = stanceLabel(target.stance);

    if (outcome.winner === "tie") {
      return `Tie — both chose ${cStance}, equal ante, and equal roll`;
    }

    const winnerIsChallenger = outcome.winner === "challenger";
    const winName = winnerIsChallenger ? cName : tName;
    const winStance = winnerIsChallenger ? cStance : tStance;
    const loseStance = winnerIsChallenger ? tStance : cStance;
    const winAnte = winnerIsChallenger ? outcome.challengerAnte : outcome.targetAnte;
    const loseAnte = winnerIsChallenger ? outcome.targetAnte : outcome.challengerAnte;
    const winRoll = winnerIsChallenger ? cRoll.total : tRoll.total;
    const loseRoll = winnerIsChallenger ? tRoll.total : cRoll.total;

    if (outcome.by === "stance") {
      return `${winStance} beats ${loseStance} → ${winName} wins the duel`;
    }
    if (outcome.by === "ante") {
      return `Tie on stance. Higher ante (L${winAnte} vs L${loseAnte}) → ${winName} wins the duel`;
    }
    return `Tie on stance and ante. Higher roll (${winRoll} vs ${loseRoll}) → ${winName} wins the duel`;
  }
}

Hooks.once("ready", () => {
  DuelManager.init();
});

// Expose the API early so macros running before "ready" still work.
Hooks.once("init", () => {
  try {
    DuelManager.exposeApi();
  } catch (e) {
    console.error(MODULE_ID, "Failed to expose early API", e);
  }
});
