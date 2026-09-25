"""Focused host evidence invariants. Pure fixtures; optional historical read-only audit.

Run: python3 -B -m unittest -v test_astra_canonical_v8
No runtime calls, writes, temporary journals, network, SSH, or exchange orders.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest import mock
import types

from astra_canonical_v8 import (
    AXES, CanonicalBook, LEGACY, PROCEDURAL_CHECKS, UNKNOWN, V8, VERSIONS,
    canonical_evidence, cohort_metrics, predicate,
)

TAGS = {"executionPolicyVersion": "gateway-exact-v8-sha", "tradePolicyVersion": "trade-management-v7-20260908",
        "decisionVersion": "fast-decision-v8-sha", "cohort": V8, "fingerprint": "frozen-testnet-fingerprint"}


def fixture(tid="trade-1", profit=-3, side="LONG"):
    did = "decision-" + tid
    entry_id, exit_id = "entry-" + tid, "exit-" + tid
    fills = [
        {"tradeId": tid + "-f1", "orderId": entry_id, "qty": 1, "price": 100,
         "time": 210, "realizedPnl": 0, "commission": .1, "commissionAsset": "USDT"},
        {"tradeId": tid + "-f2", "orderId": entry_id, "qty": 2, "price": 103,
         "time": 220, "realizedPnl": 0, "commission": .206, "commissionAsset": "USDT"},
        {"tradeId": tid + "-f3", "orderId": exit_id, "qty": 3, "price": 101,
         "time": 300, "realizedPnl": profit, "commission": .303, "commissionAsset": "USDT"},
    ]
    t = {"id": tid, "symbol": "TESTUSDT", "side": side, "state": "CLOSED", "qty": 0,
         "entryQty": 3, "entryPrice": 102, "stopPrice": 95, "targetPrice": 110,
         "createdAt": 200, "closedAt": 310, "settlementComplete": True, "error": None,
         "entry": {"attemptedAt": 200, "order": {"orderId": entry_id, "executedQty": 3,
                   "avgPrice": 102, "status": "FILLED", "updateTime": 220}},
         "exits": [{"order": {"orderId": exit_id}}], "fills": fills,
         "decision": {"id": did, "action": "OPEN", "entryPrice": 999, "stopPrice": 999},
         "book": {"bid": 101.9, "ask": 102, "time": 195}}
    r = {"id": tid, "symbol": "TESTUSDT", "side": side, "state": "CLOSED", "settled": True,
         "accountingComplete": True, "remainingQty": 0, "entryQty": 3, "entryPrice": 102,
         "entryNotional": 306, "openedAt": 210, "closedAt": 310,
         "gross": profit, "fees": .609, "funding": .1, "net": profit - .609 + .1,
         "stopPrice": 95, "targetPrice": 110, "exitReason": "MANAGEMENT_CLOSE"}
    report = {"environment": "testnet", "laneId": "ASTRA_HERMES_TESTNET", "source": "OWNED_ASTRA_LEDGER",
              "generatedAt": 1000, "fundingThrough": 1000, "lastError": None, "closed": [r], "noFill": [], "open": []}
    status = {"environment": "testnet", "laneId": "ASTRA_HERMES_TESTNET", "fundingThrough": 1000,
              "lastError": None, "closed": [t], "active": [],
              "decisions": [{"at": 190, "decision": t["decision"], "result": {"state": "CLOSED"}}]}
    plan = {"createdAt": 100, "submissionId": did,
            "plan": {"id": "plan-" + tid, "symbol": "TESTUSDT", "side": side,
                     "entryMin": 101, "entryMax": 103, "maxSpreadBps": 10, "triggerPrice": 100},
            "decisionQuote": {"decisionId": did, "at": 180, "bid": 101, "ask": 101}}
    return report, status, {"version": 1, "lessons": []}, plan


def adapt(parts, tags=TAGS):
    report, status, legacy, plan = parts
    return canonical_evidence(report, status, legacy, plans=[plan],
                              bindings={status["closed"][0]["id"]: tags},
                              post_fix_execution_versions=(TAGS["executionPolicyVersion"],))[0]


def context(**changes):
    return {**TAGS, "side": "LONG", "symbol": "TESTUSDT", "phase": "ENTRY",
            "evaluatingAction": "ENTER_LONG", "action": "NO_TRADE",
            "executableQuote": 102, "entryMin": 101, "entryMax": 103, **changes}


BODY = {"observedMechanism": "Observed actual fills within the frozen entry band.",
        "requiredAction": "Check the current executable quote against the frozen band.",
        "exceptions": "No lesson overrides the existing active policy or protection."}
CONDITION = {"op": "eq", "field": "phase", "value": "ENTRY"}
CHECK = {"predicate": PROCEDURAL_CHECKS[0], "passActions": ["ENTER_LONG", "NO_TRADE"], "failActions": ["NO_TRADE"]}
SUPPORT = {"op": "eq", "field": "entryBandViolation", "value": False}


def prepared_book(legacy=False):
    book = CanonicalBook()
    rows = []
    for i in range(3):
        f = fixture("case-" + str(i))
        if legacy:
            f[2]["lessons"].append({"id": "old-" + str(i), "review": {"tradeId": f[1]["closed"][0]["id"]}})
        rows.append(adapt(f))
    book.ingest(rows, {"lessons": []})
    return book, rows


def publish(book, rows, identifier="band-check", **kwargs):
    args = {"lesson_id": identifier, "body": BODY, "evidence_ids": [r["evidenceId"] for r in rows],
            "scope": {"side": "LONG", "action": "ENTER_LONG"}, "condition": CONDITION,
            "check": CHECK, "support": SUPPORT, "error_type": "ENTRY_BOUNDARY_VIOLATION"}
    args.update(kwargs)
    return book.publish(**args)


class CanonicalEvidenceTests(unittest.TestCase):
    def test_actual_weighted_fill_fees_funding_and_no_planned_substitution(self):
        f = fixture()
        before = copy.deepcopy(f)
        r = adapt(f)
        self.assertEqual(f, before)
        self.assertTrue(r["eligible"])
        self.assertEqual((r["executedQty"], r["averageFillPrice"]), (3, 102))
        self.assertAlmostEqual(r["fees"], .609)
        self.assertAlmostEqual(r["funding"], .1)
        self.assertAlmostEqual(r["net"], -3.509)
        self.assertEqual((r["actualStopPrice"], r["actualTargetPrice"]), (95, 110))
        self.assertEqual((r["decisionAt"], r["orderSubmittedAt"], r["orderFilledAt"]), (190, 200, 210))
        self.assertEqual(r["outcomeClassification"], "INSUFFICIENT_EVIDENCE")
        self.assertTrue(r["provenance"]["settlementChecksPassed"])

    def test_missing_actual_is_unknown_even_if_plan_and_report_claim_it(self):
        f = fixture()
        f[1]["closed"][0].pop("fills")
        r = adapt(f)
        self.assertFalse(r["eligible"])
        for key in ("net", "executedQty", "averageFillPrice", "actualStopPrice", "actualTargetPrice", "entryBoundaryViolation"):
            self.assertEqual(r[key], UNKNOWN, key)

    def test_zero_avg_ack_uses_real_fills_but_no_fills_cannot_use_ack(self):
        f = fixture()
        f[1]["closed"][0]["entry"]["order"]["avgPrice"] = 0
        self.assertEqual(adapt(f)["averageFillPrice"], 102)
        f[1]["closed"][0]["fills"] = []
        self.assertEqual(adapt(f)["averageFillPrice"], UNKNOWN)

    def test_no_guessed_versions_or_current_report_defaults(self):
        f = fixture()
        f[0].update(TAGS)
        f[1].update(TAGS)
        r = adapt(f, tags={})
        for key in VERSIONS:
            self.assertEqual(r[key], UNKNOWN)
        self.assertEqual(r["executionClass"], "LEGACY_EXECUTION")
        f[1]["closed"][0]["executionPolicyVersion"] = "conflicting-exact-tag"
        self.assertEqual(adapt(f)["executionPolicyVersion"], UNKNOWN)

    def test_legacy_always_legacy_even_if_given_current_tags(self):
        f = fixture()
        f[2]["lessons"] = [{"id": "old", "review": {"tradeId": "trade-1"}}]
        r = adapt(f)
        self.assertEqual((r["executionClass"], r["cohort"]), ("LEGACY_EXECUTION", LEGACY))

    def test_settlement_adversarial_mutations(self):
        # Each mutation removes an independent required observation, while keeping
        # attractive model/report labels unchanged. None may enter settled PnL.
        mutations = [
            lambda f: f[0]["closed"][0].update(settled=False),
            lambda f: f[0]["closed"][0].update(accountingComplete=False),
            lambda f: f[0]["closed"][0].update(net=100),
            lambda f: f[0]["closed"][0].update(fees=-1),
            lambda f: f[0]["closed"][0].update(fees=0, net=-2.9),
            lambda f: f[0]["closed"][0].update(funding=None),
            lambda f: f[0]["closed"][0].update(entryQty=4),
            lambda f: f[0]["closed"][0].update(entryPrice=999),
            lambda f: f[0]["closed"][0].update(entryNotional=999),
            lambda f: f[0]["closed"][0].update(remainingQty=.1),
            lambda f: f[0]["closed"][0].update(closedAt=299),
            lambda f: f[0].update(fundingThrough=309),
            lambda f: f[1].update(fundingThrough=309),
            lambda f: f[1].update(lastError="reconciliation failed"),
            lambda f: f[1]["closed"][0].update(settlementComplete=False),
            lambda f: f[1]["closed"][0].update(state="SETTLING"),
            lambda f: f[1]["closed"][0].update(qty=.1),
            lambda f: f[1]["closed"][0]["entry"]["order"].update(executedQty=4),
            lambda f: f[1]["closed"][0]["entry"]["order"].update(avgPrice=999),
            lambda f: f[1]["closed"][0]["fills"][0].update(qty=True),
            lambda f: f[1]["closed"][0]["fills"][0].update(price="100"),
            lambda f: f[1]["closed"][0]["fills"][0].update(commissionAsset="BNB"),
            lambda f: f[1]["closed"][0]["fills"][0].update(commission=None),
            lambda f: f[1]["closed"][0]["fills"][2].update(qty=2),
            lambda f: f[1]["closed"][0]["fills"].append(copy.deepcopy(f[1]["closed"][0]["fills"][0])),
        ]
        for i, mutation in enumerate(mutations):
            with self.subTest(mutation=i):
                f = fixture()
                mutation(f)
                r = adapt(f)
                self.assertFalse(r["eligible"])
                self.assertEqual(r["net"], UNKNOWN)

    def test_wrong_identity_rejected(self):
        for index in (0, 1):
            f = fixture()
            f[index]["environment"] = "live"
            with self.assertRaises(ValueError):
                adapt(f)

    def test_cross_trade_fill_reuse_rejected(self):
        f = fixture()
        duplicate = copy.deepcopy(f[1]['closed'][0])
        duplicate['id'] = 'duplicate-owner'
        f[1]['closed'].append(duplicate)
        with self.assertRaises(ValueError):
            adapt(f)

    def test_price_and_spread_violations_independent_of_profit(self):
        for profit in (5, -5):
            for mode in ("price", "spread"):
                with self.subTest(profit=profit, mode=mode):
                    f = fixture(profit=profit)
                    if mode == "price":
                        f[3]["plan"]["entryMax"] = 101.9
                    else:
                        f[1]["closed"][0]["book"]["bid"] = 101
                    r = adapt(f)
                    self.assertTrue(r["entryBoundaryViolation"])
                    self.assertEqual(r["entryBandViolation"], mode == "price")
                    self.assertEqual(r["entrySpreadViolation"], mode == "spread")
                    self.assertEqual(r["outcomeClassification"], "BAD_PROCESS_GOOD_OUTCOME" if profit > 0 else "BAD_PROCESS_BAD_OUTCOME")
                    self.assertIn("planHash", r["boundaryProvenance"])

    def test_boundary_provenance_mutations_never_invent_violation(self):
        for mutation in (
            lambda f: f[3].update(createdAt=201),
            lambda f: f[3].update(submissionId="other-decision"),
            lambda f: f[3]["plan"].update(symbol="OTHERUSDT"),
            lambda f: f[3]["plan"].update(side="SHORT"),
            lambda f: f[3]["plan"].update(entryMin=None),
        ):
            f = fixture()
            f[3]["plan"]["entryMax"] = 101.9
            mutation(f)
            r = adapt(f)
            self.assertEqual(r["entryBoundaryViolation"], UNKNOWN)
        f = fixture()
        f[1]["closed"][0]["book"].update(bid=101, time=9999)
        self.assertEqual(adapt(f)["entrySpreadViolation"], UNKNOWN)

    def test_side_aware_drift_and_gap(self):
        long = adapt(fixture())
        short = adapt(fixture(side="SHORT"))
        self.assertAlmostEqual(long["adverseDisplacementBps"], 200)
        self.assertAlmostEqual(short["adverseDisplacementBps"], -200)
        self.assertAlmostEqual(long["marketDriftBps"], 100)
        self.assertAlmostEqual(long["executionGapBps"], (102 / 101 - 1) * 10000)

    def test_confirmed_no_fill_requires_terminal_exchange_zero(self):
        f = fixture()
        t, r = f[1]["closed"][0], f[0]["closed"][0]
        t.update(state="NO_FILL", entryQty=0, fills=[], settlementComplete=False)
        t["entry"]["order"].update(executedQty=0, status="EXPIRED", avgPrice=0)
        r.update(state="NO_FILL", settled=False, entryQty=0, gross=0, fees=0, funding=0, net=0)
        f[0]["noFill"] = f[0].pop("closed")
        row = adapt(f)
        self.assertEqual((row["outcome"], row["net"]), ("NO_FILL_CONFIRMED", 0))
        for change in ({"executedQty": None}, {"executedQty": .1}, {"status": "NEW"}):
            mutated = copy.deepcopy(f)
            mutated[1]["closed"][0]["entry"]["order"].update(change)
            self.assertFalse(adapt(mutated)["eligible"])

    def test_nontrade_zero_requires_host_receipt_not_action_or_error_string(self):
        f = fixture()
        receipt = {"id": "skip", "action": "NO_TRADE", "outcome": "VALID_NO_TRADE", "at": 100,
                   "validated": True, "noOrderConfirmed": True, "pending": False}
        for field in (None, "validated", "noOrderConfirmed", "pending"):
            d = copy.deepcopy(receipt)
            if field:
                del d[field]
            rows = canonical_evidence(*f[:3], decisions=[d])
            r = next(x for x in rows if x["kind"] == "DECISION")
            self.assertEqual(r["net"], 0 if field is None else UNKNOWN)
        receipt.update(outcome="REJECTED_BY_POLICY", action="ENTER_LONG", pending=True)
        r = canonical_evidence(*f[:3], decisions=[receipt])[-1]
        self.assertEqual(r["net"], UNKNOWN)

    def test_a_decision_in_both_sources_is_one_record_not_a_conflict(self):
        """The lane receipt is a fallback for a decision the host has no record of.
        Appending it beside the host's own row put two rows with the same id into the
        index, and `_index` refused them — raising on every tick that reached coaching."""
        f = fixture()
        did = "astra-v8-fast-1-batch-notrade"
        f[1]["decisions"] = [{"at": 190, "decision": {"id": did, "action": "WAIT",
                                                      "reasonCode": "NO_SETUP"},
                              "result": {"status": "WAIT_RECORDED"}}]
        host = {"id": did, "action": "NO_TRADE", "outcome": "VALID_NO_TRADE", "at": 100,
                "validated": True, "noOrderConfirmed": True, "pending": False}
        rows = canonical_evidence(*f[:3], decisions=[host])  # must not raise
        matching = [r for r in rows if r.get("decisionId") == did]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]["net"], 0)

    def test_the_lane_receipt_still_stands_in_when_the_host_has_none(self):
        """Removing the duplicate must not remove the fallback it was there to provide."""
        f = fixture()
        did = "lane-only-notrade"
        f[1]["decisions"] = [{"at": 190, "decision": {"id": did, "action": "WAIT",
                                                      "reasonCode": "NO_SETUP"},
                              "result": {"status": "WAIT_RECORDED"}}]
        rows = canonical_evidence(*f[:3], decisions=[])
        self.assertEqual([r["net"] for r in rows if r.get("decisionId") == did], [0])

    def test_full_wait_receipt_supported_but_report_only_wait_is_not(self):
        f = fixture()
        f[0]["decisions"] = [{"id": "fake", "action": "WAIT", "result": "WAIT_RECORDED"}]
        self.assertEqual(len(canonical_evidence(*f[:3])), 1)
        f[1]["decisions"].append({"at": 999, "decision": {"id": "real", "action": "WAIT", "reasonCode": "NO_SETUP"},
                                  "result": {"status": "WAIT_RECORDED"}})
        self.assertEqual(canonical_evidence(*f[:3])[-1]["net"], 0)


class OverlayAndProcedureTests(unittest.TestCase):
    def test_legacy_assessment_contradiction_and_sources_immutable(self):
        f = fixture(profit=5)
        f[3]["plan"]["entryMax"] = 101.9
        lesson = {"id": "legacy-lesson", "review": {"tradeId": "trade-1", "assessment": "GOOD_PROCESS_BAD_OUTCOME"}}
        f[2]["lessons"] = [lesson]
        before = copy.deepcopy(f[2])
        book = CanonicalBook()
        audit = book.ingest([adapt(f)], f[2])["legacy-lesson"]
        self.assertEqual(audit["status"], "CONTRADICTED")
        self.assertFalse(audit["primaryEligible"])
        self.assertEqual(f[2], before)
        saved = book.export()
        book.ingest([adapt(f)], f[2])
        self.assertEqual(book.export(), saved)
        lesson["review"]["assessment"] = "CHANGED"
        with self.assertRaises(ValueError):
            book.ingest([], f[2])
        self.assertEqual(book.export(), saved)

    def test_append_restore_detached_snapshots_and_tamper_rejection(self):
        book, rows = prepared_book()
        p = publish(book, rows)
        before = book.export()
        p["body"]["requiredAction"] = "mutated"
        self.assertEqual(book.export(), before)
        book.retire("band-check", "New contradictory evidence under review")
        after = book.export()
        self.assertEqual(after[:len(before)], before)
        self.assertEqual(CanonicalBook(after).export(), after)
        after[0]["payload"]["net"] = 999
        with self.assertRaises(ValueError):
            CanonicalBook(after)

    def test_exact_version_and_cohort_match_plus_legacy_not_primary(self):
        book, rows = prepared_book()
        publish(book, rows)
        self.assertEqual(len(book.deliver("current", context())["procedures"]), 1)
        for key in (*VERSIONS, "cohort", "fingerprint"):
            self.assertEqual(book.deliver("wrong-" + key, context(**{key: "other"}))["procedures"], [])
        old, old_rows = prepared_book(legacy=True)
        publish(old, old_rows)
        self.assertEqual(old.deliver("primary", context())["procedures"], [])
        self.assertEqual(len(old.deliver("fallback", context(), include_legacy=True)["procedures"]), 1)

    def test_three_max_relevant_supported_and_filter_before_slice(self):
        book, rows = prepared_book()
        for i in range(5):
            publish(book, rows, "lesson-" + str(i))
        publish(book, rows, "irrelevant", scope={"side": "SHORT"}, check={**CHECK, "passActions": ["ENTER_SHORT", "NO_TRADE"]})
        publish(book, rows[:1], "one-winning-or-losing-trade")
        d = book.deliver("all", context())
        self.assertEqual(len(d["procedures"]), 3)
        self.assertNotIn("irrelevant", [p["lessonId"] for p in d["procedures"]])
        self.assertEqual(book.deliver("irrelevant-only", context(), allowed_lesson_ids=["irrelevant"])["procedures"], [])
        self.assertNotIn("one-winning-or-losing-trade", [p["lessonId"] for p in d["procedures"]])
        d = book.deliver("filtered", context(), allowed_lesson_ids=["lesson-4"])
        self.assertEqual([p["lessonId"] for p in d["procedures"]], ["lesson-4"])
        self.assertEqual(book.deliver("empty", context(), allowed_lesson_ids=[])["procedures"], [])
        with self.assertRaises(ValueError):
            book.deliver("filtered", context(), allowed_lesson_ids=["lesson-3"])

    def test_no_trade_long_is_applicable_and_action_consistency_checked(self):
        book, rows = prepared_book()
        publish(book, rows)
        for name, quote, action, expected in (
            ("valid-enter", 102, "ENTER_LONG", "COMPLIANT"),
            ("declined-long", 104, "NO_TRADE", "COMPLIANT"),
            ("bad-enter", 104, "ENTER_LONG", "DEPARTED"),
        ):
            book.deliver(name, context(executableQuote=quote))
            book.run_checks(name)
            r = book.verify(name, action, claimed_applied=["band-check"])
            self.assertEqual(r["applicableLessonIds"], ["band-check"])
            self.assertEqual(r["results"]["band-check"]["application"], expected)

    def test_self_attestation_missing_check_unknown_input_irrelevant_claim(self):
        book, rows = prepared_book()
        publish(book, rows)
        book.deliver("no-check", context())
        r = book.verify("no-check", "ENTER_LONG", claimed_applied=["band-check", "invented"])
        self.assertEqual(r["appliedLessonIds"], [])
        self.assertEqual(r["unverifiedClaims"], ["band-check", "invented"])
        with self.assertRaises(ValueError):
            book.run_checks("no-check")
        book.deliver("missing", context(executableQuote=UNKNOWN))
        receipt = book.run_checks("missing")
        receipt["checks"]["band-check"]["result"] = True  # caller mutation is not host execution
        r = book.verify("missing", "ENTER_LONG", claimed_applied=["band-check"])
        self.assertEqual(r["results"]["band-check"]["application"], "UNVERIFIABLE")
        book.deliver("short", context(side="SHORT", evaluatingAction="ENTER_SHORT"))
        r = book.verify("short", "NO_TRADE", claimed_applied=["band-check"])
        self.assertEqual(r["appliedLessonIds"], [])

    def test_replay_is_idempotent_and_conflicting_action_rejected(self):
        book, rows = prepared_book()
        publish(book, rows)
        book.deliver("d", context())
        book.run_checks("d")
        result = book.verify("d", "NO_TRADE")
        saved = book.export()
        restored = CanonicalBook(saved)
        self.assertEqual(restored.verify("d", "NO_TRADE"), result)
        self.assertEqual(restored.export(), saved)
        with self.assertRaises(ValueError):
            restored.verify("d", "ENTER_LONG")

    def test_retirement_or_new_contradiction_blocks_previously_supported(self):
        for mode in ("retirement", "new-evidence"):
            book, rows = prepared_book()
            publish(book, rows)
            book.deliver("d", context())
            book.run_checks("d")
            if mode == "retirement":
                book.retire("band-check", "Host found contradictory procedural evidence")
            else:
                f = fixture("case-0")
                f[3]["plan"]["entryMax"] = 101.9
                book.ingest([adapt(f)], {"lessons": []})
            self.assertEqual(book.deliver("next", context())["procedures"], [])
            self.assertEqual(book.verify("d", "ENTER_LONG")["appliedLessonIds"], [])

    def test_winner_cannot_promote_bad_process_and_alpha_rules_refused(self):
        book = CanonicalBook()
        rows = []
        for i in range(3):
            f = fixture("winner-" + str(i), profit=10)
            f[3]["plan"]["entryMax"] = 101.9
            rows.append(adapt(f))
        book.ingest(rows, {"lessons": []})
        self.assertEqual(publish(book, rows)["status"], "CONTRADICTED")
        for support in ({"op": "gte", "field": "net", "value": 0}, {"op": "lte", "field": "RSI", "value": 30}):
            with self.assertRaises(ValueError):
                publish(book, rows, support=support)
        with self.assertRaises(ValueError):
            publish(book, rows, check={**CHECK, "predicate": {"op": "lte", "field": "spreadBps", "value": 999}})
        with self.assertRaises(ValueError):
            publish(book, rows, check={**CHECK, "failActions": ["ENTER_LONG"]})

    def test_fast_branch_import_preserves_original_context_after_coaching_advances(self):
        book, rows = prepared_book()
        publish(book, rows)
        base = book.export()
        fast = CanonicalBook(base)
        fast.deliver('fast-d', context())
        fast.run_checks('fast-d')
        verified = fast.verify('fast-d', 'NO_TRADE')
        events = fast.export()[len(base):]
        book.retire('band-check', 'New coaching interpretation after original action')
        before = book.export()
        self.assertEqual(book.ingest_applications(base, events), 3)
        self.assertEqual(book.export()[:len(before)], before)
        imported = next(e['payload'] for e in book.export() if e['kind'] == 'APPLICATION')
        self.assertEqual(imported, verified)
        saved = book.export()
        book.ingest_applications(base, events)
        self.assertEqual(book.export(), saved)
        self.assertEqual(book.deliver('next', context())['procedures'], [])

    def test_fast_import_tampering_or_unknown_base_rejected_atomically(self):
        book, rows = prepared_book()
        publish(book, rows)
        base = book.export()
        fast = CanonicalBook(base)
        fast.deliver('fast-d', context(executableQuote=104))
        fast.run_checks('fast-d')
        fast.verify('fast-d', 'ENTER_LONG', claimed_applied=['band-check'])
        events = fast.export()[len(base):]
        before = book.export()
        events[-1]['payload']['appliedLessonIds'] = ['band-check']
        with self.assertRaises(ValueError):
            book.ingest_applications(base, events)
        self.assertEqual(book.export(), before)
        with self.assertRaises(ValueError):
            book.ingest_applications(base[1:], [])

    def test_rehashed_forged_compliance_still_fails_host_replay(self):
        from astra_canonical_v8 import _hash
        book, rows = prepared_book()
        publish(book, rows)
        base = book.export()
        fast = CanonicalBook(base)
        fast.deliver('fast-d', context(executableQuote=104))
        fast.run_checks('fast-d')
        fast.verify('fast-d', 'ENTER_LONG')
        events = fast.export()[len(base):]
        events[-1]['payload']['appliedLessonIds'] = ['band-check']
        events[-1]['hash'] = _hash({k: v for k, v in events[-1].items() if k != 'hash'})
        with self.assertRaises(ValueError):
            book.ingest_applications(base, events)
        self.assertEqual(book.export(), base)

    def test_review_numeric_and_axes_cannot_be_overridden_by_model(self):
        book = CanonicalBook()
        f = fixture(profit=10)
        f[3]["plan"]["entryMax"] = 101.9
        row = adapt(f)
        book.ingest([row], {"lessons": []})
        body = {**BODY, "axes": dict.fromkeys(AXES, "Model claims everything was good."),
                "outcomeClassification": "GOOD_PROCESS_GOOD_OUTCOME"}
        r = book.review("review", row["evidenceId"], body)
        self.assertEqual(r["status"], "CONTRADICTED")
        self.assertEqual(r["outcomeClassification"], "BAD_PROCESS_GOOD_OUTCOME")
        self.assertEqual(r["reviewAxes"]["SETUP_SELECTION"], UNKNOWN)
        self.assertEqual(r["reviewAxes"]["ENTRY_DISPLACEMENT"], "BAD")
        with self.assertRaises(ValueError):
            book.review("numeric-injection", row["evidenceId"], {**body, "net": 999})

    def test_metrics_separate_policy_cohorts_and_denominators(self):
        book, rows = prepared_book()
        publish(book, rows)
        book.deliver(rows[0]["decisionId"], context())
        book.run_checks(rows[0]["decisionId"])
        app = book.verify(rows[0]["decisionId"], "NO_TRADE")
        book.deliver(rows[1]["decisionId"], context())
        unknown = book.verify(rows[1]["decisionId"], "NO_TRADE", claimed_applied=["band-check"])
        legacy = adapt(fixture("legacy"), tags={**TAGS, "cohort": LEGACY, "executionPolicyVersion": "pre-fix"})
        v7 = adapt(fixture("v7"), tags={**TAGS, "cohort": "V7_PRE_FIX", "executionPolicyVersion": "v7"})
        groups = cohort_metrics(rows + [legacy, v7], [app, unknown])
        self.assertEqual(len(groups), 3)
        v8 = next(x for x in groups if x["cohort"] == V8)
        self.assertEqual(v8["closedTradesN"], 3)
        self.assertAlmostEqual(v8["netPnl"], -3.509 * 3)
        self.assertEqual((v8["lessonApplicableN"], v8["lessonApplicationN"], v8["lessonUnverifiableN"]), (2, 1, 1))
        self.assertEqual(v8["lessonApplicationRate"], .5)
        self.assertEqual(v8["repeatErrors"]["ENTRY_BOUNDARY_VIOLATION"]["afterN"], 2)

    def test_confirmed_zero_outcomes_and_host_telemetry_stay_separate_facts(self):
        """A refusal, a decline and an unfilled order each realise zero for a
        different reason, so one bucket would hide which of them is happening.
        Latency and opportunity counts are host telemetry: absent means UNKNOWN,
        never zero, and they never leak across a cohort boundary."""
        report, status, legacy, plan = fixture()
        decisions = [{"id": "d-wait", "action": "NO_TRADE", "outcome": "VALID_NO_TRADE", "at": 400,
                      "validated": True, "noOrderConfirmed": True, "pending": False,
                      "symbol": "TESTUSDT", "side": "LONG"},
                     {"id": "d-reject", "action": "ENTER_LONG", "outcome": "REJECTED_BY_POLICY", "at": 500,
                      "validated": True, "noOrderConfirmed": True, "pending": False,
                      "symbol": "TESTUSDT", "side": "LONG"}]
        rows = canonical_evidence(report, status, legacy, plans=[plan],
                                  bindings={"trade-1": TAGS, "d-wait": TAGS, "d-reject": TAGS},
                                  decisions=decisions,
                                  post_fix_execution_versions=(TAGS["executionPolicyVersion"],))
        bare = cohort_metrics(rows)[0]
        self.assertEqual((bare["noTradesN"], bare["rejectedN"], bare["noFillN"]), (1, 1, 0))
        self.assertEqual(bare["confirmedZeroN"], 2)
        self.assertEqual((bare["entriesN"], bare["closedTradesN"]), (1, 1))
        self.assertEqual(bare["modelDecisionsN"], 3)
        # Displacement is measured on the actual fill against the frozen trigger only.
        self.assertAlmostEqual(bare["entryDisplacementBpsMedian"], (102 / 100 - 1) * 10000)
        self.assertEqual(bare["opportunitiesN"], UNKNOWN)
        self.assertEqual((bare["decisionLatencyN"], bare["modelDecisionLatencyMsMedian"]), (0, UNKNOWN))

        stamps = [{**TAGS, "decisionId": "d-wait", "hostContextLatency": 800,
                   "modelDecisionLatency": 40000, "totalEventToSubmitLatency": 41000},
                  {**TAGS, "decisionId": "d-reject", "hostContextLatency": 1200,
                   "modelDecisionLatency": 60000, "totalEventToSubmitLatency": 62000},
                  {**TAGS, "cohort": LEGACY, "decisionId": "d-old", "modelDecisionLatency": 240000}]
        chances = [{**TAGS, "opportunityId": "o1"}, {**TAGS, "opportunityId": "o2"}]
        groups = {g["cohort"]: g for g in cohort_metrics(rows, latency=stamps, opportunities=chances)}
        v8 = groups[V8]
        self.assertEqual((v8["decisionLatencyN"], v8["opportunitiesN"]), (2, 2))
        self.assertEqual(v8["modelDecisionLatencyMsMedian"], 50000)
        self.assertEqual(v8["hostContextLatencyMsMedian"], 1000)
        self.assertEqual(v8["totalEventToSubmitLatencyMsMedian"], 51500)
        # The slow legacy session must not be averaged into the post-fix cohort.
        self.assertEqual(groups[LEGACY]["modelDecisionLatencyMsMedian"], 240000)
        self.assertEqual(groups[LEGACY]["closedTradesN"], 0)

    def test_predicate_unknown_never_truthy_or_boolean_numeric(self):
        for value in (None, UNKNOWN, True, float("inf"), "102"):
            self.assertEqual(predicate(PROCEDURAL_CHECKS[0], context(executableQuote=value)), UNKNOWN)
        self.assertIs(predicate({"op": "eq", "field": "n", "value": False}, {"n": 0}), False)


HISTORICAL_DIR = "kronos-astra-trade-audit-20260909.fSu3hs"


def historical_paths():
    """Resolve the read-only historical evidence wherever this checkout is mounted.

    An absolute developer path silently skips the audit on every other host, which
    hides the one test that reads the real 13 trades. Try the environment override,
    then the sibling directory of this release, then the original Mac location.
    """
    roots = []
    if os.environ.get("ASTRA_HISTORICAL_EVIDENCE_DIR"):
        roots.append(Path(os.environ["ASTRA_HISTORICAL_EVIDENCE_DIR"]))
    roots.append(Path(__file__).resolve().parent.parent / HISTORICAL_DIR)
    roots.append(Path("/Users/erwin/Projects") / HISTORICAL_DIR)
    for root in roots:
        paths = [root / "snapshot.json", root / "astra-learning.json", root / "astra-plans.json"]
        if all(p.exists() for p in paths):
            return paths
    return None


class HistoricalReadOnlyTests(unittest.TestCase):
    def test_actual_13_preserved_four_verified_violations_two_corrected_claims(self):
        paths = historical_paths()
        if paths is None:
            self.skipTest("Optional historical host evidence not present on this machine")
        before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
        snapshot, legacy, plans = [json.loads(p.read_text()) for p in paths]
        rows = canonical_evidence(snapshot['report'], snapshot['status'], legacy, plans=plans['plans'])
        rows = [r for r in rows if r['kind'] == 'TRADE']
        self.assertEqual(len(rows), 13)
        self.assertTrue(all(r['eligible'] for r in rows))
        self.assertTrue(all(r['executionClass'] == 'LEGACY_EXECUTION' for r in rows))
        breaches = {r['evidenceId'] for r in rows if r['entryBoundaryViolation'] is True}
        self.assertEqual(breaches, {'astra-7ee66c5abf6ae70d01b7be', 'astra-5286f2bfc320c2eb8803ac',
                                   'astra-af0a5c872faa70cc7270de', 'astra-1ffcbd984d08cbabdc451e'})
        self.assertEqual(sum(r['entryBandViolation'] is True for r in rows), 2)
        self.assertEqual(sum(r['entrySpreadViolation'] is True for r in rows), 2)
        self.assertEqual(sum(r['entryBoundaryViolation'] == UNKNOWN for r in rows), 1)
        book = CanonicalBook()
        audits = book.ingest(rows, legacy)
        self.assertEqual(len(audits), 13)
        self.assertEqual(sum(a['status'] == 'CONTRADICTED' for a in audits.values()), 2)
        self.assertEqual(book.deliver('current', context())['procedures'], [])
        self.assertEqual([hashlib.sha256(p.read_bytes()).hexdigest() for p in paths], before)
        scoped = Path(__file__).with_name('preflight-snapshot.json')
        if scoped.exists():
            s = json.loads(scoped.read_text())
            projected = canonical_evidence(s['report'], s['status'], legacy, plans=plans['plans'])
            self.assertEqual({r['evidenceId']: (r['net'], r['entryBoundaryViolation']) for r in projected},
                             {r['evidenceId']: (r['net'], r['entryBoundaryViolation']) for r in rows})


class MutationGuardTests(unittest.TestCase):
    def test_in_memory_code_mutants_are_killed_by_behavioral_assertions(self):
        source = Path(__file__).with_name('astra_canonical_v8.py').read_text()
        mutants = (
            ('accounting', 'and r.get("accountingComplete") is True and _same', 'and _same',
             CanonicalEvidenceTests, 'test_settlement_adversarial_mutations'),
            ('fees', 'and _same(fill["fees"], r.get("fees"))', '',
             CanonicalEvidenceTests, 'test_settlement_adversarial_mutations'),
            ('relevance', 'or not scope_holds(p["scope"], context)', '',
             OverlayAndProcedureTests, 'test_three_max_relevant_supported_and_filter_before_slice'),
            ('limit', '"procedures": candidates[:3]', '"procedures": candidates[:30]',
             OverlayAndProcedureTests, 'test_three_max_relevant_supported_and_filter_before_slice'),
            ('cohort', 'or (not legacy and _partition(p) != _partition(context))', '',
             OverlayAndProcedureTests, 'test_exact_version_and_cohort_match_plus_legacy_not_primary'),
            ('attestation', 'elif condition != True or type(performed) is not bool:', 'elif False:',
             OverlayAndProcedureTests, 'test_self_attestation_missing_check_unknown_input_irrelevant_claim'),
        )
        for name, old, new, case, method in mutants:
            with self.subTest(mutant=name):
                self.assertIn(old, source)
                mutated = types.ModuleType('canonical_mutant_' + name)
                exec(compile(source.replace(old, new, 1), '<in-memory-mutant>', 'exec'), mutated.__dict__)
                symbols = {key: getattr(mutated, key) for key in ('canonical_evidence', 'CanonicalBook', 'cohort_metrics', 'predicate')}
                result = unittest.TestResult()
                with mock.patch.dict(globals(), symbols):
                    case(method).run(result)
                self.assertGreater(len(result.failures), 0, name + ' escaped behavioral assertions')
                self.assertEqual(len(result.errors), 0, name + ' only crashed instead of testing behavior')


if __name__ == '__main__':
    unittest.main()
