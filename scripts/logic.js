/**
 * Pure, Foundry-independent duel logic for the Magic Dueling module.
 *
 * Nothing in this file may reference Foundry globals (game, canvas, ui, Roll,
 * Dialog, Hooks, etc.). Everything here must be unit-testable under plain Node.
 */

export const STANCES = {
  cast: { id: "cast", label: "Cast", tooltip: "Offense—beats Trick, loses to Shield" },
  trick: { id: "trick", label: "Trick", tooltip: "Feint—beats Shield, loses to Cast" },
  shield: { id: "shield", label: "Shield", tooltip: "Guard—beats Cast, loses to Trick" },
};

export const STANCE_IDS = Object.keys(STANCES);

/** PF2e core magic skills to visually highlight in UI and chat. */
export const MAGIC_SKILL_LABELS = new Set(["arcana", "nature", "occultism", "religion"]);

/** Minimum and maximum ante (informational spell-slot level). */
export const ANTE_MIN = 0;
export const ANTE_MAX = 10;

/**
 * Determine whether a value refers to a known stance.
 * @param {unknown} stance
 * @returns {boolean}
 */
export function isValidStance(stance) {
  return typeof stance === "string" && Object.prototype.hasOwnProperty.call(STANCES, stance);
}

/**
 * Normalize an arbitrary value into a known stance id, or null if invalid.
 * @param {unknown} stance
 * @returns {("cast"|"trick"|"shield"|null)}
 */
export function normalizeStance(stance) {
  if (typeof stance !== "string") return null;
  const s = stance.toLowerCase().trim();
  return isValidStance(s) ? s : null;
}

/**
 * Human-friendly label for a stance id, falling back to the raw value.
 * @param {string} stance
 * @returns {string}
 */
export function stanceLabel(stance) {
  return STANCES[stance]?.label ?? String(stance);
}

/**
 * Rock/paper/scissors comparison of two stances.
 * Cast beats Trick, Trick beats Shield, Shield beats Cast.
 *
 * Invalid or missing stances are handled deterministically:
 *  - two invalid stances tie (0)
 *  - a valid stance beats an invalid stance
 *
 * @param {unknown} a challenger stance
 * @param {unknown} b target stance
 * @returns {(1|0|-1)} 1 if a wins, -1 if b wins, 0 if tie
 */
export function stanceOutcome(a, b) {
  const av = normalizeStance(a);
  const bv = normalizeStance(b);

  if (!av && !bv) return 0;
  if (av && !bv) return 1;
  if (!av && bv) return -1;

  if (av === bv) return 0;
  if (
    (av === "cast" && bv === "trick") ||
    (av === "trick" && bv === "shield") ||
    (av === "shield" && bv === "cast")
  ) {
    return 1;
  }
  return -1;
}

/**
 * Clamp/normalize an ante value into the informational 0–10 range.
 * Non-numeric or NaN values collapse to ANTE_MIN.
 * @param {unknown} value
 * @returns {number} integer in [ANTE_MIN, ANTE_MAX]
 */
export function clampAnte(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ANTE_MIN;
  const floored = Math.floor(n);
  return Math.min(ANTE_MAX, Math.max(ANTE_MIN, floored));
}

/**
 * Whether a skill (by key and/or label) is one of the PF2e magic skills.
 * @param {{key?: string, label?: string}} skill
 * @returns {boolean}
 */
export function isMagicSkill({ key, label } = {}) {
  const k = typeof key === "string" ? key.toLowerCase() : "";
  const l = typeof label === "string" ? label.toLowerCase() : "";
  return MAGIC_SKILL_LABELS.has(k) || MAGIC_SKILL_LABELS.has(l);
}

/**
 * Resolve the full duel outcome using the tie-breaker cascade:
 *   1. stance (Cast/Trick/Shield)
 *   2. higher ante
 *   3. higher roll total
 *   4. otherwise a true tie
 *
 * @param {object} params
 * @param {unknown} params.challengerStance
 * @param {unknown} params.targetStance
 * @param {unknown} [params.challengerAnte]
 * @param {unknown} [params.targetAnte]
 * @param {unknown} [params.challengerRoll]
 * @param {unknown} [params.targetRoll]
 * @returns {{winner: ("challenger"|"target"|"tie"), by: ("stance"|"ante"|"roll"|null),
 *   challengerAnte: number, targetAnte: number}}
 */
export function resolveDuel({
  challengerStance,
  targetStance,
  challengerAnte,
  targetAnte,
  challengerRoll,
  targetRoll,
} = {}) {
  const cAnte = clampAnte(challengerAnte);
  const tAnte = clampAnte(targetAnte);

  let outcome = stanceOutcome(challengerStance, targetStance);
  let by = outcome === 0 ? null : "stance";

  if (outcome === 0) {
    if (cAnte !== tAnte) {
      outcome = cAnte > tAnte ? 1 : -1;
      by = "ante";
    } else {
      const cRoll = Number(challengerRoll) || 0;
      const tRoll = Number(targetRoll) || 0;
      if (cRoll !== tRoll) {
        outcome = cRoll > tRoll ? 1 : -1;
        by = "roll";
      }
    }
  }

  let winner = "tie";
  if (outcome === 1) winner = "challenger";
  else if (outcome === -1) winner = "target";

  return { winner, by, challengerAnte: cAnte, targetAnte: tAnte };
}
