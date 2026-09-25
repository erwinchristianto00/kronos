"""V8 host transport and evidence utilities. No model-created scanner signals.

Coverage ordering reuses existing attention lists. Every venue contract retains a
path to assessment; a batch NO_TRADE is never represented as a market-wide verdict.
This module does not execute exchange orders. The incumbent gateway remains sole
executor. Runtime orchestration is explicitly gated by the release manifest.
"""
import copy
import hashlib
import json
import os
import tempfile
import threading
import queue
from pathlib import Path

# Model routing changes who decides, so it opens its own cohort. The previous
# cohort is sealed and kept: no lesson, trade or phase is reset or deleted.
from hermes_model_policy_v1 import COHORT
GATEWAY_VERSION = "astra-final-book-contract-v1-20260909"
HINT_KEYS = ("strongest24h", "weakest24h", "highestQuoteVolume24h")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class CoverageBook:
    """One parent writer. Reserve -> deliver -> assess are distinct facts.

    A provider failure never counts as assessment. It stays recorded and returns
    to a later pass, avoiding starvation of the remaining universe. Lists only
    order a legacy pass once. Explicit dynamic selections bypass queue order but
    retain the same immutable reserve/deliver/assess journal and coverage facts.
    """
    def __init__(self, path):
        self.path = Path(path)
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {
            "version": 8, "pass": 0, "queue": [], "served": [], "universe": [], "jobs": {}}
        if self.state.get("version") != 8 or not isinstance(self.state.get("jobs"), dict):
            raise ValueError("Invalid V8 coverage journal; no reset")

    def save(self):
        atomic_json(self.path, self.state)

    def observe(self, universe, screening, at):
        if (not isinstance(universe, list) or not universe or len(set(universe)) != len(universe)
                or any(not isinstance(s, str) or not s.endswith("USDT") for s in universe)):
            raise ValueError("Exact complete Testnet universe required")
        current = set(universe)
        self.state["queue"] = [s for s in self.state["queue"] if s in current]
        self.state["served"] = [s for s in self.state["served"] if s in current]
        known = set(self.state["queue"]) | set(self.state["served"])
        self.state["queue"].extend(sorted(current - known))
        # A newly observed universe starts a pass, not an alpha-filtered shortlist.
        if not self.state["universe"] or not self.state["queue"]:
            priority = []
            for key in HINT_KEYS:
                for symbol in screening.get(key) or []:
                    if symbol in current and symbol not in priority:
                        priority.append(symbol)
            self.state["queue"] = priority + sorted(current - set(priority))
            self.state["served"] = []
            self.state["pass"] += 1
        self.state.update(universe=list(universe), overviewObservedAt=at)
        self.save()

    def reserve(self, job_id, count, at, selection=None):
        if type(count) is not int or not 1 <= count <= 20:
            raise ValueError("Transport batch must be 1..20, not an eligibility limit")
        old = self.state["jobs"].get(job_id)
        if old:
            return copy.deepcopy(old)
        if any(j.get("outcome") is None for j in self.state["jobs"].values()):
            raise ValueError("Reconcile outstanding coverage job before another reservation")
        symbols = ([r['symbol'] for r in selection['selected']] if selection is not None else self.state["queue"][:count])
        if selection is not None and (len(symbols)>count or len(set(symbols))!=len(symbols)
                                      or not set(symbols)<=set(self.state['universe'])):
            raise ValueError('Dynamic selection outside complete universe or batch bound')
        if not symbols:
            raise ValueError("Observe universe before reserving an exhausted pass")
        row = {"id": job_id, "at": at, "pass": self.state["pass"], "symbols": symbols,
               "fetched": [], "delivered": [], "assessed": [], "unavailable": [],
               "outcome": None, "meaning": "BATCH_ONLY_NOT_MARKET_WIDE"}
        if selection is not None:row['selection']=copy.deepcopy(selection)
        self.state["jobs"][job_id] = row
        self.save()
        return copy.deepcopy(row)

    def progress(self, job_id, *, fetched=None, delivered=None, assessed=None, unavailable=None, outcome=None):
        row = copy.deepcopy(self.state["jobs"][job_id])
        updates = {"fetched": fetched, "delivered": delivered, "assessed": assessed, "unavailable": unavailable}
        if row.get("outcome") is not None:
            if outcome != row["outcome"] or any(v is not None and v != row[k] for k, v in updates.items()):
                raise ValueError("Completed coverage result is immutable")
            return copy.deepcopy(row)
        for key, value in updates.items():
            if value is not None:
                if len(set(value)) != len(value) or not set(value).issubset(row["symbols"]):
                    raise ValueError("Coverage symbols outside reserved batch")
                if not set(row[key]).issubset(value):
                    raise ValueError("Coverage facts cannot be removed")
                row[key] = list(value)
        if not set(row["delivered"]).issubset(row["fetched"]) or not set(row["assessed"]).issubset(row["delivered"]):
            raise ValueError("Assessment requires fetched and delivered evidence")
        if set(row["unavailable"]) & set(row["assessed"]):
            raise ValueError("Unavailable is not assessed")
        if outcome is not None:
            if outcome in ("PROVIDER_UNAVAILABLE", "TURN_BUDGET_EXHAUSTED") and row["assessed"]:
                raise ValueError("Provider/turn failure cannot fabricate completed assessment")
            row["outcome"] = outcome
            self.state["queue"] = [s for s in self.state["queue"] if s not in row["symbols"]]
            self.state["served"].extend(s for s in row["symbols"] if s not in self.state["served"])
        self.state["jobs"][job_id] = row
        self.save()
        return copy.deepcopy(row)


def fetch_histories(gateway, symbols, *, metadata_only=False):
    """Host fetch; same request list and exact continuation, never a model tool loop."""
    if not symbols or len(set(symbols)) != len(symbols):
        raise ValueError("Nonempty unique requested symbols required")
    offset, rows, last = 0, [], None
    while offset < len(symbols):
        request = {"symbols": symbols, "offset": offset}
        if metadata_only:
            request['contextMode'] = 'FORMATION_METADATA_V1'
        result = gateway("/context", request)
        if metadata_only and (result.get('contextMode') != 'FORMATION_METADATA_V1'
                              or result.get('marketDataComplete') is not False
                              or result.get('orderAuthority') is not False):
            raise ValueError('Explicit formation metadata gateway contract required')
        if (result.get("source") != "BINANCE_USDM_TESTNET"
                or result.get("status", {}).get("environment") != "testnet"):
            raise ValueError("Unverified Testnet context")
        page, current = result.get("historyPage") or {}, result.get("rows") or []
        end = offset + len(current)
        expected = end if end < len(symbols) else None
        if (not current or len(current) > 20 or end > len(symbols)
                or [r.get("symbol") for r in current] != symbols[offset:end]
                or page.get("offset") != offset or page.get("returned") != len(current)
                or page.get("nextOffset") != expected):
            raise ValueError("Incomplete or reordered history coverage")
        rows.extend(current)
        offset, last = end, result
    return {**({'contextMode':'FORMATION_METADATA_V1','marketDataComplete':False,'orderAuthority':False}
              if metadata_only else {}), "source": "BINANCE_USDM_TESTNET", "status": last["status"],
            "at": last.get("at"), "unavailableSymbols": last.get("unavailableSymbols", []), "rows": rows}


class FormationReader:
    """Single-flight read-only preparation. Parent alone reserves/dispatches jobs.

    Restart may discard an unfinished read, never an order or a model decision.
    The caller must refresh market rows before delivery and revalidate execution.
    """
    def __init__(self, gateway):
        self.gateway=gateway
        self.worker=None
        self.messages=queue.Queue()
        self.selection=None
        self.startedAt=None
        self.nextAt=0
        self.error=None

    def poll(self, selection, at):
        if self.worker is not None:
            if self.worker.is_alive():return None
            ok,value=self.messages.get_nowait()
            self.worker=None
            if not ok:
                self.error='CONTEXT_READ_FAILED';self.nextAt=at+60000
                return None
            if not isinstance(value.get('at'),(int,float)) or not 0 <= at-value['at'] <= 120000:
                self.error='CONTEXT_READ_STALE';self.nextAt=at+30000
                return None
            self.error=None
            return {'raw':value,'selection':self.selection,'startedAt':self.startedAt}
        if at < self.nextAt:return None
        symbols=[r['symbol'] for r in selection.get('selected',[])]
        if len(symbols)!=6 or len(set(symbols))!=6:
            raise ValueError('Six distinct host-selected formation symbols required')
        self.selection=copy.deepcopy(selection);self.startedAt=at
        def read():
            try:self.messages.put((True,fetch_histories(self.gateway,symbols,metadata_only=True)))
            except Exception:self.messages.put((False,None))
        self.worker=threading.Thread(target=read,daemon=True,name='formation-read-only')
        self.worker.start()
        return None

    def summary(self, at):
        return {'status':('PREPARING' if self.worker.is_alive() else 'READY_TO_DELIVER') if self.worker
                else 'BACKOFF' if at<self.nextAt else 'IDLE',
                'startedAt':self.startedAt,'elapsedMs':at-self.startedAt if self.worker else None,
                'error':self.error,'orderAuthority':False,'modelCalled':False}


def release_gate(manifest, *, current_hashes, gateway_status):
    """No fallback to an old runner or silent arm of a partial V8 build."""
    if manifest.get("cohortId") != COHORT or manifest.get("armed") is not True:
        raise ValueError("V8 is staged, not armed")
    if manifest.get("runtimeFiles") != current_hashes:
        raise ValueError("Runtime source fingerprint mismatch")
    if (gateway_status.get("laneId") != "ASTRA_HERMES_TESTNET"
            or gateway_status.get("environment") != "testnet"
            or gateway_status.get("executionVersion") != GATEWAY_VERSION):
        raise ValueError("Wrong gateway or missing final executable-price guard")
    capital = gateway_status.get("capital") or {}
    if (capital.get("mode") != "BINANCE_TESTNET_WALLET" or capital.get("maxEntryNotionalUsd") != 25
            or capital.get("maxOpenPositions", "MISSING") is not None
            or capital.get("totalLaneAllocationUsd", "MISSING") is not None
            or gateway_status.get("leverage") != 1 or gateway_status.get("dailyLossCap", "MISSING") is not None):
        raise ValueError("Protected capital policy mismatch")
    if not manifest.get("testsPassed") or not manifest.get("integrationVerified"):
        raise ValueError("V8 integration verification missing")
    return True
