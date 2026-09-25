"""Map the fifteen required V8 tests to real test ids, run them, and report.

Prose claiming a requirement is covered is not evidence. This resolves each
requirement to named tests, fails if a name no longer exists (a renamed or deleted
test is a silent hole), runs exactly those tests, and prints one line per
requirement. It runs no runtime, opens no gateway and places no order.
"""
import argparse
import json
import unittest
from pathlib import Path

REQUIREMENTS = {
    "1. FAST context excludes full journal/universe": [
        "test_astra_fast_v8.ContextTests.test_selected_projection_drops_universe_journal_and_nested_payloads",
        "test_astra_v8_runner.WorkerTests.test_full_journal_or_nested_memory_rejected_before_model",
        "test_astra_v8_runner.WorkerTests.test_context_is_host_bounded_and_does_not_fetch_again"],
    "2. Coaching manages nothing and borrows no trading budget": [
        "test_astra_fast_v8.GuardTests.test_coaching_cannot_manage_order_position_plan_or_borrow_fast_budget",
        "test_astra_v8_runner.WorkerTests.test_coaching_blocks_every_trading_tool_without_gateway",
        "test_astra_v8_runner.WorkerTests.test_independent_modes_have_distinct_sessions_journals_and_budgets"],
    "3. Unchanged setup does not call the model again": [
        "test_astra_fast_v8.EventTests.test_unchanged_setup_and_quote_noise_do_not_call",
        "test_astra_v8_runner.WorkerTests.test_duplicate_job_and_same_event_new_job_do_not_call_model"],
    "4. Material position event calls Astra": [
        "test_astra_fast_v8.EventTests.test_confirmed_entry_only_actual_positive_open_position",
        "test_astra_fast_v8.EventTests.test_target_crossing_uses_exit_side_and_five_second_freshness",
        "test_astra_fast_v8.EventTests.test_max_hold_uses_existing_created_at_and_no_earlier_milestone"],
    "5. Slow/unavailable model never blocks native protection": [
        "test_astra_v8_runner.WorkerTests.test_slow_model_does_not_hold_incumbent_tool_protection_lock",
        "test_astra_v8_supervisor.SupervisorHelpers.test_slow_model_does_not_skip_host_position_poll"],
    "6. Stale action is refused or revalidated, never executed blind": [
        "test_astra_fast_v8.ActionTests.test_stale_timestamp_or_host_state_mutations_rejected",
        "test_astra_v8_runner.WorkerTests.test_missing_or_mutated_stop_rejects_stale_management",
        "test_astra_v8_runner.WorkerTests.test_changed_owned_quantity_rejects_management_before_gateway_request"],
    "7. Provider/turn exhaustion is not WAIT or HOLD": [
        "test_astra_fast_v8.ActionTests.test_provider_timeout_and_turn_exhaustion_never_become_hold",
        "test_astra_v8_runner.WorkerTests.test_provider_and_budget_failure_never_become_hold",
        "test_astra_v8_runner.WorkerTests.test_late_model_failure_does_not_erase_actual_hold"],
    "8. Legacy or contradicted lesson cannot reach a current decision": [
        "test_astra_fast_v8.ContextTests.test_legacy_contradicted_retired_or_unreconciled_lessons_filtered",
        "test_astra_v8_runner.WorkerTests.test_contradicted_and_retired_lessons_never_delivered",
        "test_astra_canonical_v8.OverlayAndProcedureTests.test_exact_version_and_cohort_match_plus_legacy_not_primary"],
    "9. A relevant lesson can shape ENTER or NO_TRADE": [
        "test_astra_fast_v8.ContextTests.test_long_entry_lesson_relevant_before_final_no_trade",
        "test_astra_canonical_v8.OverlayAndProcedureTests.test_no_trade_long_is_applicable_and_action_consistency_checked",
        "test_astra_v8_runner.WorkerTests.test_canonical_relevant_long_lesson_verified_on_no_trade_max_three"],
    "10. An irrelevant lesson cannot be claimed as applied": [
        "test_astra_fast_v8.ContextTests.test_irrelevant_or_unknown_scope_cannot_be_claimed",
        "test_astra_canonical_v8.OverlayAndProcedureTests.test_self_attestation_missing_check_unknown_input_irrelevant_claim"],
    "11. BAD_PROCESS_GOOD_OUTCOME is never promoted by profit": [
        "test_astra_fast_v8.ContextTests.test_profitable_bad_process_never_auto_promotes",
        "test_astra_canonical_v8.OverlayAndProcedureTests.test_winner_cannot_promote_bad_process_and_alpha_rules_refused",
        "test_astra_v8_phase.PhaseTests.test_early_reviews_never_promote_or_tune"],
    "12. A valid setup can still reach a confirmed Testnet fill": [
        "test_astra_v8_runner.WorkerTests.test_fused_entry_uses_incumbent_fresh_contract_and_frozen_plan",
        "test_astra_v8_runner.WorkerTests.test_entry_no_fill_reaches_actual_engine_final_contract",
        "test_astra_fast_v8.ActionTests.test_good_entry_and_no_trade_remain_valid_intents_with_same_lesson"],
    "13. Duplicate or restart produces no duplicate action or order": [
        "test_astra_fast_v8.EventTests.test_durable_restart_and_concurrent_observers_dispatch_once",
        "test_astra_v8_runner.WorkerTests.test_uncertain_request_retries_exact_original_on_restart",
        "test_astra_v8_runner.WorkerTests.test_mutated_decision_id_cannot_replace_original_request",
        "test_astra_canonical_v8.OverlayAndProcedureTests.test_replay_is_idempotent_and_conflicting_action_rejected"],
    "14. The current cohort is never mixed with legacy": [
        "test_astra_canonical_v8.OverlayAndProcedureTests.test_metrics_separate_policy_cohorts_and_denominators",
        "test_astra_canonical_v8.CanonicalEvidenceTests.test_legacy_always_legacy_even_if_given_current_tags",
        "test_astra_v8_phase.PhaseTests.test_closed_does_not_imply_v8_membership",
        "test_astra_canonical_v8.OverlayAndProcedureTests.test_confirmed_zero_outcomes_and_host_telemetry_stay_separate_facts"],
    "15. Review uses actual fills and fees, never planned values": [
        "test_astra_canonical_v8.CanonicalEvidenceTests.test_actual_weighted_fill_fees_funding_and_no_planned_substitution",
        "test_astra_canonical_v8.CanonicalEvidenceTests.test_missing_actual_is_unknown_even_if_plan_and_report_claim_it",
        "test_astra_canonical_v8.OverlayAndProcedureTests.test_review_numeric_and_axes_cannot_be_overridden_by_model"],
    "F1. Only a declared model policy may decide, and identity is recorded": [
        "test_astra_fallback_v8.PolicyDeclarationTests.test_exactly_two_policies_exist_and_neither_can_be_invented",
        "test_astra_v8_runner.WorkerTests.test_only_a_declared_model_policy_may_run_a_job",
        "test_astra_v8_runner.WorkerTests.test_every_record_names_the_policy_that_produced_it",
        "test_astra_v8_runner.WorkerTests.test_substituted_model_or_tool_set_fails_the_job"],
    "F2. Failover only to a fallback that actually answers": [
        "test_astra_fallback_v8.FailoverTests.test_primary_failure_alone_never_switches_policy",
        "test_astra_fallback_v8.FailoverTests.test_switch_only_after_the_fallback_actually_answers",
        "test_astra_fallback_v8.FailoverTests.test_model_behaviour_is_not_a_provider_outage",
        "test_astra_fallback_v8.FailoverTests.test_a_fallback_that_also_fails_returns_to_a_primary_known_to_answer"],
    "F3. Return to Astra on one probe, never mid-session, never blocking": [
        "test_astra_fallback_v8.FailoverTests.test_one_successful_primary_probe_returns_to_astra",
        "test_astra_fallback_v8.FailoverTests.test_a_failing_probe_does_not_return_to_astra",
        "test_astra_fallback_v8.FailoverTests.test_never_switches_while_a_worker_is_still_running",
        "test_astra_fallback_v8.FailoverTests.test_a_running_probe_never_delays_the_host_position_poll",
        "test_astra_fallback_v8.PolicyDeclarationTests.test_a_probe_that_cannot_run_is_an_answer_not_a_crash"],
    # Superseded by operator decision 2026-09-09: with the primary out of quota until
    # 15 Sep, holding fallback cycles out of the arms meant collecting no evidence at
    # all. They now count, and what keeps the comparison readable is that each arm
    # reports the policies that produced it and that a day whose arms saw different
    # policies is counted rather than averaged away.
    "F4. Fallback cycles count in study arms and stay separable in metrics": [
        "test_astra_fallback_v8.ArmIsolationTests.test_fallback_and_mixed_cycles_count_in_the_arm_comparison",
        "test_astra_fallback_v8.ArmIsolationTests.test_the_arm_composition_names_every_policy_that_produced_it",
        "test_astra_fallback_v8.ArmIsolationTests.test_a_day_whose_arms_saw_different_policies_is_counted_as_skewed",
        "test_astra_fallback_v8.ArmIsolationTests.test_a_day_both_arms_saw_the_same_policy_is_not_counted_as_skewed",
        "test_astra_fallback_v8.ArmIsolationTests.test_an_untagged_historical_assignment_still_counts_as_primary",
        "test_astra_fallback_v8.MergedCohortTests.test_one_cohort_still_reports_each_policy_separately",
        "test_astra_fallback_v8.MergedCohortTests.test_latency_is_attributed_to_the_policy_that_spent_it"],
    "F5. A code change re-cohorts explicitly and probes parse noisy output": [
        "test_astra_v8_phase.PhaseTests.test_recohort_is_the_only_way_past_an_initialized_cohort",
        "test_astra_v8_phase.PhaseTests.test_recohort_refused_before_the_cohort_exists",
        "test_astra_fallback_v8.FailoverTests.test_a_noisy_probe_file_is_still_read_correctly",
        "test_astra_fallback_v8.FailoverTests.test_an_unparseable_probe_file_is_unavailable_not_a_crash"],
    # Added 2026-09-09: the failover rule was symmetric in name only. Moving TO the
    # fallback required proof it answers; moving BACK to the primary required nothing,
    # and the lane spent 2h38m on a primary whose quota does not reset for six days.
    "F7. Return to the primary only on fresh evidence that it answers": [
        "test_astra_fallback_v8.FailoverTests.test_it_does_not_bounce_to_a_primary_whose_own_probe_failed",
        "test_astra_fallback_v8.FailoverTests.test_a_primary_probe_older_than_its_ttl_is_not_evidence",
        "test_astra_fallback_v8.FailoverTests.test_never_having_probed_the_primary_is_not_evidence_either",
        "test_astra_fallback_v8.FailoverTests.test_holding_on_the_fallback_still_returns_once_the_primary_recovers",
        "test_astra_fallback_v8.FailoverTests.test_a_fallback_that_also_fails_returns_to_a_primary_known_to_answer"],
    # Added 2026-09-09 after a re-cohort armed cleanly and then crash-looped: the
    # supervisor's own state file is part of a cohort change, not a bystander.
    "F6. A re-cohort migrates the supervisor state instead of orphaning it": [
        "test_astra_v8_phase.SupervisorCohortMigrationTests.test_the_new_cohort_starts_with_no_scheduling_state",
        "test_astra_v8_phase.SupervisorCohortMigrationTests.test_which_provider_answers_survives_the_cohort_change",
        "test_astra_v8_phase.SupervisorCohortMigrationTests.test_an_unfinished_job_blocks_the_migration",
        "test_astra_v8_phase.SupervisorCohortMigrationTests.test_the_previous_state_is_archived_not_deleted"],
    # Added 2026-09-09: "every enrolled slot ends in exactly one outcome" was true of
    # the legacy runner and never of the V8 tick path, which enrolled a slot every five
    # minutes and only ever closed the ones it dispatched. 30 of 43 slots sat open and
    # were scored as failed evaluations, which is what made 0.95 unreachable.
    "F8. Every enrolled slot is closed with the reason it was closed for": [
        "test_astra_v8_supervisor.EnrolledSlotOutcomeTests.test_a_quiet_slot_is_closed_as_screened_not_left_open",
        "test_astra_v8_supervisor.EnrolledSlotOutcomeTests.test_a_slot_lost_to_the_daily_budget_is_a_resource_constraint",
        "test_astra_v8_supervisor.EnrolledSlotOutcomeTests.test_a_barred_slot_is_closed_before_the_tick_fails_loudly",
        "test_astra_v8_supervisor.EnrolledSlotOutcomeTests.test_a_screen_never_overwrites_what_the_model_actually_did",
        "test_astra_v8_supervisor.EnrolledSlotOutcomeTests.test_screened_slots_leave_the_reliability_denominator_alone"],
    # Added 2026-09-09: the per-cycle figures divided by every enrolled slot, so they
    # measured host dispatch frequency as much as strategy quality — diluted several
    # times over. They now divide by dispatched slots, which makes the arms' dispatch
    # rates part of what a verdict has to disclose.
    "F9. Per-cycle figures divide by dispatched slots, and unequal dispatch is disclosed": [
        "test_astra_fallback_v8.ArmIsolationTests.test_per_cycle_figures_divide_by_dispatched_slots_not_enrolled_ones",
        "test_astra_fallback_v8.ArmIsolationTests.test_a_screened_slot_never_counts_as_a_dispatched_one",
        "test_astra_fallback_v8.ArmIsolationTests.test_a_crashed_job_stays_in_the_denominator",
        "test_astra_fallback_v8.ArmIsolationTests.test_an_outcome_only_a_worker_can_record_counts_without_the_flag",
        "test_astra_fallback_v8.ArmIsolationTests.test_unequal_dispatch_between_arms_is_reported_not_hidden"],
    # Added 2026-09-10: the V8 supervisor replaced the runner loop that published the
    # learning projection, so the dashboard panel froze at the cutover and sat on its own
    # STALE warning. The projection also filtered on a single hard-coded model name.
    "F10. The learning panel is fed by the lane that is actually running": [
        "test_hermes_dashboard.V8CycleProjectionTests.test_v8_cycles_reach_the_panel_at_all",
        "test_hermes_dashboard.V8CycleProjectionTests.test_a_fallback_cycle_is_not_dropped_for_being_the_wrong_model",
        "test_hermes_dashboard.V8CycleProjectionTests.test_legacy_history_is_kept_and_ordered_before_v8",
        "test_hermes_dashboard.V8CycleProjectionTests.test_coaching_cycles_are_not_counted_as_trading_evaluations",
        "test_hermes_dashboard.V8CycleProjectionTests.test_the_symbols_the_host_delivered_are_shown"],
    # Added 2026-09-10: pre-existing latent defect, surfaced once the lane ran steadily.
    # A decision present in both the host log and the lane's recent-decision list put two
    # rows with one id into the evidence index, so every tick that reached coaching raised.
    "F11. A decision known to both host and lane is one record, not a conflict": [
        "test_astra_canonical_v8.CanonicalEvidenceTests.test_a_decision_in_both_sources_is_one_record_not_a_conflict",
        "test_astra_canonical_v8.CanonicalEvidenceTests.test_the_lane_receipt_still_stands_in_when_the_host_has_none",
        "test_astra_canonical_v8.CanonicalEvidenceTests.test_full_wait_receipt_supported_but_report_only_wait_is_not"],
    "Mutation: deleting an invariant turns its own test red": [
        "test_astra_fast_v8.MutationGuardTests.test_removing_a_fast_lane_invariant_turns_its_test_red",
        "test_astra_canonical_v8.MutationGuardTests.test_in_memory_code_mutants_are_killed_by_behavioral_assertions",
        "test_astra_fallback_v8.MutationGuardTests.test_removing_a_failover_guard_turns_its_test_red"],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    loader = unittest.TestLoader()
    report, failed_names, ok = [], [], True
    for requirement, names in REQUIREMENTS.items():
        suite = unittest.TestSuite()
        missing = []
        for name in names:
            try:
                loaded = loader.loadTestsFromName(name)
            except Exception:
                missing.append(name)
                continue
            # unittest does not raise for an unknown name; it silently substitutes a
            # synthetic failing test, which would read as a real assertion failure.
            if any("_FailedTest" in type(t).__name__ for t in loaded):
                missing.append(name)
                continue
            suite.addTests(loaded)
        result = unittest.TextTestRunner(verbosity=0, stream=open("/dev/null", "w")).run(suite)
        passed = not missing and result.wasSuccessful()
        ok = ok and passed
        failed_names.extend(missing + [str(t) for t, _ in result.failures + result.errors])
        report.append({"requirement": requirement, "tests": len(names), "missing": missing,
                       "failures": len(result.failures) + len(result.errors), "status": "PASS" if passed else "FAIL"})
    if args.json:
        print(json.dumps({"contract": report, "allPassed": ok}, indent=2))
    else:
        for row in report:
            print("%-4s %-62s %d tests%s" % (row["status"], row["requirement"][:62], row["tests"],
                                             "" if row["status"] == "PASS" else "  <-- " + ", ".join(row["missing"])))
        print("\nALL REQUIRED TESTS PASS" if ok else "\nUNMET: " + ", ".join(failed_names))
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
