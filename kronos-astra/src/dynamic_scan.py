"""Single read-only background scan; parent alone commits state. No model/order calls."""
import json
import queue
import threading
import time
from pathlib import Path
from astra_v8_host import atomic_json
from dynamic_candidates import VERSION,INTERVAL_MS,MAX_SCAN_AGE_MS,observe,select

class DynamicScan:
    def __init__(self,root,gateway):
        self.path=Path(root)/'hermes-home/v8/dynamic-candidates.json'
        self.gateway=gateway;self.messages=queue.Queue();self.worker=None
        self.next_at=0;self.started_at=None;self.error=None
        self.state={};self.blocked=False
        try:
            loaded=json.loads(self.path.read_text()) if self.path.exists() else {}
            if loaded:
                if loaded.get('methodVersion')!=VERSION:raise ValueError('Unknown dynamic scan version')
                select(loaded,{},loaded['observedAt'])
            self.state=loaded
        except Exception as e:
            # Preserve corrupt evidence for diagnosis; block formation, not management.
            self.error='PERSISTED_SCAN_INVALID: '+str(e)[:400];self.blocked=True

    def _read(self):
        try:self.messages.put((True,self.gateway('/context',{'symbols':[]})))
        except Exception as e:self.messages.put((False,str(e)))

    def poll(self,at):
        if self.worker is not None and not self.worker.is_alive():
            try:
                ok,value=self.messages.get_nowait()
                if not ok:raise ValueError(value)
                updated=observe(value,self.state,at)
                atomic_json(self.path,updated);self.state=updated;self.error=None
            except Exception as e:
                self.error=str(e)[:500]
                self.next_at=max(self.next_at,at+INTERVAL_MS)
            self.worker=None
        if not self.blocked and self.worker is None and at>=self.next_at:
            self.started_at=at;self.next_at=at+INTERVAL_MS
            self.worker=threading.Thread(target=self._read,daemon=True,name='testnet-candidate-scan')
            self.worker.start()
        fresh=bool(self.state) and 0<=at-self.state['observedAt']<=MAX_SCAN_AGE_MS
        return {'methodVersion':VERSION,'status':'FRESH' if fresh else 'WARMING_UP_OR_STALE',
                'observedAt':self.state.get('observedAt'),'startedAt':self.started_at,
                'inFlight':self.worker is not None,'nextScanAt':self.next_at,'error':self.error,
                'universeN':len(self.state.get('universe',[])),
                'eligibleN':len(self.state.get('ranked',[])),
                'excludedN':len(self.state.get('excluded',{})),
                'rankingHash':self.state.get('rankingHash'),
                'meaning':'ATTENTION_ONLY; model cadence/budget unchanged; no alpha/entry permission'}

    def selection(self,coverage,at,exclude_symbols=()):
        return select(self.state,coverage,at,exclude_symbols=exclude_symbols)
