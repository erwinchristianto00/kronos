"""VPS-only V8 job supervisor. Gateway protective monitor is a separate process.

Only FAST workers modify plans/experiment submission journals. COACHING workers
only append canonical evidence/procedures. This parent serializes enrollment and
tracks durable event jobs; no process here has direct exchange-order authority.
"""
import argparse
import copy
import fcntl
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import astra_models_v8 as MODELS
import hermes_model_policy_v1 as ROUTER
import astra_runner as engine
from astra_canonical_v8 import CanonicalBook, canonical_evidence, needs_review, _hash as canonical_hash
from astra_experiments import ExperimentBook, digest
from astra_replan_v2 import PlanBook
from astra_fast_v8 import build_fast_context, material_events, new_event_state
from astra_v8_host import COHORT, CoverageBook, FormationReader, atomic_json, fetch_histories, release_gate
from astra_v8_phase import validate_assignment
from quant_snapshot_host import ReferenceCache, attach_references
from quant_candidate_refresh import refresh_candidates
from hermes_decision_evidence import decision_context
from dynamic_scan import DynamicScan
from quant_measurements import measure
import astra_watch_queue as WATCH
import narrative_attention as NARRATIVE

# Supervisor working-set bounds (see Supervisor.compact_jobs).
STATE_WARN_BYTES = 6 * 1024 * 1024
JOB_ARCHIVE = "job-archive.jsonl.gz"
JOB_SLIM_AFTER_MS = 48 * 3600 * 1000
COMPACT_EVERY_MS = 30 * 60 * 1000
# A model cycle takes ~2-4 min; inside this window of max hold the gateway exit wins.
GATEWAY_EXIT_MARGIN_MS = 3 * 60 * 1000
JOB_KEEP_RESULT_KEYS = frozenset({"id", "jobId", "outcome", "error", "completed", "modelRole", "mode",
                                  "canonicalDelta", "canonicalDeltaImported", "slim", "archivedTo"})

ROOT = Path(__file__).resolve().parent
POLL_SECONDS = 30  # incumbent API protective monitoring remains independent
ATTENTION_BATCH = 6  # transport only; every universe contract remains in coverage
# Only a provider that did not answer justifies changing the decision policy. A turn
# budget spent or an invalid response is model behaviour; another model would not fix
# it and switching would hide it.
PROVIDER_FAILURE_OUTCOMES = ("PROVIDER_UNAVAILABLE",)
PROBE_INTERVAL_MS = 60000  # a probe costs provider resource; do not poll it every tick
PROBE_KILL_MS = 150000
# The dashboard marks its learning panel STALE after 15 minutes, so publish well inside
# that. The projection reads the whole legacy cycle log, which is why it is not per-tick.
DASHBOARD_SYNC_MS = 240000


def now():
    return int(time.time() * 1000)


def _reset_at_ms(text):
    """The provider's own reset instant, when the 429 body carries one.

    Honouring it beats a blind cooldown: Astra's quota resets on a date, not in
    fifteen minutes, and retrying before then only burns requests.
    """
    match = re.search(r"['\"]?resets_at['\"]?\s*[:=]\s*(\d{10,13})", str(text or ""))
    if not match:
        return None
    value = int(match.group(1))
    return value * 1000 if value < 10_000_000_000 else value


def report():
    with urllib.request.urlopen("http://127.0.0.1:3102/api/live/astra-hermes/report", timeout=15) as stream:
        value = json.load(stream)
    if value.get("environment") != "testnet" or value.get("laneId") != "ASTRA_HERMES_TESTNET":
        raise ValueError("Wrong report identity")
    return value


def scalar_features(row):
    return {key: value for key, value in (row.get("features") or {}).items()
            if value is None or type(value) in (int, float, bool) or isinstance(value, str) and len(value) < 500}


def formation_readiness(row, at):
    """Expose whether a sampled candidate has enough *measured* input for Astra.

    This is deliberately not an alpha score, side, trigger, or order permission.
    The prior ATTENTION_ONLY label collapsed two different facts: a row with missing
    execution data, and a fresh closed-candle row from which Astra may independently
    formulate a bounded Testnet hypothesis. Keeping those cases distinct prevents the
    worker from treating every coverage batch as observation-only by default.
    """
    observation = measure(row, at)
    economics = row.get("economics") or {}
    cost = economics.get("feeAndSpreadBps")
    checks = {
        "closedWindow": observation.get("status") == "MEASURED",
        "bookFresh": economics.get("bookFresh") is True,
        "costKnown": type(cost) in (int, float) and cost >= 0,
    }
    missing = [name for name, passed in checks.items() if not passed]
    features = observation.get("features") or {}
    return {
        "eligibleForHypothesis": not missing,
        "checks": checks,
        "missing": missing,
        "measurementStatus": observation.get("status"),
        "measurementReason": observation.get("reason"),
        "closedCandleStructure": {key: features.get(key) for key in (
            "momentum20Bps", "atrSma14Bps", "efficiency20", "zscore20",
            "volumeRatio20", "breakoutAbovePrior20", "breakoutBelowPrior20", "regime")},
        "meaning": "Fresh measured formation context only: not a direction, validated edge, "
                   "trigger, entry band, or order permission.",
    }


def compact_candidate(row, at):
    """Existing features/closed bars only; neither direction nor signal from host."""
    candles = [{k: c.get(k) for k in ("closeTime", "open", "high", "low", "close", "volume")}
               for c in row.get("candles", []) if isinstance(c.get("closeTime"), (int, float)) and c["closeTime"] < at][-12:]
    formation = formation_readiness(row, at)
    return {"opportunityId": "candidate-" + digest([row["symbol"], candles[-1]["closeTime"] if candles else None])[:24],
            "symbol": row["symbol"], "features": scalar_features(row), "closedCandles": candles,
            "book": {k: (row.get("book") or {}).get(k) for k in ("bid", "ask", "time")},
            "filters": {k: (row.get("filters") or {}).get(k) for k in ("minNotional", "stepSize", "tickSize", "minQty")},
            "economics": copy.deepcopy(row.get("economics") or {}),
            "formation": formation,
            "trigger": None, "entryBand": None, "thesis": None,
            "meaning": ("FRESH_FORMATION_CONTEXT; Astra may formulate and freeze a bounded NOVEL plan"
                        if formation["eligibleForHypothesis"] else
                        "ATTENTION_ONLY; missing measured formation inputs prevent a bounded hypothesis"),
            "candidateClass": "FRESH_FORMATION_CONTEXT" if formation["eligibleForHypothesis"] else "ATTENTION_ONLY"}


def safe_status(status):
    """Worker-only snapshot without the entire old decision/closed journal."""
    return {k: copy.deepcopy(v) for k, v in status.items() if k not in ("closed", "decisions")}


def fetch_formation(coverage, reservation):
    """A failed pre-worker refresh must release its durable reservation."""
    try:
        return refresh_candidates(fetch_histories(engine.gateway, reservation['symbols']))
    except Exception:
        coverage.progress(reservation['id'], unavailable=reservation['symbols'], outcome='DATA_UNAVAILABLE')
        raise


class Supervisor:
    # Class-level so a supervisor built without __init__ (tests, recovery paths) still
    # has a defined probe state instead of raising on first use.
    probe = None
    probe_target = None

    def __init__(self, root=ROOT):
        self.root = Path(root)
        engine.ROOT = self.root
        self.manifest = json.loads((self.root / "v8-manifest.json").read_text())
        hashes = {name: hashlib.sha256((self.root / name).read_bytes()).hexdigest()
                  for name in self.manifest.get("runtimeFiles", {})}
        self.status = engine.gateway("/status")
        release_gate(self.manifest, current_hashes=hashes, gateway_status=self.status)
        self.dir = self.root / "hermes-home/v8"
        self.dir.mkdir(exist_ok=True)
        self.path = self.dir / "supervisor.json"
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {
            "version": 8, "fingerprint": self.manifest["fingerprint"], "events": new_event_state(),
            "jobs": {}, "pendingEvents": [], "readyStates": {}, "calls": [], "lastFormationAt": None,
            "positionSamples": {}, "lastManagedAt": {}, "seenDispatchEvents": [],
            "modelHealth": {"role": MODELS.PRIMARY, "since": now(), "primaryFailures": 0,
                            "fallbackFailures": 0, "lastProbe": {}, "switches": []}}
        self.health()  # older supervisor state predates the fallback; it starts on the primary
        if self.state.get("fingerprint") != self.manifest["fingerprint"]:
            raise ValueError("Existing supervisor cohort differs; explicit migration required")
        self.coverage = CoverageBook(self.dir / "coverage.json")
        self.processes = {}
        self.market_rows = {}
        self.common_hash = digest({"base": engine.SYSTEM, "common": engine.EXPERIMENT_RULES})
        self.config = engine.cadence_config(self.root) or {}
        self.narrative_attention = NARRATIVE.Attention(self.root)
        self.formation_reader = FormationReader(engine.gateway)
        self.recover()

    def save(self):
        atomic_json(self.path, self.state)
        try:
            size = self.path.stat().st_size
        except OSError:
            return
        if size > STATE_WARN_BYTES:
            # Readers cap this file (the Testnet API at 8 MiB) and then report the
            # runner as stale. Say so loudly instead of letting a dashboard guess.
            print(json.dumps({"at": now(), "status": "SUPERVISOR_STATE_OVERSIZE", "bytes": size,
                              "limitBytes": STATE_WARN_BYTES}), flush=True)

    def gzip_job_files(self, at):
        """Old job/result files become .json.gz in place: lossless, still readable.

        Coaching job files embedded every canonical delta since cutover (~7 MB each,
        136 of them = 936 MB in one release, copied again by every deploy). A file is
        only compressed when nothing on the safety path still looks for it by name:
        its job is finished (or belongs to an earlier cohort), any coverage
        reservation for it has an outcome, and no watch is IN_FLIGHT on it.
        """
        running = {jid for jid, j in self.state.get("jobs", {}).items() if not j.get("finishedAt")}
        coverage = getattr(self, "coverage", None)
        open_coverage = {jid for jid, row in (coverage.state["jobs"].items() if coverage else [])
                         if row.get("outcome") is None}
        in_flight = {row.get("jobId") for row in WATCH.init(self.state)["items"].values()
                     if row.get("status") == "IN_FLIGHT"}
        protected = running | open_coverage | in_flight
        done = 0
        for path in sorted(self.dir.glob("v8-*.json")):
            jid = path.name[:-len(".result.json")] if path.name.endswith(".result.json") else path.stem
            try:
                age = at - path.stat().st_mtime * 1000
            except OSError:
                continue
            if jid in protected or age < JOB_SLIM_AFTER_MS:
                continue
            target = path.with_name(path.name + ".gz")
            data = path.read_bytes()
            with gzip.open(target, "wb") as stream:
                stream.write(data)
            with gzip.open(target, "rb") as stream:
                if stream.read() != data:
                    target.unlink()
                    continue
            keep = path.stat()
            os.chown(target, keep.st_uid, keep.st_gid)
            os.chmod(target, keep.st_mode & 0o777)
            path.unlink()
            done += 1
        return done

    def compact_jobs(self, imported, at=None):
        """Keep the working set bounded; nothing is deleted, it moves to an archive.

        A FAST result carries its canonical delta until coaching merges it. Once the
        canonical book holds an IMPORT_PROVENANCE with that exact hash the copy here is
        redundant, yet every one was kept: ~5 MB/day, past the Testnet API's 8 MiB read
        cap about 1.5 days after each deploy, and the dashboard then called a healthy
        runner stale. Imported deltas and bulky fields of old finished jobs go to an
        append-only gzip archive; outcome, error, actions and model identity stay.
        """
        at = now() if at is None else at
        archive = self.dir / JOB_ARCHIVE
        moved = []
        for jid, job in self.state["jobs"].items():
            result = job.get("result")
            if not job.get("finishedAt") or not isinstance(result, dict):
                continue
            delta = result.get("canonicalDelta")
            if delta:
                h = canonical_hash(delta)
                if h not in imported:
                    continue  # coaching has not merged it yet; it must stay here
                moved.append({"jobId": jid, "kind": "IMPORTED_CANONICAL_DELTA", "hash": h, "delta": delta})
                result["canonicalDelta"] = []
                result["canonicalDeltaImported"] = h
            if result.get("slim") or at - job["finishedAt"] < JOB_SLIM_AFTER_MS:
                continue
            bulky = {k: v for k, v in result.items() if k not in JOB_KEEP_RESULT_KEYS}
            if not bulky and not result.get("actions"):
                result["slim"] = True
                continue
            moved.append({"jobId": jid, "kind": "FINISHED_JOB_RESULT", "result": copy.deepcopy(result)})
            kept = {k: v for k, v in result.items() if k in JOB_KEEP_RESULT_KEYS}
            kept["actions"] = [{k: a.get(k) for k in ("action", "outcome", "orderFilledAt")}
                               for a in result.get("actions") or [] if isinstance(a, dict)]
            kept.update(slim=True, archivedTo=JOB_ARCHIVE)
            job["result"] = kept
        if not moved:
            return 0
        # Archive first, then shrink: a crash in between leaves a duplicate, never a loss.
        with gzip.open(archive, "at") as stream:
            for row in moved:
                stream.write(json.dumps({**row, "archivedAt": at}, allow_nan=False) + "\n")
            stream.flush()
        self.save()
        return len(moved)

    def recover(self):
        # No blind order retry after a process restart. Completed results are
        # consumed, unresolved intents require the original gateway id/payload.
        for jid, job in self.state["jobs"].items():
            if job.get("finishedAt"):
                continue
            result_path = Path(job["path"]).with_suffix(".result.json")
            if result_path.exists():
                self.finish(jid, json.loads(result_path.read_text()))
            else:
                job.update(recovery="UNRESOLVED_RECONCILE", blocksDispatch=True)
        self.save()

    def health(self):
        """Model-health state, defaulted in place: an older journal simply starts primary."""
        return self.state.setdefault("modelHealth", {
            "role": MODELS.PRIMARY, "since": now(), "primaryFailures": 0,
            "fallbackFailures": 0, "lastProbe": {}, "switches": []})

    def router(self):
        """The Astra-primary / Claude-fallback router, defaulted in place."""
        return ROUTER.Router(self.state.setdefault("router", {}), now)

    def route_result(self, job, result):
        """Provider failures are recorded, never an invitation to switch models."""
        spec = job.get("modelPolicy") or {}
        if job.get("mode") == ROUTER.FAST_TRADING and spec:
            self.router().record_result(spec, result.get("error"))
            self.save()

    def _announce_route(self, router, reason, event):
        print(json.dumps({"at": now(), "status": ROUTER.VERSION, "event": event,
                          "routerState": router.state["routerState"],
                          "primaryFailureReason": reason,
                          "meaning": "Task-fixed routing; no automatic fallback or escalation."}), flush=True)

    def model_policy(self, task=ROUTER.FAST_TRADING, opportunity_key=None):
        """The policy a NEW job for this task is frozen to right now.

        Coaching and deep review do not route: they are Claude by definition, so a
        Claude outage postpones them instead of spending Astra's trading quota.
        """
        return self.router().policy_for(task, opportunity_key)

    def primary_answers(self):
        """Fresh, POSITIVE evidence that the primary can answer right now.

        The absence of evidence that a provider is dead is not evidence that it is
        alive, and a probe older than its TTL is not evidence about anything. Returning
        to a primary on anything weaker is how the lane spent 2h38m on a provider whose
        quota does not reset for days.
        """
        probe = (self.health().get("lastProbe") or {}).get(MODELS.PRIMARY) or {}
        return bool(probe.get("available")) and now() - probe.get("at", 0) <= MODELS.PROBE_TTL_MS

    def switch_model(self, role, reason):
        raise ValueError("Fixed routing forbids automatic model switching")

    def probe_result(self):
        """Collect a finished probe without ever waiting on the provider."""
        if self.probe is None:
            return None
        if self.probe.poll() is None:
            if now() - self.health().get("probeStartedAt", now()) > PROBE_KILL_MS:
                self.probe.kill()
                self.probe = None
                self.health().setdefault("lastProbe", {})[self.probe_target] = {
                    "at": now(), "available": False, "reason": "PROBE_KILLED"}
                self.save()
            return None
        path = self.dir / "probe.json"
        # The agent writes retry warnings to the same stream, so the file is not
        # necessarily JSON — take the last line that is, exactly as probe() does.
        # Parsing the whole file would report a real recovery as PROBE_NO_RESULT.
        result = {"role": self.probe_target, "available": False, "reason": "PROBE_NO_RESULT"}
        try:
            for line in reversed(path.read_text().splitlines()):
                if line.strip().startswith("{"):
                    result = json.loads(line)
                    break
        except (OSError, ValueError):
            pass
        role, self.probe, self.probe_target = self.probe_target, None, None
        self.health().setdefault("lastProbe", {})[role] = {**result, "at": now()}
        self.save()
        return {"role": role, **result}

    def start_probe(self, role):
        raise ValueError("Legacy Astra/fallback probes disabled in Sonnet routing")

    def model_health_tick(self):
        """No automatic model switches, legacy probes or effort escalation."""
        return

    def live_job(self, mode):
        return next((j for j in self.state["jobs"].values() if j["mode"] == mode and not j.get("finishedAt")), None)

    def finish(self, jid, result):
        job = self.state["jobs"][jid]
        if result.get("jobId", result.get("id")) != jid:
            raise ValueError("Worker result identity mismatch")
        job.update(finishedAt=now(), result=result)
        health = self.health()
        role = result.get("modelRole") or (job.get("modelPolicy") or {}).get("role") or MODELS.PRIMARY
        self.route_result(job, result)
        if result.get("outcome") in PROVIDER_FAILURE_OUTCOMES:
            if getattr(self,'manifest',{}).get('claudeWaitArm') and hasattr(self,'claude_availability'):
                self.claude_availability.failed()
            key = "primaryFailures" if role == MODELS.PRIMARY else "fallbackFailures"
            health[key] = health.get(key, 0) + 1
            # A fallback that cannot reach its own provider is no better than the primary
            # — but only if the primary can actually answer. Returning to a primary whose
            # own last probe failed swaps a provider that may recover in minutes for one
            # that answered nothing, and the lane then sits there until a dispatched job
            # happens to fail. The outage stays just as visible either way: the cycle is
            # recorded PROVIDER_UNAVAILABLE and fallbackFailures keeps climbing.
            if role == MODELS.FALLBACK:
                if self.primary_answers():
                    self.switch_model(MODELS.PRIMARY, "FALLBACK_ALSO_UNAVAILABLE")
                else:
                    print(json.dumps({"at": now(), "status": "V8_MODEL_HOLD", "role": MODELS.FALLBACK,
                                      "reason": "PRIMARY_NOT_KNOWN_GOOD",
                                      "fallbackFailures": health.get("fallbackFailures", 0),
                                      "lastPrimaryProbe": (health.get("lastProbe") or {}).get(MODELS.PRIMARY),
                                      "meaning": "Both policies are failing; staying put rather than moving to "
                                                 "one with no fresh evidence it answers. Cycles remain "
                                                 "PROVIDER_UNAVAILABLE and the primary is still probed."}),
                          flush=True)
        elif role == health.get("role"):
            health[("primaryFailures" if role == MODELS.PRIMARY else "fallbackFailures")] = 0
        for action in result.get("actions", []):
            if action.get("validAction") and action.get("action") in ("HOLD", "TAKE_PROFIT", "CUT_LOSS"):
                position = (action.get("input") or {}).get("positionId") or action.get("positionId")
                if position:
                    self.state.setdefault("lastManagedAt", {})[position] = now()
        watches = WATCH.init(self.state)
        WATCH.finish(watches, jid, now())
        WATCH.ingest(watches, result.get('candidateReports', []), now())
        if job.get("coverageJob"):
            # Completion is not proof every delivered candidate was assessed.
            # Count only explicitly enumerated model assessment receipts.
            reserved = set(self.coverage.state['jobs'][jid]['symbols'])
            assessed = [s for s in result.get("assessedSymbols", []) if s in reserved]
            outcome = result.get("outcome", "MODEL_INCOMPLETE")
            self.coverage.progress(jid, assessed=assessed, outcome=outcome)
        self.save()

    def reap(self):
        for mode, process in list(self.processes.items()):
            if process.poll() is None:
                continue
            job = self.live_job(mode)
            if job:
                path = Path(job["path"]).with_suffix(".result.json")
                if path.exists():
                    self.finish(job["id"], json.loads(path.read_text()))
                else:
                    job.update(recovery="UNRESOLVED_RECONCILE", blocksDispatch=True, exitCode=process.returncode)
                    self.save()
            del self.processes[mode]

    def dispatch(self, job):
        if getattr(self,'manifest',{}).get('claudeWaitArm') and not self.claude_availability.ready():
            raise ValueError('WAITING_FOR_CLAUDE: provider not ready; no dispatch')
        mode, jid = job["mode"], job["id"]
        if self.live_job(mode):
            raise ValueError("Single-flight mode already has an unresolved job")
        path = self.dir / (jid + ".json")
        atomic_json(path, job)
        self.state["jobs"][jid] = {"id": jid, "mode": mode, "path": str(path), "at": now(),
                                    "coverageJob": job.get("coverageJob", False), "finishedAt": None,
                                    "modelPolicy": job.get("modelPolicy")}
        self.state["calls"].append({"at": now(), "mode": mode})
        from astra_cadence import split_model_budgets
        self.state['modelCallBudgets'] = split_model_budgets(self.state['calls'], self.config, now())
        self.state['modelCallBudget'] = {**self.state['modelCallBudgets']['FAST_TRADING'], 'scope': 'FAST_TRADING'}
        self.save()  # durable receipt BEFORE a process can call an order tool
        output = (self.root / "logs" / (jid + ".log")).open("a")
        try:
            self.processes[mode] = subprocess.Popen([sys.executable, "-u", str(self.root / "astra_v8_runner.py"),
                                                     "--job", str(path)], cwd=self.root, stdout=output, stderr=subprocess.STDOUT)
        finally:
            output.close()

    def owned_context(self, status):
        owned = copy.deepcopy(status.get("active", []))
        view = report()
        pnl = {t["id"]: t for t in view.get("open", [])}
        for p in owned:
            observed = pnl.get(p["id"], {})
            p["pnlUsd"] = observed.get("unrealized")
            samples = self.state.setdefault("positionSamples", {})
            qtime, price, entry = observed.get("quoteAt"), observed.get("quotePrice"), p.get("entryPrice")
            sample = samples.get(p["id"])
            if (observed.get("quoteFresh") is True and isinstance(qtime, (int, float))
                    and isinstance(price, (int, float)) and price > 0 and isinstance(entry, (int, float)) and entry > 0
                    and (sample is None or qtime > sample["lastQuoteAt"])):
                bps = (1 if p["side"] == "LONG" else -1) * (price / entry - 1) * 10000
                sample = {"firstQuoteAt": qtime, "lastQuoteAt": qtime, "samples": 0, "mfeBps": bps, "maeBps": bps} if sample is None else sample
                sample.update(lastQuoteAt=qtime, samples=sample["samples"] + 1,
                              mfeBps=max(sample["mfeBps"], bps), maeBps=min(sample["maeBps"], bps))
                samples[p["id"]] = sample
            p["mfeBps"] = sample["mfeBps"] if sample else None
            p["maeBps"] = sample["maeBps"] if sample else None
            p["excursionProvenance"] = "HOST_SAMPLED_EXECUTABLE_QUOTES_NOT_EXHAUSTIVE_TICK_PATH"
        return owned

    def tick(self):
        # This parent is the only reservation writer. A reservation without a
        # durable worker receipt cannot have executed an order. Recover it, but
        # never discard an unresolved worker or a job/result file of unknown owner.
        self.reconcile_pre_dispatch()
        try:
            self._tick()
        except Exception as error:
            self.state['lastLoopError'] = {'at': now(), 'error': str(error)[:1000]}
            self.reconcile_pre_dispatch()
            self.save()
            raise
        else:
            self.state['lastLoopError'] = None
            self.state['lastHealthyTickAt'] = now()
            self.save()

    def reconcile_pre_dispatch(self):
        if not hasattr(self, 'coverage'):
            return
        watches = WATCH.init(self.state)
        for row in watches['items'].values():
            jid = row.get('jobId')
            if row['status'] != 'IN_FLIGHT' or jid in self.state['jobs']:
                continue
            if ((self.dir / (jid + '.json')).exists()
                    or (self.dir / (jid + '.result.json')).exists()):
                raise ValueError('Unowned watch worker evidence requires reconciliation')
            WATCH.finish(watches, jid, now())  # no worker receipt => no order/model retry
        recovered = []
        for jid, row in list(self.coverage.state['jobs'].items()):
            if row.get('outcome') is not None or jid in self.state['jobs']:
                continue
            if ((self.dir / (jid + '.json')).exists()
                    or (self.dir / (jid + '.result.json')).exists()):
                raise ValueError('Unowned worker evidence requires explicit reconciliation: ' + jid)
            self.coverage.progress(jid, outcome='HOST_PRE_DISPATCH_ABORT')
            recovered.append(jid)
        if recovered:
            self.state['coverageRecovery'] = {'at': now(), 'jobIds': recovered,
                'outcome': 'HOST_PRE_DISPATCH_ABORT', 'modelOrOrderRetried': False}
            self.save()

    def retire_gateway_exit_events(self, owned, at):
        """Do not wake the model for a position the gateway is about to close itself.

        At createdAt + maxHoldMs the gateway exits the position (exitReason MAX_HOLD).
        A model cycle takes minutes, so any management job dispatched in that window
        answers about a position that no longer exists: 25 Sep 19:03:37Z the host woke
        Sonnet for COOKIEUSDT's MAX_HOLD_MILESTONE, the gateway closed it at 19:03:38,
        and both HOLDs came back STALE_ACTION -> INVALID_MODEL_RESPONSE. The events are
        kept as an audit record, never silently dropped.
        """
        closing = set()
        for p in owned:
            start, hold = p.get("createdAt"), p.get("maxHoldMs")
            if (isinstance(start, (int, float)) and isinstance(hold, (int, float)) and hold > 0
                    and at >= start + hold - GATEWAY_EXIT_MARGIN_MS):
                closing.add(p.get("id"))
        if not closing:
            return []
        kept, retired = [], []
        for event in self.state.get("pendingEvents", []):
            (retired if event.get("positionId") in closing else kept).append(event)
        if retired:
            self.state["pendingEvents"] = kept
            log = self.state.setdefault("gatewayExitRetired", [])
            log.extend({"eventId": e.get("eventId"), "positionId": e.get("positionId"),
                        "eventReason": e.get("eventReason"), "retiredAt": at,
                        "reason": "GATEWAY_MAX_HOLD_EXIT"} for e in retired)
            del log[:-200]
        return retired

    def prune_completed_periodic_reviews(self):
        """A successful management action also satisfies older queued periodic reviews.

        Never coalesce material events or failed/unanswered reviews. The durable
        lastManagedAt is advanced only by validated management actions in finish().
        """
        kept, retired = [], []
        for event in self.state.get('pendingEvents', []):
            stamp = event.get('eventDetectedAt')
            completed = self.state.get('lastManagedAt', {}).get(event.get('positionId'))
            if (event.get('eventReason') == 'OWNED_POSITION_REVIEW_DUE'
                    and isinstance(stamp, (int, float))
                    and isinstance(completed, (int, float)) and stamp <= completed):
                retired.append(event['eventId'])
            else:
                kept.append(event)
        self.state['pendingEvents'] = kept
        if retired:
            prior = self.state.get('periodicReviewCoalescing', {})
            self.state['periodicReviewCoalescing'] = {
                'retiredCount': prior.get('retiredCount', 0) + len(retired),
                'lastRetiredIds': retired, 'at': now(),
                'reason': 'SATISFIED_BY_VALIDATED_MANAGEMENT_ACTION'}

    def _tick(self):
        self.reap()
        self.maybe_compact()  # every path of the tick, including provider-wait returns
        self.prune_completed_periodic_reviews()
        # Decide the policy for the next job before anything else, and never wait on a
        # provider here: the owned-position poll below is the lane's eyes.
        self.model_health_tick()
        status = engine.gateway("/status")
        engine.validate_capital_identity(status)
        if status.get("executionVersion") != self.manifest["gatewayExecutionVersion"]:
            raise ValueError("Gateway changed; no new jobs")
        # This poll and the API protections continue while either model is busy.
        owned = self.owned_context(status)
        event_result = material_events(self.state["events"], [], owned, self.market_rows, now_ms=now())
        self.state["events"] = event_result["state"]
        self.state["pendingEvents"].extend(event_result["events"])
        for p in owned:
            interval = self.config.get("manageIntervalMs", 600000)
            last = self.state.setdefault("lastManagedAt", {}).get(p["id"], p.get("createdAt", now()))
            if now() - last >= interval:
                version = digest([p["id"], p["state"], p.get("qty"), int((now() - p["createdAt"]) // interval)])
                self.state["pendingEvents"].append({"positionId": p["id"], "eventReason": "OWNED_POSITION_REVIEW_DUE",
                    "stateVersion": version, "eventId": digest([p["id"], version, "OWNED_POSITION_REVIEW_DUE"]), "eventDetectedAt": now()})
        self.state["lastPollAt"] = now()
        # One asynchronous full-universe read, independent of provider availability
        # and FAST workers. Never wait here before protecting owned positions.
        if not hasattr(self,'dynamic_scan'):
            self.dynamic_scan=DynamicScan(self.root,engine.gateway)
        self.state['dynamicCandidates']=self.dynamic_scan.poll(now())
        narrative_universe = getattr(self.dynamic_scan, 'state', {}).get('universe', [])
        try:
            narrative = (self.narrative_attention.poll(narrative_universe, now())
                         if hasattr(self, 'narrative_attention') else NARRATIVE.snapshot({}, narrative_universe, now()))
        except Exception:
            narrative = NARRATIVE.snapshot({}, narrative_universe, now())
            narrative['sourceError'] = 'OPTIONAL_NARRATIVE_UNAVAILABLE'
        self.state['narrativeAttention'] = {k: v for k, v in narrative.items() if k != 'rows'}
        watches = WATCH.init(self.state)
        if not hasattr(self, 'watch_poll'):
            self.watch_poll = WATCH.WatchPoll()
        WATCH.observe(watches, self.watch_poll.poll(watches, now()), now(),
                      {p['symbol'] for p in owned})
        self.state['watchSummary'] = WATCH.summary(watches)
        budget_at = now()
        from astra_cadence import split_model_budgets
        budgets = split_model_budgets(self.state.get('calls', []), self.config, budget_at)
        self.state['modelCallBudgets'] = budgets
        self.state['modelCallBudget'] = {**budgets['FAST_TRADING'], 'scope': 'FAST_TRADING'}
        used, limit = budgets['FAST_TRADING']['used'], budgets['FAST_TRADING']['limit']
        if getattr(getattr(self,'formation_reader',None),'worker',None) is not None:
            preparation = self.formation_reader.summary(budget_at)
            if used >= limit:
                preparation.update(preparationStatus=preparation['status'],
                    status='BLOCKED_DAILY_MODEL_BUDGET', dispatchBlockedBy='DAILY_MODEL_CALL_BUDGET')
            self.state['formationPreparation'] = preparation
        # Warm references on host polls even between model calls. Launching only
        # on dispatch would leave every sparse/15-minute decision with a cold cache.
        if not hasattr(self, 'quant_reference_cache'):
            self.quant_reference_cache = ReferenceCache(engine.gateway)
        self.quant_reference_cache.context()
        self.save()
        if self.manifest.get('claudeWaitArm'):
            from claude_availability import Availability
            if not hasattr(self,'claude_availability'):
                self.claude_availability=Availability(self.root,now)
            ready=self.claude_availability.tick(self.state['calls'],self.config.get('dailyModelCallBudget',60), exclude_modes=('COACHING',))
            self.state['claudeAvailability']=copy.deepcopy(self.claude_availability.state)
            self.save()
            if not ready:
                print(json.dumps({'at':now(),'status':'ARMED_WAITING_FOR_CLAUDE',
                                  'nextProbeAt':self.claude_availability.state.get('nextProbeAt'),
                                  'meaning':'Native gateway protections remain independent; no model job dispatched.'}),flush=True)
                return
        if self.live_job("FAST_TRADING"):
            self.coach_if_due()
            return
        book = ExperimentBook(self.root, self.common_hash)
        # Assignment precedes market reading; five-minute enrollment remains
        # incumbent. Multiple event jobs can share that frozen assignment.
        assignment = book.start_cycle()
        # The five-minute slot IS the opportunity/stateVersion key the router counts
        # fallbacks against, so one Astra outage buys one Claude decision for that slot.
        policy = self.model_policy(ROUTER.FAST_TRADING, assignment["id"])
        # The arm is evidence about a strategy, so it has to know which decision policy
        # produced it. A five-minute slot that saw both is MIXED and counts for neither.
        recorded = assignment.setdefault("modelRole", policy["role"])
        if recorded != policy["role"] and recorded != "MIXED":
            assignment["modelRole"] = "MIXED"
        book.save()
        try:
            validate_assignment(book, assignment, self.manifest, now())
            entry_admitted = True
        except ValueError:
            entry_admitted = False
            if not owned:
                # Still fail loudly, but close the slot first: with nothing owned this
                # raises on every tick of the slot, so leaving it open would score a
                # barred cohort boundary as a cycle the model failed to complete.
                book.record_screen_outcome("SCREENED_NOT_ADMITTED")
                raise
        plans = PlanBook(self.root, max_risk_inflation=engine.execution_config(self.root).get("maxRiskInflation"))
        plans.expire_unsubmitted(status)
        eligible = []
        for p in plans.state["plans"]:
            if p.get("submissionId") and plans.recoverable_no_order(p):
                plans.record_rejection(p)
            if (p.get("submissionId") and not plans.recoverable_no_order(p)) or p.get("v2Retired") or not p.get("v2"):
                continue
            try:
                book.check_entry(p)
                eligible.append(p)
            except ValueError:
                pass
        # Readiness checks never re-rank alpha; all unexpired plans remain stored.
        eligible = eligible if entry_admitted else []
        WATCH.observe(watches, self.watch_poll.observations, now(),
                      {p['plan']['symbol'] for p in eligible} | {p['symbol'] for p in owned})
        symbols = sorted({p["plan"]["symbol"] for p in eligible} | {p["symbol"] for p in owned})
        raw = fetch_histories(engine.gateway, symbols) if symbols else {
            "source": "BINANCE_USDM_TESTNET", "status": status, "rows": [], "unavailableSymbols": []}
        stamp = now()
        for row in raw["rows"]:
            row["observedAt"] = stamp
            self.market_rows[row["symbol"]] = row
        plans.observe(raw)
        all_views = [plans.view(p) for p in eligible]
        # Evaluate EVERY frozen plan before bounded delivery. Rotate equal-state
        # plans and prioritize READY events; first-eight unready cannot starve #9.
        cursor = self.state.get("planCursor", 0)
        ordered = sorted(all_views, key=lambda p: p["plan"]["id"])
        rotated = ordered[cursor % len(ordered):] + ordered[:cursor % len(ordered)] if ordered else []
        selected = sorted(rotated, key=lambda p: not p["assessment"].get("ready"))[:8]
        self.state["planCursor"] = cursor + len(selected)
        fresh_owned = self.owned_context(raw["status"])
        event_result = material_events(self.state["events"], selected, fresh_owned, self.market_rows, now_ms=now())
        self.state["events"] = event_result["state"]
        self.state["pendingEvents"].extend(event_result["events"])
        for view in all_views:
            p, a = view["plan"], view["assessment"]
            lifecycle = view.get("reassessment", {})
            reassess = lifecycle.get("status") in ("REASSESS_REQUIRED", "WAITING") and lifecycle.get("attemptsRemaining", 0) > 0
            value = digest({"ready": a.get("ready"), "failed": a.get("failed"), "submitted": view.get("submissionId"),
                            "reassessmentCandleAt": a.get("candleAt") if reassess else None})
            reason = "PLAN_STALE_REASSESS_REQUIRED" if reassess else "READY_SETUP"
            if (a.get("ready") or reassess) and self.state["readyStates"].get(p["id"]) != value:
                self.state["pendingEvents"].append({"opportunityId": p["id"], "eventReason": reason,
                    "stateVersion": value, "eventId": digest([p["id"], value, reason]), "eventDetectedAt": now()})
            self.state["readyStates"][p["id"]] = value
        self.save()
        formation_interval = self.config.get("emptyPipelineIntervalMs", 900000) if not eligible else self.config.get("formationIntervalMs", 3600000)
        # Kept separate from `formation_due` so the slot can be closed with the reason it
        # was actually closed for: a spent budget is a resource constraint, a quiet
        # pipeline is a screen, and the two are not scored the same way.
        interval_elapsed = self.state["lastFormationAt"] is None or now() - self.state["lastFormationAt"] >= formation_interval
        fast_budget = split_model_budgets(self.state['calls'], self.config, now())['FAST_TRADING']
        calls, budget = fast_budget['used'], fast_budget['limit']
        formation_due = interval_elapsed and entry_admitted and calls < budget
        seen = set(self.state.setdefault("seenDispatchEvents", []))
        selected_ids = {p["plan"]["id"] for p in selected}
        owned_ids = {p["id"] for p in fresh_owned}
        self.retire_gateway_exit_events(fresh_owned, now())
        all_pending = list({e["eventId"]: e for e in self.state["pendingEvents"] if e["eventId"] not in seen}.values())
        events = [e for e in all_pending if (e.get("positionId") in owned_ids or e.get("opportunityId") in selected_ids)]
        # Urgent owned-position / frozen-plan events retain their incumbent fast path.
        watch_due = WATCH.due(watches)[:WATCH.MAX_EXTRA] if entry_admitted and calls < budget and not events else []
        if not events and not formation_due and not watch_due:
            # The slot was enrolled and decided about; it just never needed the model.
            # Leaving it open was scoring "never asked" the same as "asked and failed".
            book.record_screen_outcome("SCREENED_NOT_ADMITTED" if not entry_admitted
                                       else "SCREENED_BUDGET" if interval_elapsed and calls >= budget
                                       else "SCREENED_NO_TRADE")
            self.coach_if_due()
            return
        candidate_rows, coverage_job, candidate_selection = [], False, None
        prepared = None
        jid = "v8-fast-" + digest([self.manifest["fingerprint"], now(), events])[:24]
        if not events and formation_due:
            try:
                separately_monitored = {r['symbol'] for r in watches['items'].values()
                                        if r['status'] in ('WATCHING', 'READY', 'IN_FLIGHT')}
                candidate_selection=self.dynamic_scan.selection(self.coverage.state,now(),
                                                                 exclude_symbols=separately_monitored)
                candidate_selection=NARRATIVE.select_exploration(candidate_selection,
                    self.dynamic_scan.state.get('ranked', []),self.coverage.state,narrative,separately_monitored)
                if not candidate_selection['selected']:raise ValueError('No valid candidate data')
            except ValueError:
                book.record_screen_outcome('SCREENED_CANDIDATE_DATA_UNAVAILABLE')
                self.coach_if_due()
                return
            if hasattr(self,'formation_reader'):
                prepared=self.formation_reader.poll(candidate_selection,now())
                self.state['formationPreparation']=self.formation_reader.summary(now())
                if prepared is None:
                    formation_due=False
                    candidate_selection=None
                    if not watch_due:
                        book.record_screen_outcome('SCREENED_CONTEXT_PREPARING')
                        self.save()
                        self.coach_if_due()
                        return
                else:
                    candidate_selection=prepared['selection']
                    # A read launched before ownership/WATCH changed is not a
                    # license to duplicate its newly monitored symbol.
                    if any(r['symbol'] in separately_monitored for r in candidate_selection['selected']):
                        book.record_screen_outcome('SCREENED_PREPARATION_SELECTION_CHANGED')
                        self.save()
                        return
        if not events and formation_due:
            self.coverage.observe(self.dynamic_scan.state['universe'],{},now())
            reservation = self.coverage.reserve(jid, ATTENTION_BATCH, now(), selection=candidate_selection)
            if prepared is None:
                new = fetch_formation(self.coverage, reservation)
            else:
                try:
                    new=refresh_candidates(prepared['raw'])
                    new['status']=engine.gateway('/status')
                    engine.validate_capital_identity(new['status'])
                    self.state['formationPreparation'].update(status='DELIVERED',
                        totalPreparationMs=now()-prepared['startedAt'],
                        foregroundRefreshMs=now()-reservation['at'])
                except Exception:
                    self.coverage.progress(jid,unavailable=reservation['symbols'],outcome='DATA_UNAVAILABLE')
                    raise
            candidate_rows = new["rows"]
            for row in candidate_rows:
                row["observedAt"] = now()
            # No new source-side entry selection or directional mapping.
            raw["rows"].extend(r for r in candidate_rows if r["symbol"] not in {x["symbol"] for x in raw["rows"]})
            raw["status"] = new["status"]
            raw["at"] = new.get("at")
            raw["unavailableSymbols"] = new["unavailableSymbols"]
            self.coverage.progress(jid, fetched=reservation["symbols"], delivered=reservation["symbols"])
            coverage_job = True
            events.append({"eventReason": "NEW_CANDIDATE_BATCH", "eventId": jid,
                           "eventDetectedAt": prepared['startedAt'] if prepared else reservation["at"]})
        # WATCH rows are additional to the untouched six-symbol coverage reservation.
        # Refresh in transport-sized chunks; overflow remains durable for later jobs.
        watch_ids, watch_metadata = [], {}
        fresh_symbols = {r['symbol'] for r in candidate_rows}
        extra = [r for r in watch_due if r['symbol'] not in fresh_symbols]
        for offset in range(0, len(extra), ATTENTION_BATCH):
            group = extra[offset:offset+ATTENTION_BATCH]
            try:
                refreshed = refresh_candidates(fetch_histories(engine.gateway, [r['symbol'] for r in group]))
                candidate_rows.extend(refreshed['rows'])
                raw['status'] = refreshed['status']
                raw['unavailableSymbols'] = sorted(set(raw.get('unavailableSymbols', [])) |
                                                     set(refreshed.get('unavailableSymbols', [])))
            except Exception as error:
                for watch in group:
                    watch['checkStatus'] = 'REFRESH_UNAVAILABLE'
                self.state['lastWatchRefreshError'] = {'at': now(), 'error': str(error)[:300]}
        kept = []
        by_symbol = {w['symbol']: w for w in watch_due}
        for row in candidate_rows:
            watch = by_symbol.get(row['symbol'])
            obs = {'book': row.get('book'), 'closedCandleTime': max(
                (c['closeTime'] for c in row.get('candles', []) if c.get('closeTime', now()) < now()), default=None)}
            valid = watch and now() < watch['expiresAt'] and WATCH.condition(watch, obs, now())
            if row['symbol'] in fresh_symbols or valid:
                kept.append(row)
            if valid:
                watch_ids.append(watch['id'])
                watch_metadata[row['symbol']] = {k: copy.deepcopy(watch.get(k)) for k in
                    ('id', 'decisionId', 'assessedAt', 'reason', 'revisitCondition', 'invalidation', 'expiresAt')}
                events.append({'eventReason': 'WATCH_REASSESSMENT', 'eventDetectedAt': now(),
                               'eventId': digest([watch['id'], jid]), 'symbol': row['symbol']})
        candidate_rows = kept
        if not events:
            self.save()
            book.record_screen_outcome('SCREENED_NO_TRADE')
            return
        raw_by_symbol = {r['symbol']: r for r in raw['rows']}
        raw_by_symbol.update({r['symbol']: r for r in candidate_rows})
        raw['rows'] = list(raw_by_symbol.values())
        for row in candidate_rows:
            self.market_rows[row['symbol']] = row
        raw = attach_references(raw, self.quant_reference_cache)
        tags = {"executionPolicyVersion": self.manifest["gatewayExecutionVersion"],
                "tradePolicyVersion": assignment["version"], "decisionVersion": COHORT}
        context = build_fast_context(selected, fresh_owned, self.market_rows, now_ms=now(), policy_versions=tags)
        context["marketCandidates"] = [compact_candidate(row, now()) for row in candidate_rows]
        for candidate in context['marketCandidates']:
            if candidate['symbol'] in watch_metadata:
                candidate['watchReassessment'] = watch_metadata[candidate['symbol']]
        context['watchQueue'] = {**WATCH.summary(watches), 'deliveredWatchN': len(watch_ids),
                                 'meaning': 'Reassess thesis/invalidation on fresh data. No automatic plan or entry.'}
        if candidate_selection:
            context['candidateSelection']=candidate_selection
        deferred_watch_ids = WATCH.fit_context(context, raw, fresh_symbols, now()) if watch_ids else []
        if deferred_watch_ids:
            watch_ids = [wid for wid in watch_ids if wid not in deferred_watch_ids]
            delivered_symbols = {r['symbol'] for r in context['marketCandidates'] if r.get('watchReassessment')}
            events = [e for e in events if e.get('eventReason') != 'WATCH_REASSESSMENT' or e['symbol'] in delivered_symbols]
            context['watchQueue'].update(deliveredWatchN=len(watch_ids), contextDeferredN=len(deferred_watch_ids))
        if not events:
            self.state['watchSummary'] = WATCH.summary(watches)
            self.save()
            book.record_screen_outcome('SCREENED_NO_TRADE')
            return
        context['narrativeContext'] = NARRATIVE.compact(narrative,
            [r['symbol'] for r in context['marketCandidates']] + [p['symbol'] for p in fresh_owned])
        context["coverageMeaning"] = "Only this batch assessed, not all-market NO_TRADE"
        context["excursionMeaning"] = "MFE/MAE are sampled executable quote extrema since host observation, not exhaustive intratrade maxima"
        job = {"id": jid, "mode": "FAST_TRADING", "cohortId": COHORT, "fingerprint": self.manifest["fingerprint"],
               "modelPolicy": policy,
               "eventDetectedAt": min(e["eventDetectedAt"] for e in events), "contextBuiltAt": now(),
               "events": events, "context": context, "rawContext": {**raw, "status": safe_status(raw["status"])},
               "assignmentId": assignment["id"], "coverageJob": coverage_job}
        # Recorded before the worker starts, so it is a fact about what the host did and
        # can never be set from what the model answered. It is the denominator of
        # netPerDispatchedCycle; saving after dispatch would also race the worker's own
        # writes to this journal.
        assignment["dispatched"] = True
        book.save()
        WATCH.mark_dispatched(watches, watch_ids, jid, now())
        self.state['watchSummary'] = WATCH.summary(watches)
        self.save()
        try:
            self.dispatch(job)
        except Exception:
            if jid not in self.state['jobs']:
                WATCH.finish(watches, jid, now())
                self.save()
            raise
        self.state["seenDispatchEvents"].extend(e["eventId"] for e in events if e["eventId"] not in seen)
        dispatched = {e["eventId"] for e in events}
        self.state["pendingEvents"] = [e for e in all_pending if e["eventId"] not in dispatched]
        if coverage_job:
            self.state["lastFormationAt"] = now()
        self.save()

    def canonical_input(self):
        """Host-only accounting data, never directly placed in the model prompt."""
        s, r = engine.gateway("/status"), report()
        legacy_path = self.root / "hermes-home/astra-learning.json"
        legacy = json.loads(legacy_path.read_text()) if legacy_path.exists() else {"lessons": []}
        plan_state = json.loads((self.root / "hermes-home/astra-plans.json").read_text())
        experiments = json.loads((self.root / "hermes-home/astra-experiments.json").read_text())
        ids = {t["id"] for t in s.get("active", []) + s.get("closed", [])}
        for key in ("closed", "open", "noFill"):
            r[key] = [t for t in r.get(key, []) if t["id"] in ids]
        for t in r.get("closed", []) + r.get("open", []) + r.get("noFill", []):
            t.pop("reason", None)
        path = self.root / "logs/astra-v8-fast_trading.jsonl"
        records = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        intents = {v["decisionId"]: v for v in records if v["kind"] in ('DECISION_INTENT','V2_PRE_ENTRY_INTENT')}
        quant_records = {v['jobId']:v for v in records if v['kind']=='QUANT_CONTEXT_PREPARED'}
        narrative_records = {v['jobId']:v for v in records if v['kind']=='NARRATIVE_CONTEXT_PREPARED'}
        bindings, decisions = {}, {}
        for did, intent in intents.items():
            a = experiments["assignments"].get(str(intent.get("assignmentId")), {})
            if intent.get("fingerprint") != self.manifest["fingerprint"] or not a.get("version"):
                continue
            bindings[did] = {"cohort": COHORT, "fingerprint": self.manifest["fingerprint"],
                             "executionPolicyVersion": self.manifest["gatewayExecutionVersion"],
                             "tradePolicyVersion": a["version"], "decisionVersion": COHORT,
                             # Which decision policy actually produced this decision.
                             # Read from the intent the worker wrote, never assumed.
                             "modelRole": intent.get("modelRole", MODELS.PRIMARY)}
        for v in records:
            if v["kind"] != "ACTION_ACTUALITY" or v["decisionId"] not in bindings:
                continue
            result = v.get("executionResult") or v.get("result") or {}
            sent = any(x["kind"] == "REQUEST" and x.get("decisionId") == v["decisionId"] for x in records)
            no_order = (v.get("outcome") == "VALID_NO_TRADE" and v.get("action") == "NO_TRADE"
                        and result.get("status") == "WAIT_RECORDED") or (
                        v.get("outcome") == "REJECTED_BY_POLICY" and (not sent or result.get("noOrderSubmitted") is True))
            intent = intents[v["decisionId"]]
            if (intent['kind']=='V2_PRE_ENTRY_INTENT' and not sent
                    and result.get('noOrderSubmitted') is True and v.get('outcome')=='PLAN_UPDATED'
                    and result.get('status') in ('WAITING','ABANDONED','REPLANNED')):
                no_order=True
            source_path = self.root/'hermes-home/v8'/(intent['jobId']+'.json')
            evidence_context = None
            if source_path.exists():
                evidence_context = decision_context(intent, v, json.loads(source_path.read_text()),
                                                    quant_records.get(intent['jobId']), narrative_records.get(intent['jobId']))
            decisions[v["decisionId"]] = {"id": v["decisionId"], "action": v["action"],
                "at": intent["recordedAt"], "outcome": v["outcome"], "validated": no_order,
                "noOrderConfirmed": no_order, "pending": not no_order,
                "symbol": intent.get("input", {}).get("symbol"), "side": intent.get("input", {}).get("side"),
                'decisionContext':evidence_context, **bindings[v["decisionId"]]}
        return {"report": r, "status": s, "legacyJournal": legacy,
                "plans": plan_state["plans"], "bindings": bindings, "decisions": list(decisions.values()),
                "postFixExecutionVersions": [self.manifest["gatewayExecutionVersion"]]}

    def sync_dashboard(self):
        """Publish the learning projection the way the runner loop used to.

        The V8 supervisor replaced that loop and nothing published, so the dashboard's
        learning panel froze at the cutover and has been showing its own STALE warning
        since. Rate-limited because the projection reads the whole legacy cycle log.

        Reporting failure must never change a trading decision or replace an order,
        so every error here is swallowed after being printed — exactly as before.
        """
        stamp = now()
        if stamp - self.state.get("lastDashboardSyncAt", 0) < DASHBOARD_SYNC_MS:
            return
        self.state["lastDashboardSyncAt"] = stamp
        self.save()
        try:
            from hermes_dashboard import publish_learning
            publish_learning(self.root, engine.gateway)
        except Exception as error:
            print(json.dumps({"at": now(), "status": "DASHBOARD_SYNC_PENDING", "error": str(error)}), flush=True)

    def maybe_compact(self):
        """Bounded working set on its own clock: coaching may be budget- or rate-limited
        for a day, but old job results must still leave this file."""
        stamp = now()
        if (not hasattr(self, "root") or not hasattr(self, "dir")
                or stamp - self.state.get("lastCompactionAt", 0) < COMPACT_EVERY_MS):
            return 0
        # Housekeeping must never cost a tick: position protection comes first.
        self.state["lastCompactionAt"] = stamp
        try:
            self.gzip_job_files(stamp)
        except Exception as error:
            print(json.dumps({"at": stamp, "status": "JOB_FILE_GZIP_SKIPPED", "error": str(error)[:500]}), flush=True)
        try:
            overlay = self.root / "hermes-home/astra-canonical-v8.json"
            imported = set()
            if overlay.exists():
                imported = {e["id"] for e in json.loads(overlay.read_text())
                            if isinstance(e, dict) and e.get("kind") == "IMPORT_PROVENANCE"}
            moved = self.compact_jobs(imported, stamp)
        except Exception as error:
            print(json.dumps({"at": stamp, "status": "COMPACTION_SKIPPED", "error": str(error)[:500]}), flush=True)
            return 0
        self.save()
        return moved

    def coach_if_due(self):
        if self.live_job("COACHING"):
            return
        stamp = now()
        if stamp - self.state.get("lastCoachingAt", 0) < self.config.get("reviewIntervalMs", 900000):
            return
        from astra_cadence import split_model_budgets
        budgets = split_model_budgets(self.state['calls'], self.config, stamp)
        self.state['modelCallBudgets'] = budgets
        if budgets['COACHING']['remaining'] == 0:
            self.state['coachingDeferredReason']='COACHING_DAILY_BUDGET_EXHAUSTED'
            self.save()
            return
        self.state.pop('coachingDeferredReason',None)
        payload = self.canonical_input()
        rows = canonical_evidence(payload["report"], payload["status"], payload["legacyJournal"],
                                  plans=payload["plans"], bindings=payload["bindings"], decisions=payload["decisions"],
                                  post_fix_execution_versions=payload["postFixExecutionVersions"])
        overlay = self.root / "hermes-home/astra-canonical-v8.json"
        current = CanonicalBook(json.loads(overlay.read_text()) if overlay.exists() else None)
        # One immutable view for this selection, not a deep copy of the entire
        # canonical history for every evidence row (measured >50s on VPS).
        review_events = current.export() if any(r['eligible'] for r in rows) else []
        backlog = [r for r in rows if r["eligible"] and needs_review(r,review_events)]
        backlog.sort(key=lambda r: (r["executionClass"] == "LEGACY_EXECUTION", str(r["evidenceId"])))
        # Audit of the immutable legacy overlay is useful even with no publishable
        # new lesson. It cannot create current PnL or legacy lesson primacy.
        if not backlog and overlay.exists():
            return
        jid = "v8-coach-" + digest([self.manifest["fingerprint"], [r["evidenceId"] for r in backlog[:2]], stamp])[:24]
        deltas = [j["result"]["canonicalDelta"] for j in self.state["jobs"].values()
                  if j.get("finishedAt") and j.get("result", {}).get("canonicalDelta")]
        job = {"id": jid, "mode": "COACHING", "cohortId": COHORT, "fingerprint": self.manifest["fingerprint"],
               "modelPolicy": self.model_policy(ROUTER.COACHING),
               "eventDetectedAt": stamp, "contextBuiltAt": now(), "events": [], "context": {},
               "canonicalInput": payload, "canonicalDeltas": deltas,
               "reviewEvidenceIds": [r["evidenceId"] for r in backlog[:2]]}
        self.dispatch(job)
        self.state["lastCoachingAt"] = now()
        self.save()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    engine.gateway_base(ROOT)
    with (ROOT / "runner.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        supervisor = Supervisor()
        while True:
            try:
                supervisor.tick()
                # Last, and only after a healthy tick: reporting must never delay a
                # trading decision, and a lane that is failing should be allowed to let
                # its dashboard go stale rather than refresh a timestamp over a broken
                # cycle. This call swallows its own errors.
                supervisor.sync_dashboard()
            except Exception as error:
                print(json.dumps({"at": now(), "status": "V8_HOST_ERROR", "error": str(error)}), flush=True)
                # Publish explicit error health, never a fabricated successful
                # evaluation. Otherwise a live scanner can hide a wedged loop.
                supervisor.sync_dashboard()
                if not args.loop:
                    raise
            if not args.loop:
                break
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
