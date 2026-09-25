"""Read only Hermes lane evidence; publish a bounded display projection, never raw sessions/auth."""
import json
import time
from collections import deque
from itertools import chain
from pathlib import Path
from candidate_disposition import render_reports


def host_entry_report(row):
    """Display persisted host facts before fallible model prose; no order authority."""
    lines = []
    for d in row.get('hostEntryDiagnostics') or []:
        if d.get('source') != 'HOST_PERSISTED_PLAN_ASSESSMENT_V1':
            continue
        origin = ('Menunggu kondisi harga; bukan kegagalan rencana' if d.get('failureOrigin') == 'AWAITING_PRICE_NOT_PLAN_FAILURE' else
                  'Rencana BARU gagal pemeriksaan awal' if d.get('failureOrigin') == 'NEW_PLAN_FAILED_INITIAL_CHECK'
                  else 'Rencana existing diblokir lifecycle')
        lines.append(f"HOST VERIFIED: {origin}; plan={d.get('planId')}; planPersisted={d.get('planPersisted')}; "
                     f"cost={d.get('costBps')} bps / cap={d.get('maxCostBps')} bps; "
                     f"candle={d.get('candleClose')} / trigger={d.get('triggerKind')} {d.get('triggerPrice')}; "
                     f"failed={d.get('failedPredicates')}; orderSubmitted=False. "
                     "Ini hasil assessment tersimpan, bukan harga fresh atau izin retry.")
    return ('\n'.join(lines) + '\n\nMODEL INTERPRETATION (not verified):\n') if lines else ''


def _v8_cycles(root):
    """Trading cycles the V8 supervisor recorded, in the legacy row shape.

    The V8 supervisor replaced the runner loop that wrote `cycles.jsonl`, so from the
    cutover onwards every cycle went to `logs/astra-v8-*.jsonl` and this projection saw
    nothing new. Only FAST_TRADING is counted: "evaluasi" here has always meant a
    trading evaluation, and coaching keeps its own journal.
    """
    log = root / "logs/astra-v8-fast_trading.jsonl"
    if not log.exists():
        return
    with log.open() as stream:
        for line in stream:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue  # A partially written last record is not a completed evaluation.
            if row.get("kind") != "CYCLE_COMPLETION" or row.get("mode") != "FAST_TRADING":
                continue
            yield {"at": row.get("recordedAt", 0) / 1000, "model": row.get("model"),
                   "outcome": row.get("outcome"), "completed": row.get("modelCompleted") is True,
                   "evaluationComplete": row.get("completed") is True,
                   "modelCalled": row.get("modelCalled", True), "apiCalls": row.get("apiCalls") or 0,
                   "turnsUsed": row.get("turnsUsed"), "turnsLimit": row.get("turnsLimit"),
                   "hostRevision": row.get("fingerprint"),
                   "response": host_entry_report(row)+((render_reports(row['candidateReports'])+
                                 ('\n\nHOST-CONFIRMED RECEIPT (not model prose):\n'
                                  if row.get('responseSource') == 'HOST_CONFIRMED_DECISIONS'
                                  else '\n\nRAW MODEL RESPONSE:\n'))
                                if row.get('candidateReports') else '')+(row.get('response') or ''),
                   "inspectedSymbols": [s for s in (row.get("assessedSymbols") or []) if isinstance(s, str)],
                   "cadence": {}, "tradingEnabled": True}


def _legacy_cycles(root):
    log = root / "logs/cycles.jsonl"
    if not log.exists():
        return
    with log.open() as stream:
        for line in stream:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            # The model is metadata, not an eligibility test. Filtering on one model name
            # silently dropped every cycle the declared fallback decided, which is most of
            # them while the primary is out of quota.
            if row.get("tradingEnabled") is not True:
                continue
            yield row


def learning_snapshot(root: Path, now=None):
    cycles = deque(maxlen=10)
    count = completed = 0
    outcomes = {}
    model_calls = 0
    # Chained, never materialised: cycles.jsonl is tens of megabytes and the legacy
    # runner stopped writing it at the V8 cutover, so the two sources are already in
    # order. Only the bounded tail is sorted, below.
    for row in chain(_legacy_cycles(root), _v8_cycles(root)):
        count += 1
        # A host-screened slot is a completed evaluation that cost no model call;
        # a provider loss is neither. Legacy rows predate the field.
        outcome = row.get("outcome") or ("MODEL_DECISION" if row.get("completed") is True else "UNCLASSIFIED_LEGACY")
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
        completed += bool(row.get("evaluationComplete", row.get("completed") is True))
        model_calls += row.get("modelCalled", True) is not False
        # V8 rows carry the symbols the host actually delivered; legacy rows only have
        # them inside the model's own tool calls.
        inspected = set(row.get("inspectedSymbols") or [])
        for message in row.get("messages") or []:
            if not isinstance(message, dict):
                continue
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                if function.get("name") != "astra_context":
                    continue
                try:
                    args = function.get("arguments") or "{}"
                    args = json.loads(args) if isinstance(args, str) else args
                    inspected.update(s for s in args.get("symbols", []) if isinstance(s, str))
                except (ValueError, TypeError, AttributeError):
                    pass
        screen = row.get("cadence") or {}
        response = str(row.get("response") or "")
        if not response and row.get("modelCalled") is False:
            response = ("Pemeriksaan otomatis: " + outcome + ". Setup yang dihitung: " + str(screen.get("liveSetups", "?"))
                        + "; siap entry: " + str(screen.get("readyN", "?")) + ". " + str(screen.get("why") or ""))
        cycles.append({"at": int(float(row["at"]) * 1000), "completed": bool(row.get("evaluationComplete", row.get("completed") is True)),
                       "modelCompleted": row.get("completed") is True, "hostRevision": row.get("hostRevision"),
                       "outcome": outcome, "modelCalled": row.get("modelCalled", True) is not False,
                       "turnsUsed": row.get("turnsUsed"), "turnsLimit": row.get("turnsLimit"),
                       "apiCalls": int(row.get("apiCalls") or 0), "response": response[:6000],
                       "inspectedSymbols": sorted(inspected)[:1000]})
    memory = root / "hermes-home/memories/MEMORY.md"
    memory_text = memory.read_text()[:6000] if memory.exists() else ""
    plans = root / "hermes-home/astra-plans.json"
    if plans.exists():
        try:
            from astra_plans import PlanBook
            summary = PlanBook(root, now=lambda: int((time.time() if now is None else now) * 1000)).summary()
            projection = {k: summary[k] for k in ("version", "total", "readyN", "submittedN", "declinedReadyN", "warning")}
            projection["recentSetups"] = [{"id": p["plan"]["id"], "symbol": p["plan"]["symbol"],
                "trigger": [p["plan"]["triggerKind"], p["plan"]["triggerPrice"]], "expiresAt": p["plan"]["expiresAt"],
                "assessment": p["assessment"], "shadow": p["shadow"]} for p in summary["plans"][:4]]
            memory_text += "\n\nFROZEN SETUP JOURNAL (host projection; sampled paths are NOT trading PnL):\n" + json.dumps(projection, ensure_ascii=False)
        except (ValueError, KeyError, TypeError):
            memory_text += "\n\nSetup journal unavailable; do not infer zero experiments."
    learning = root / "hermes-home/astra-learning.json"
    if learning.exists():
        try:
            from astra_learning import LearningBook
            from astra_plans import PlanBook
            clock = lambda: int((time.time() if now is None else now) * 1000)
            evidence = LearningBook(root, now=clock).summary(PlanBook(root, now=clock))
            evidence.pop("unreviewedTrades", None)
            # Put measured learning before potentially long personal/setup text.
            memory_text = "EVIDENCE-LINKED LEARNING (hypotheses, NOT proven improvement):\n" + json.dumps(evidence, ensure_ascii=False) + "\n\n" + memory_text
        except (ValueError, KeyError, TypeError, OSError):
            memory_text = "Learning journal unavailable; no improvement claim.\n" + memory_text
    # V8/V9 COACHING writes its reviews to the canonical overlay, not to the legacy
    # learning journal this projection was built around. Without this block the panel
    # reported "no learning recorded" while real reviews existed on disk — the same
    # class of defect as the hard-coded model name: the data was right, the view blind.
    overlay = root / "hermes-home/astra-canonical-v8.json"
    if overlay.exists():
        try:
            entries = json.loads(overlay.read_text())
            entries = entries if isinstance(entries, list) else entries.get("entries", [])
            reviews = [e for e in entries if e.get("kind") == "REVIEW"]
            lessons = {e['id']:e for e in entries if e.get("kind") == "PROCEDURE"}
            recent = []
            for e in reviews[-5:]:
                payload = e.get("payload") or {}
                interpretation = payload.get("modelInterpretation") or {}
                recent.append({
                    "reviewId": payload.get("reviewId"), "evidenceId": payload.get("evidenceId"),
                    "status": payload.get("status"),
                    # The HOST's classification, not the model's claim about itself.
                    "outcomeClassification": payload.get("outcomeClassification"),
                    "observedMechanism": str(interpretation.get("observedMechanism") or "")[:600],
                    "requiredAction": str(interpretation.get("requiredAction") or "")[:400],
                    "exceptions": str(interpretation.get("exceptions") or "")[:300]})
            memory_text = ("CANONICAL COACHING REVIEWS (%d review(s), %d published lesson(s); "
                           "PROVISIONAL means recorded, not proven):\n" % (len(reviews), len(lessons))
                           + json.dumps(recent, ensure_ascii=False) + "\n\n" + memory_text)
        except (ValueError, KeyError, TypeError, OSError):
            memory_text = ("Canonical coaching overlay unreadable; reviews may exist but are not "
                           "shown here. Do not read this as no learning.\n") + memory_text
    trials = root / "hermes-home/astra-experiments.json"
    if trials.exists():
        try:
            from astra_experiments import ExperimentBook
            trial = ExperimentBook(root, now=lambda: int((time.time() if now is None else now)*1000)).summary()
            trial["recentStudies"] = [{**s, "phases": s["phases"][-1:]} for s in trial["recentStudies"][:1]]
            memory_text = "STRATEGY VERSION TRIALS (not a profit guarantee):\n" + json.dumps(trial, ensure_ascii=False) + "\n\n" + memory_text
        except (ValueError, OSError, KeyError, TypeError):
            memory_text = "Strategy trial evidence UNAVAILABLE; no promotion claim.\n" + memory_text
    if overlay.exists() and (root/'v8-manifest.json').exists():
        try:
            from astra_canonical_v8 import CanonicalBook, learning_health
            health=learning_health(CanonicalBook(json.loads(overlay.read_text())),
                                   json.loads((root/'v8-manifest.json').read_text())['fingerprint'])
            memory_text='CURRENT CANONICAL LEARNING CHAIN:\n'+json.dumps(health)+'\n\n'+memory_text
        except (ValueError,KeyError,TypeError,OSError):
            memory_text='Current canonical learning chain UNAVAILABLE; no improvement claim.\n'+memory_text
    supervisor_path = root / 'hermes-home/v8/supervisor.json'
    if supervisor_path.exists():
        try:
            state = json.loads(supervisor_path.read_text())
            memory_text = ('HOST PIPELINE HEALTH (not a model decision or profit claim):\n'
                           + json.dumps({k: state.get(k) for k in
                               ('lastPollAt', 'lastHealthyTickAt', 'lastLoopError', 'coverageRecovery')})
                           + '\n\n' + memory_text)
        except (OSError, ValueError):
            memory_text = 'HOST PIPELINE HEALTH UNKNOWN\n\n' + memory_text
    import hermes_learner
    if hermes_learner.state_path(root).exists():
        memory_text = hermes_learner.summary_text(hermes_learner.read_state_quiet(root)) + '\n\n' + memory_text
    return {"publishedAt": int((time.time() if now is None else now) * 1000),
            "memoryUpdatedAt": int(memory.stat().st_mtime * 1000) if memory.exists() else None,
            "memoryText": memory_text[:12000],
            "cycleCount": count, "completedCycles": completed, "modelCalls": model_calls,
            "outcomeCounts": outcomes,
            "outcomeMeaning": "Screened slots are host-verified evaluations without a model call; provider and budget losses are resource constraints, not model behaviour",
            "cycles": sorted(cycles, key=lambda c: c["at"], reverse=True)}


def publish_learning(root, gateway):
    result = gateway("/learning", learning_snapshot(root))
    if result.get("ok") is not True:
        raise RuntimeError("Learning dashboard sync was not acknowledged")
    return result
