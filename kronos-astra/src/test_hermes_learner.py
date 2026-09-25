"""Synthetic fixtures only: no exchange, provider or order calls."""
import json
import random
import tempfile
import unittest
from pathlib import Path

import hermes_context as C
import hermes_learner as L
from astra_experiments import ExperimentBook, DAY

T0 = 1800000000000 - 1800000000000 % L.BAR5
REV = ("setupType", "REVERSAL")
TREND = ("setupType", "PULLBACK_CONTINUATION")


def plan(pid="p1", side="LONG", trig=100.0, stop=99.0, target=102.0, lo=99.9, hi=100.3, hold=3600000,
         symbol="COINUSDT", expires=None):
    return {"id": pid, "symbol": symbol, "side": side,
            "triggerKind": "CLOSE_ABOVE" if side == "LONG" else "CLOSE_BELOW",
            "triggerPrice": trig, "entryMin": lo, "entryMax": hi, "stopPrice": stop, "targetPrice": target,
            "maxHoldMs": hold, "expiresAt": expires or T0 + 3600000, "entrySlippageBps": 5, "exitSlippageBps": 5}


def bars(closes, start=T0, highs=None, lows=None):
    return [(start + i * L.MINUTE, highs[i] if highs else c, lows[i] if lows else c, c) for i, c in enumerate(closes)]


class SimulateTests(unittest.TestCase):
    def test_trigger_on_closed_5m_then_band_entry_then_target(self):
        closes = [99.5] * 5 + [100.1] * 5 + [101.0] * 5 + [102.5] * 5
        r = L.simulate(plan(), T0, T0 + 3600000, bars(closes))
        self.assertEqual((r["status"], r["entry"], r["enteredAt"]), ("TARGET", 100.1, T0 + 9 * L.MINUTE))

    def test_pre_creation_5m_close_counts_like_the_host(self):
        closes = [100.1] * 10 + [100.2] * 3 + [103.0]
        r = L.simulate(plan(), T0 + 6 * L.MINUTE, T0 + 3600000, bars(closes))
        self.assertEqual((r["status"], r["enteredAt"]), ("TARGET", T0 + 6 * L.MINUTE))

    def test_stop_wins_ties_and_band_miss_is_no_fill(self):
        r = L.simulate(plan(), T0, T0 + 3600000,
                       bars([100.1] * 6, highs=[100.1] * 5 + [103.0], lows=[100.1] * 5 + [98.0]))
        self.assertEqual(r["status"], "STOP")
        self.assertEqual(L.simulate(plan(), T0, T0 + 3600000, bars([101.0] * 30))["status"], "NOT_TRIGGERED")


def kbars(n, start, step, p0, drift, spread=0.002, vol=1000.0):
    """(openTime, open, high, low, close, quoteVolume, closeTime) synthetic klines."""
    out, p = [], p0
    for i in range(n):
        o = p
        p = p * (1 + drift)
        out.append((start + i * step, o, max(o, p) * (1 + spread), min(o, p) * (1 - spread), p, vol, start + (i + 1) * step - 1))
    return out


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.created = T0 + 400 * C.M5
        self.b5 = kbars(420, T0, C.M5, 100.0, 0.0008)
        self.b1 = kbars(80, self.created - 80 * C.H1, C.H1, 90.0, 0.004)
        self.btc = kbars(420, T0, C.M5, 50000.0, 0.0005)

    def test_only_bars_closed_before_creation_are_used(self):
        p = plan(trig=200.0, stop=198.0, target=204.0, lo=199.0, hi=201.0)
        a = C.compute(p, self.created, self.b5, self.b1, self.btc, cost_bps=18)
        future = [(t, o, h * 10, l, c * 10, v, ct) for (t, o, h, l, c, v, ct) in self.b5 if ct >= self.created]
        b = C.compute(p, self.created, [x for x in self.b5 if x[6] < self.created] + future, self.b1, self.btc, cost_bps=18)
        self.assertEqual(a, b)

    def test_uptrend_long_reads_as_aligned_trend(self):
        px = [b for b in self.b5 if b[6] < self.created][-1][4]
        p = plan(trig=px * 1.001, stop=px * 0.99, target=px * 1.03, lo=px, hi=px * 1.002)
        ctx = C.compute(p, self.created, self.b5, self.b1, self.btc, cost_bps=18)
        self.assertEqual(ctx["regime"], "TREND_WITH")
        self.assertGreater(ctx["momentum4hAtr"], 0)
        short = C.compute(dict(p, side="SHORT"), self.created, self.b5, self.b1, self.btc, cost_bps=18)
        self.assertEqual(short["regime"], "TREND_AGAINST")
        self.assertEqual(short["setupType"], "REVERSAL")
        atoms = dict(C.atoms(ctx))
        self.assertEqual(atoms["costBps"], "LOW")
        self.assertIn(("side", "LONG"), C.atoms(ctx))

    def test_short_history_is_not_guessed(self):
        self.assertIsNone(C.compute(plan(), self.created, self.b5[:50], self.b1, self.btc))


def episode(i, t, atoms, r, symbol=None, regime="RANGE"):
    return {"key": "k%d" % i, "keys": ["k%d" % i], "symbol": symbol or "C%dUSDT" % (i % 9), "side": "LONG",
            "createdAt": t, "R": r, "atoms": frozenset(atoms), "regime": regime}


def stream(n, start, rng, effect=True, offset=0):
    """Half of the episodes are REVERSAL setups that lose ~1R when `effect` is on."""
    out = []
    for i in range(n):
        rev = i % 2 == 0
        atoms = [REV if rev else TREND, ("side", "LONG")]
        r = rng.gauss(-1.0 if (rev and effect) else 0.1, 0.6)
        out.append(episode(offset + i, start + i * L.EPISODE_MS, atoms, r,
                           regime=("RANGE", "TREND_WITH", "TREND_AGAINST")[i % 3]))
    return out


class LifecycleTests(unittest.TestCase):
    def lesson(self, state, direction="AVOID", key="setupType=REVERSAL"):
        return next(l for l in state["lessons"].values() if l["patternKey"] == key and l["direction"] == direction)

    def test_history_alone_never_goes_beyond_candidate(self):
        eps = stream(80, T0, random.Random(1))
        state = L.empty_state()
        L.update_lessons(state, eps, T0 + 90 * L.EPISODE_MS)
        L.update_lessons(state, eps, T0 + 91 * L.EPISODE_MS)
        self.assertTrue(state["lessons"])
        self.assertEqual({l["status"] for l in state["lessons"].values()}, {"CANDIDATE_LESSON"})
        self.assertEqual(self.lesson(state)["evidence"]["expectancyR"] < 0, True)

    def test_prospective_confirmation_promotes_step_by_step_to_strong(self):
        rng = random.Random(2)
        hist = stream(40, T0, rng)
        state = L.empty_state()
        found_at = T0 + 50 * L.EPISODE_MS
        L.update_lessons(state, hist, found_at)
        lesson = self.lesson(state)
        seen = []
        for k in range(1, 7):
            future = stream(10 * k, found_at + L.EPISODE_MS, random.Random(3), offset=1000)
            L.update_lessons(state, hist + future, found_at + (10 * k + 2) * L.EPISODE_MS)
            seen.append(lesson["status"])
        self.assertIn("SUPPORTED", seen)
        self.assertIn("ACTIVE_PRIOR", seen)
        self.assertEqual(seen[-1], "STRONG")
        for field in ("sampleN", "expectancyR", "pf", "confidence", "supportingExamples", "contradictingExamples",
                      "prospectiveN", "winRate", "maxSymbolShare"):
            self.assertIn(field, lesson["evidence"])
        self.assertIn("scope", lesson)
        self.assertIn("lastUpdated", lesson)
        self.assertIn("evidenceStatus", lesson)

    def test_prospective_reversal_contradicts_then_retires(self):
        rng = random.Random(4)
        hist = stream(40, T0, rng)
        state = L.empty_state()
        found_at = T0 + 50 * L.EPISODE_MS
        L.update_lessons(state, hist, found_at)
        lesson = self.lesson(state)
        flipped = []
        for i, e in enumerate(stream(24, found_at + L.EPISODE_MS, random.Random(5), effect=False, offset=2000)):
            flipped.append(dict(e, R=(0.9 if REV in e["atoms"] else -0.5)))
        L.update_lessons(state, hist + flipped, found_at + 30 * L.EPISODE_MS)
        self.assertEqual(lesson["status"], "CONTRADICTED")
        L.update_lessons(state, hist + flipped, found_at + 31 * L.EPISODE_MS)
        self.assertEqual(lesson["status"], "RETIRED")

    def test_losers_inside_a_good_pattern_do_not_kill_it(self):
        rng = random.Random(6)
        # PREFER pattern with only ~55% winners but clearly better expectancy
        def pref_stream(n, start, offset):
            out = []
            for i in range(n):
                good = i % 2 == 0
                if good:
                    r = 1.2 if rng.random() < 0.55 else -0.8
                else:
                    r = rng.gauss(-0.4, 0.5)
                out.append(episode(offset + i, start + i * L.EPISODE_MS, [TREND if good else REV], r))
            return out
        hist = pref_stream(40, T0, 0)
        state = L.empty_state()
        found_at = T0 + 50 * L.EPISODE_MS
        L.update_lessons(state, hist, found_at)
        lesson = self.lesson(state, "PREFER", "setupType=PULLBACK_CONTINUATION")
        L.update_lessons(state, hist + pref_stream(40, found_at + L.EPISODE_MS, 3000), found_at + 45 * L.EPISODE_MS)
        self.assertIn(lesson["status"], ("ACTIVE_PRIOR", "STRONG"))
        self.assertTrue(lesson["evidence"]["contradictingExamples"])

    def test_one_symbol_cannot_carry_an_active_prior(self):
        rng = random.Random(7)
        hist = [dict(e, symbol="ONEUSDT") if REV in e["atoms"] else e for e in stream(40, T0, rng)]
        state = L.empty_state()
        found_at = T0 + 50 * L.EPISODE_MS
        L.update_lessons(state, hist, found_at)
        lesson = self.lesson(state)
        fut = [dict(e, symbol="ONEUSDT") if REV in e["atoms"] else e
               for e in stream(40, found_at + L.EPISODE_MS, random.Random(8), offset=4000)]
        L.update_lessons(state, hist + fut, found_at + 45 * L.EPISODE_MS)
        self.assertNotIn(lesson["status"], ("ACTIVE_PRIOR", "STRONG"))


class MetricTests(unittest.TestCase):
    def test_perf_reports_the_distribution_not_just_the_mean(self):
        m = L.perf([1.0, -1.0, -1.0, 2.0, -0.5])
        self.assertEqual((m["n"], m["winRate"], m["avgWinR"], m["avgLossR"]), (5, 0.4, 1.5, -0.833))
        self.assertEqual(m["maxDrawdownR"], 2.0)   # equity 1 -> 0 -> -1: peak-to-trough 2R
        self.assertEqual(m["pf"], round(3 / 2.5, 3))
        self.assertEqual(m["payoffRatio"], round(1.5 / 0.8333333, 3))
        self.assertIsNone(L.perf([])["expectancyR"])

    def test_avoidance_counts_skipped_winners_against_avoided_losers(self):
        a = L.avoidance([1.0, 2.0, -1.0, -1.0, -1.0])
        self.assertEqual((a["avoidedLosers"], a["avoidedLossR"], a["skippedWinners"], a["skippedWinR"]), (3, 3.0, 2, 3.0))
        self.assertEqual((a["netBlockValueR"], a["savedToSkippedRatio"]), (0.0, 1.0))

    def test_avoid_that_throws_away_many_winners_never_becomes_active(self):
        rng = random.Random(11)

        def mixed(n, start, offset):
            out = []
            for i in range(n):
                bad = i % 2 == 0
                if bad:   # negative expectancy, but half are real winners: saved/skipped ~1.3
                    r = 1.0 if i % 4 == 0 else -1.3
                else:
                    r = rng.gauss(0.3, 0.3)
                out.append(episode(offset + i, start + i * L.EPISODE_MS, [REV if bad else TREND], r))
            return out
        hist = mixed(40, T0, 0)
        state = L.empty_state()
        found_at = T0 + 50 * L.EPISODE_MS
        L.update_lessons(state, hist, found_at)
        lesson = next(l for l in state["lessons"].values() if l["patternKey"] == "setupType=REVERSAL")
        L.update_lessons(state, hist + mixed(60, found_at + L.EPISODE_MS, 5000), found_at + 70 * L.EPISODE_MS)
        self.assertLess(lesson["evidence"]["expectancyR"], lesson["evidence"]["baselineR"])
        self.assertLess(lesson["evidence"]["ifBlocked"]["savedToSkippedRatio"], L.T["avoidSavedToSkippedMin"])
        self.assertNotIn(lesson["status"], ("ACTIVE_PRIOR", "STRONG"))

    def test_prefer_riding_a_good_stratum_has_no_uplift_vs_comparables(self):
        rng = random.Random(12)

        def rows(n, start, offset):
            out = []
            for i in range(n):
                long_side = i % 2 == 0
                side = ("side", "LONG" if long_side else "SHORT")
                marker = ("volExpansion", "EXPANDING" if (long_side and i % 4 == 0) else "NORMAL")
                r = rng.gauss(0.6 if long_side else -0.8, 0.3)   # LONG is good; the marker adds nothing
                out.append(episode(offset + i, start + i * L.EPISODE_MS, [side, marker, ("setupType", "BREAKOUT")], r))
            return out
        hist = rows(60, T0, 0)
        state = L.empty_state()
        found_at = T0 + 70 * L.EPISODE_MS
        L.update_lessons(state, hist, found_at)
        L.update_lessons(state, hist + rows(80, found_at + L.EPISODE_MS, 6000), found_at + 90 * L.EPISODE_MS)
        marker = [l for l in state["lessons"].values() if l["patternKey"] == "volExpansion=EXPANDING" and l["direction"] == "PREFER"]
        self.assertTrue(marker)
        comp = marker[0]["evidence"]["vsComparable"]
        self.assertLess(abs(comp["upliftVsComparableR"]), L.T["preferMinUpliftR"] + 0.1)
        self.assertNotIn(marker[0]["status"], ("ACTIVE_PRIOR", "STRONG"))
        long_lesson = next(l for l in state["lessons"].values() if l["patternKey"] == "side=LONG")
        self.assertIn(long_lesson["status"], ("ACTIVE_PRIOR", "STRONG"))


class PriorTests(unittest.TestCase):
    def state_with(self, *lessons):
        state = L.empty_state()
        for lid, key, direction, status in lessons:
            state["lessons"][lid] = {"id": lid, "patternKey": key, "direction": direction, "status": status,
                                     "description": key, "evidence": {"sampleN": 20}, "lastUpdated": T0}
        return state

    def test_three_outputs(self):
        s = self.state_with(("A", "setupType=REVERSAL", "AVOID", "ACTIVE_PRIOR"),
                            ("P", "setupType=PULLBACK_CONTINUATION", "PREFER", "ACTIVE_PRIOR"),
                            ("X", "side=LONG", "PREFER", "ACTIVE_PRIOR"),
                            ("C", "side=SHORT", "AVOID", "CANDIDATE_LESSON"))
        self.assertEqual(L.verdict_for(s, [REV, ("side", "SHORT")])["verdict"], "AVOID")
        self.assertEqual(L.verdict_for(s, [TREND, ("side", "SHORT")])["verdict"], "PREFER")
        self.assertEqual(L.verdict_for(s, [("setupType", "BREAKOUT"), ("side", "SHORT")])["verdict"], "UNCERTAIN")
        conflict = L.verdict_for(s, [REV, ("side", "LONG")])
        self.assertEqual((conflict["verdict"], conflict["conflict"]), ("UNCERTAIN", True))

    def test_only_candidate_arm_sees_priors(self):
        s = self.state_with(("A", "setupType=REVERSAL", "AVOID", "ACTIVE_PRIOR"),
                            ("C", "side=SHORT", "AVOID", "SUPPORTED"))
        s["verdicts"] = {"plan1": {"verdict": "AVOID"}}
        control = L.fast_context(s, "CONTROL", ["plan1"])
        self.assertEqual((control["lessons"], control["planPriors"]), ([], {}))
        cand = L.fast_context(s, "CANDIDATE", ["plan1", "missing"])
        self.assertEqual([l["id"] for l in cand["lessons"]], ["A"])
        self.assertEqual(cand["planPriors"], {"plan1": {"verdict": "AVOID"}})
        self.assertIn("never an instruction to enter", cand["meaning"])

    def test_host_blocks_only_strong_avoid_in_candidate_arm(self):
        ctx = {"setupType": "REVERSAL", "side": "LONG", "regime": "RANGE"}
        w = {"plan": plan("b1"), "createdAt": T0}
        active = self.state_with(("A", "setupType=REVERSAL", "AVOID", "ACTIVE_PRIOR"))
        active["contexts"][L.plan_key(w)] = ctx
        self.assertEqual(L.screen(active, w, "CANDIDATE"), [])
        strong = self.state_with(("S", "setupType=REVERSAL", "AVOID", "STRONG"))
        strong["contexts"][L.plan_key(w)] = ctx
        self.assertTrue(L.screen(strong, w, "CANDIDATE"))
        self.assertEqual(L.screen(strong, w, "CONTROL"), [])
        other = {"plan": plan("b2"), "createdAt": T0}
        self.assertTrue(L.screen(strong, other, "CANDIDATE", context_builder=lambda _: ctx))
        self.assertEqual(L.screen(strong, other, "CANDIDATE"), [])  # unknown context blocks nothing
        prefer = self.state_with(("P", "setupType=REVERSAL", "PREFER", "STRONG"))
        prefer["contexts"][L.plan_key(w)] = ctx
        self.assertEqual(L.screen(prefer, w, "CANDIDATE"), [])  # PREFER never acts on its own

    def test_state_refuses_changed_bins(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "hermes-home").mkdir()
            state = L.empty_state()
            state["binsHash"] = "other"
            (root / "hermes-home" / L.STATE_NAME).write_text(json.dumps(state))
            with self.assertRaises(ValueError):
                L.load_state(root)
            self.assertIsNone(L.read_state_quiet(root))


class TickTests(unittest.TestCase):
    def test_tick_labels_contexts_and_survives_errors(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "hermes-home").mkdir()
            done = {"plan": plan("done"), "createdAt": T0, "evaluations": [{"costBps": 15}]}
            fresh = {"plan": plan("fresh", expires=T0 + 10 * DAY), "createdAt": T0}
            broken = {"plan": plan("broken", symbol="BADUSDT"), "createdAt": T0}
            (root / "hermes-home" / "astra-plans.json").write_text(json.dumps({"plans": [done, fresh, broken]}))

            def fetch(symbol, start, end):
                if symbol == "BADUSDT":
                    raise OSError("boom")
                return bars([100.1] * 5 + [102.5] * 5)

            def builder(w):
                if w["plan"]["symbol"] == "BADUSDT":
                    raise OSError("ctx boom")
                return {"side": "LONG", "regime": "RANGE", "setupType": "BREAKOUT", "costBps": 15}
            summary = L.tick(root, fetch=fetch, builder=builder, now=T0 + 3 * 3600000)
            state = L.load_state(root)
            self.assertEqual({v["planId"] for v in state["labels"].values()}, {"done"})
            self.assertEqual(len(state["contexts"]), 2)
            self.assertTrue(state["fetchErrors"])
            self.assertEqual(summary["episodes"], 1)
            self.assertIn("HERMES LEARNER", L.summary_text(state))
            self.assertEqual(state["verdicts"]["done"]["verdict"], "UNCERTAIN")


class ABReportTests(unittest.TestCase):
    def test_report_counts_skipped_winners_and_avoided_losers_per_arm(self):
        state = L.empty_state()
        plans, arms = [], {}
        rs = {"a1": -1.0, "a2": -1.0, "a3": 1.5, "p1": 1.0, "u1": -0.5, "k1": -1.0, "k2": 2.0}
        verdict = {"a1": "AVOID", "a2": "AVOID", "a3": "AVOID", "p1": "PREFER", "u1": "UNCERTAIN",
                   "k1": "AVOID", "k2": "AVOID"}
        entered = {"a2", "p1", "u1", "k1", "k2"}
        for i, (pid, r) in enumerate(rs.items()):
            p = plan(pid)
            w = {"plan": p, "createdAt": T0 + i * L.MINUTE}
            if pid in entered:
                w["submissionId"] = "d-" + pid
            plans.append(w)
            key = L.plan_key(w)
            state["labels"][key] = {"status": "STOP", "netBps": r * L.stop_bps(p), "createdAt": w["createdAt"],
                                    "planId": pid, "symbol": p["symbol"], "side": "LONG"}
            state["contexts"][key] = {"side": "LONG", "setupType": "BREAKOUT", "regime": "RANGE"}
            state.setdefault("verdictAtCreation", {})[key] = {"verdict": verdict[pid]}
            arms[pid] = "CONTROL" if pid.startswith("k") else "CANDIDATE"
        ab = L.ab_report(state, plans, arms, {"registeredAt": T0})
        c = ab["CANDIDATE"]
        self.assertEqual((c["avoidSkipped"]["avoidedLosers"], c["avoidSkipped"]["skippedWinners"]), (1, 1))
        self.assertEqual(c["avoidSkipped"]["netBlockValueR"], -0.5)   # skipped a 1.5R winner to dodge 1R
        self.assertEqual(c["avoidIgnoredEntered"]["n"], 1)
        self.assertEqual(c["entered"]["n"], 3)
        for k in ("expectancyR", "pf", "winRate", "avgWinR", "avgLossR", "maxDrawdownR"):
            self.assertIn(k, c["entered"])
        self.assertIn("upliftVsComparableR", c["preferVsComparable"])
        self.assertEqual(ab["CONTROL"]["avoidIgnoredEntered"]["n"], 2)
        self.assertTrue(ab["verdict"].startswith("UNPROVEN"))


class ExperimentIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.now = T0
        self.book = ExperimentBook(self.root, "test_policy_hash", now=lambda: self.now)
        self.study = self.book.register_learner_study("Hermes learner continuous A/B for testing")

    def strong_avoid(self, plan_wrapper):
        state = L.empty_state()
        state["lessons"]["S"] = {"id": "S", "patternKey": "setupType=REVERSAL", "direction": "AVOID",
                                 "status": "STRONG", "description": "setup=REVERSAL", "evidence": {}, "lastUpdated": T0}
        state["contexts"][L.plan_key(plan_wrapper)] = {"setupType": "REVERSAL", "side": "LONG", "regime": "RANGE"}
        L.save_state(self.root, state)

    def cycle_with(self, arm):
        for _ in range(8):
            self.now += 300000
            a = self.book.start_cycle()
            if a["arm"] == arm:
                return a
        self.fail("arm never assigned")

    def test_strong_avoid_blocks_candidate_not_control(self):
        self.cycle_with("CANDIDATE")
        w = {"plan": plan("c1"), "createdAt": self.now}
        self.book.bind_plan(w)
        self.strong_avoid(w)
        with self.assertRaisesRegex(ValueError, "HERMES_LESSON_BLOCK"):
            self.book.check_entry(w)
        self.cycle_with("CONTROL")
        w2 = {"plan": plan("k1"), "createdAt": self.now}
        self.book.bind_plan(w2)
        self.strong_avoid(w2)
        self.book.check_entry(w2)

    def test_learner_study_is_never_sealed_or_judged_by_the_30_day_screen(self):
        self.now += 40 * DAY
        self.book.state["evidence"] = {"at": self.now, "closed": [], "excludedClosedN": 0, "noFillIds": [], "lastError": None}
        self.assertIn(self.book.start_cycle()["arm"], ("CANDIDATE", "CONTROL"))
        self.assertIsNone(self.study["phases"][-1]["sealedAt"])

    def test_unreadable_learner_state_blocks_nothing(self):
        (self.root / "hermes-home" / L.STATE_NAME).write_text("{not json")
        self.cycle_with("CANDIDATE")
        w = {"plan": plan("c2"), "createdAt": self.now}
        self.book.bind_plan(w)
        self.book.check_entry(w)

    def test_arms_are_labelled_for_the_ab_report(self):
        self.cycle_with("CANDIDATE")
        self.book.bind_plan({"plan": plan("c3"), "createdAt": self.now})
        self.cycle_with("CONTROL")
        self.book.bind_plan({"plan": plan("k3"), "createdAt": self.now})
        arms, study = L.load_arms(self.root)
        self.assertEqual((arms["c3"], arms["k3"]), ("CANDIDATE", "CONTROL"))


if __name__ == "__main__":
    unittest.main()
