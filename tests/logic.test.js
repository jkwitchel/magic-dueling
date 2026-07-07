import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STANCES,
  clampAnte,
  isMagicSkill,
  normalizeStance,
  resolveDuel,
  stanceOutcome,
} from "../scripts/logic.js";

test("Cast beats Trick", () => {
  assert.equal(stanceOutcome("cast", "trick"), 1);
  assert.equal(stanceOutcome("trick", "cast"), -1);
});

test("Trick beats Shield", () => {
  assert.equal(stanceOutcome("trick", "shield"), 1);
  assert.equal(stanceOutcome("shield", "trick"), -1);
});

test("Shield beats Cast", () => {
  assert.equal(stanceOutcome("shield", "cast"), 1);
  assert.equal(stanceOutcome("cast", "shield"), -1);
});

test("Same stance ties on stance and falls through to ante", () => {
  assert.equal(stanceOutcome("cast", "cast"), 0);
  const result = resolveDuel({
    challengerStance: "cast",
    targetStance: "cast",
    challengerAnte: 3,
    targetAnte: 1,
  });
  assert.equal(result.by, "ante");
});

test("Higher ante wins when stance ties", () => {
  const challengerHigher = resolveDuel({
    challengerStance: "shield",
    targetStance: "shield",
    challengerAnte: 5,
    targetAnte: 2,
  });
  assert.deepEqual(
    { winner: challengerHigher.winner, by: challengerHigher.by },
    { winner: "challenger", by: "ante" },
  );

  const targetHigher = resolveDuel({
    challengerStance: "shield",
    targetStance: "shield",
    challengerAnte: 1,
    targetAnte: 4,
  });
  assert.deepEqual(
    { winner: targetHigher.winner, by: targetHigher.by },
    { winner: "target", by: "ante" },
  );
});

test("Same stance and same ante falls through to roll total", () => {
  const result = resolveDuel({
    challengerStance: "trick",
    targetStance: "trick",
    challengerAnte: 2,
    targetAnte: 2,
    challengerRoll: 18,
    targetRoll: 12,
  });
  assert.equal(result.by, "roll");
});

test("Higher roll wins when stance and ante tie", () => {
  const challengerHigher = resolveDuel({
    challengerStance: "trick",
    targetStance: "trick",
    challengerAnte: 2,
    targetAnte: 2,
    challengerRoll: 20,
    targetRoll: 10,
  });
  assert.deepEqual(
    { winner: challengerHigher.winner, by: challengerHigher.by },
    { winner: "challenger", by: "roll" },
  );

  const targetHigher = resolveDuel({
    challengerStance: "trick",
    targetStance: "trick",
    challengerAnte: 2,
    targetAnte: 2,
    challengerRoll: 8,
    targetRoll: 19,
  });
  assert.deepEqual(
    { winner: targetHigher.winner, by: targetHigher.by },
    { winner: "target", by: "roll" },
  );
});

test("Exact same stance, ante, and roll is a tie", () => {
  const result = resolveDuel({
    challengerStance: "cast",
    targetStance: "cast",
    challengerAnte: 4,
    targetAnte: 4,
    challengerRoll: 15,
    targetRoll: 15,
  });
  assert.deepEqual({ winner: result.winner, by: result.by }, { winner: "tie", by: null });
});

test("Ante clamps/normalizes to 0-10", () => {
  assert.equal(clampAnte(-3), 0);
  assert.equal(clampAnte(0), 0);
  assert.equal(clampAnte(7), 7);
  assert.equal(clampAnte(10), 10);
  assert.equal(clampAnte(11), 10);
  assert.equal(clampAnte(999), 10);
  assert.equal(clampAnte(3.9), 3);
  assert.equal(clampAnte("5"), 5);
  assert.equal(clampAnte("not a number"), 0);
  assert.equal(clampAnte(undefined), 0);
  assert.equal(clampAnte(null), 0);
  assert.equal(clampAnte(NaN), 0);
});

test("Invalid stance handling is safe and deterministic", () => {
  // Two invalid stances tie.
  assert.equal(stanceOutcome("banana", "waffle"), 0);
  assert.equal(stanceOutcome(undefined, null), 0);
  // A valid stance always beats an invalid one, regardless of side.
  assert.equal(stanceOutcome("cast", "banana"), 1);
  assert.equal(stanceOutcome("banana", "cast"), -1);
  // normalizeStance is case-insensitive and rejects unknowns.
  assert.equal(normalizeStance("CAST"), "cast");
  assert.equal(normalizeStance(" Shield "), "shield");
  assert.equal(normalizeStance("nope"), null);
  assert.equal(normalizeStance(42), null);

  // resolveDuel stays deterministic with invalid input; falls through cleanly.
  const result = resolveDuel({
    challengerStance: "banana",
    targetStance: "waffle",
    challengerAnte: 2,
    targetAnte: 2,
    challengerRoll: 10,
    targetRoll: 10,
  });
  assert.deepEqual({ winner: result.winner, by: result.by }, { winner: "tie", by: null });
});

test("isMagicSkill identifies PF2e magic skills", () => {
  assert.equal(isMagicSkill({ key: "arcana", label: "Arcana" }), true);
  assert.equal(isMagicSkill({ key: "occultism" }), true);
  assert.equal(isMagicSkill({ label: "Religion" }), true);
  assert.equal(isMagicSkill({ key: "athletics", label: "Athletics" }), false);
  assert.equal(isMagicSkill({}), false);
  assert.equal(isMagicSkill(), false);
});

test("STANCES exposes the three canonical stances", () => {
  assert.deepEqual(Object.keys(STANCES).sort(), ["cast", "shield", "trick"]);
});
