"""Credential-free EWMA shadow observer. No model invocation or order capability."""
import argparse
import hashlib
import json
import math
import os
import sqlite3
import statistics
import time
import urllib.parse
import urllib.request
from pathlib import Path

VERSION='EWMA_SHADOW_V1_20260918'
STEP=300000
LAM=.94
SYMBOLS=('BTCUSDT','ETHUSDT','SOLUSDT')
HORIZONS=(1,12,72)
BASE='https://fapi.binance.com'
RECOVERY_VERSION='CONFIRMED_SOURCE_EPOCH_V2_20260921'
RECOVERY_COOLDOWN_MS=6*60*60*1000
INGESTION_VERSION='SETTLED_DOUBLE_READ_V1_20260921'
SETTLEMENT_LAG_MS=STEP


def now(): return int(time.time()*1000)


def public_get(route,params=None):
    if route not in ('/fapi/v1/time','/fapi/v1/klines'): raise ValueError('PUBLIC_ROUTE_NOT_ALLOWED')
    url=BASE+route+('?' + urllib.parse.urlencode(params) if params else '')
    with urllib.request.urlopen(url,timeout=15) as response:
        return json.loads(response.read(2000000))


def closed_bars(raw,asof):
    if not isinstance(raw,list): raise ValueError('INVALID_RESPONSE')
    bars=[r for r in raw if isinstance(r,list) and len(r)>=7 and int(r[6])<asof]
    if len(bars)<100: raise ValueError('INSUFFICIENT_WARMUP')
    last=None
    for r in bars:
        stamp=int(r[0]); o,h,l,c,v=map(float,r[1:6])
        if (stamp%STEP or int(r[6])!=stamp+STEP-1 or
                not all(math.isfinite(x) for x in (o,h,l,c,v)) or v<0 or
                not 0<l<=min(o,c)<=max(o,c)<=h or (last is not None and stamp!=last+STEP)):
            raise ValueError('INVALID_OR_NONCONTIGUOUS_CANDLES')
        last=stamp
    if bars[-1][0]!=(asof//STEP)*STEP-STEP: raise ValueError('STALE_OR_INCOMPLETE_CLOSED_CANDLES')
    return bars


def update_state(bars,previous):
    returns=[math.log(float(b[4])/float(a[4])) for a,b in zip(bars,bars[1:])]
    if previous is None:
        variance=statistics.mean(x*x for x in returns[:20])
        for r in returns[20:]: variance=LAM*variance+(1-LAM)*r*r
    else:
        anchor=next((i for i,r in enumerate(bars) if r[0]==previous['lastOpen']),None)
        if anchor is None: raise ValueError('STATE_GAP_REQUIRES_REVIEW')
        if float(bars[anchor][4])!=previous['lastClose']: raise ValueError('SOURCE_REVISION_REQUIRES_REVIEW')
        variance=previous['nextVariance']
        for r in returns[anchor:]: variance=LAM*variance+(1-LAM)*r*r
    rolling=statistics.variance(returns[-20:])
    if not all(math.isfinite(v) and v>0 for v in (variance,rolling)): raise ValueError('INVALID_VARIANCE')
    tr=[max(float(b[2])-float(b[3]),abs(float(b[2])-float(a[4])),abs(float(b[3])-float(a[4]))) for a,b in zip(bars[-15:],bars[-14:])]
    return {'lastOpen':bars[-1][0],'lastClose':float(bars[-1][4]),'nextVariance':variance,
            'rolling20Variance':rolling,'atr14Bps':statistics.mean(tr)/float(bars[-1][4])*10000}


def future_start(issued):
    # Never backdate a forecast into a partially observed bar. Leave >=5s to persist.
    return ((issued+5000)//STEP+1)*STEP


def connect(path):
    db=sqlite3.connect(path,timeout=10)
    db.row_factory=sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS state(symbol TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forecasts(
        symbol TEXT NOT NULL, origin INTEGER NOT NULL, horizon INTEGER NOT NULL,
        issued INTEGER NOT NULL, target_start INTEGER NOT NULL, target_end INTEGER NOT NULL,
        ewma REAL NOT NULL, rolling REAL NOT NULL, realized REAL,
        loss_delta REAL, scored_at INTEGER, outcome TEXT NOT NULL DEFAULT 'PENDING',
        PRIMARY KEY(symbol,origin,horizon));
      CREATE INDEX IF NOT EXISTS pending ON forecasts(symbol,outcome,target_end);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    ''')
    existing=db.execute("SELECT value FROM metadata WHERE key='method'").fetchone()
    if existing and existing[0]!=VERSION: raise ValueError('METHOD_STATE_MISMATCH')
    db.execute("INSERT OR IGNORE INTO metadata VALUES('method',?)",(VERSION,)); db.commit()
    if 'source_epoch' not in {r[1] for r in db.execute('PRAGMA table_info(forecasts)')}:
        db.execute('ALTER TABLE forecasts ADD COLUMN source_epoch INTEGER NOT NULL DEFAULT 0')
        db.commit()
    return db


def score(db,symbol,bars,at):
    realized_by_open={b[0]:math.log(float(b[4])/float(a[4]))**2 for a,b in zip(bars,bars[1:])}
    for f in db.execute("SELECT * FROM forecasts WHERE symbol=? AND outcome='PENDING' AND target_end<=?",(symbol,bars[-1][6])).fetchall():
        required=list(range(f['target_start'],f['target_end']+1,STEP))
        if any(t not in realized_by_open for t in required):
            db.execute("UPDATE forecasts SET outcome='UNKNOWN_MISSING_REALIZATION',scored_at=? WHERE symbol=? AND origin=? AND horizon=?",(at,symbol,f['origin'],f['horizon']))
            continue
        actual=sum(realized_by_open[t] for t in required)
        delta=math.log(f['ewma'])+actual/f['ewma']-math.log(f['rolling'])-actual/f['rolling']
        db.execute("UPDATE forecasts SET realized=?,loss_delta=?,scored_at=?,outcome='SCORED' WHERE symbol=? AND origin=? AND horizon=?",(actual,delta,at,symbol,f['origin'],f['horizon']))


def apply_observation(db,symbol,bars,issued):
    row=db.execute('SELECT payload FROM state WHERE symbol=?',(symbol,)).fetchone()
    state=update_state(bars,json.loads(row[0]) if row else None)
    target=future_start(issued)
    for h in HORIZONS:
        epoch=db.execute("SELECT value FROM metadata WHERE key='sourceEpoch'").fetchone()
        db.execute('INSERT OR IGNORE INTO forecasts(symbol,origin,horizon,issued,target_start,target_end,ewma,rolling,source_epoch) VALUES(?,?,?,?,?,?,?,?,?)',
                   (symbol,state['lastOpen'],h,issued,target,target+h*STEP-1,h*state['nextVariance'],h*state['rolling20Variance'],int(epoch[0]) if epoch else 0))
    db.execute('INSERT OR REPLACE INTO state VALUES(?,?)',(symbol,json.dumps(state,allow_nan=False)))
    score(db,symbol,bars,issued)
    return {**state,'symbol':symbol,'ewmaSigma5mBps':math.sqrt(state['nextVariance'])*10000,
            'rollingSigma5mBps':math.sqrt(state['rolling20Variance'])*10000,
            'informationThrough':bars[-1][6],
            'latestForecasts':[dict(r) for r in db.execute('SELECT * FROM forecasts WHERE symbol=? AND origin=? ORDER BY horizon',(symbol,state['lastOpen']))]}


def atomic_json(path,payload):
    temp=path.with_suffix('.tmp')
    with temp.open('w') as f:
        json.dump(payload,f,indent=2,allow_nan=False); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(temp,path)


def revision_recovery(db, inputs, asof, folder, fetch=public_get, *,
                      input_asof=None, reviewed=False):
    """Prepare a separate source vintage, never rewrite scored observations.

    Fail closed for gaps, invalid inputs, unstable double reads or rapid revisions.
    Caller applies the returned plan in the same transaction as new observations.
    """
    input_asof = asof if input_asof is None else input_asof
    previous={r['symbol']:json.loads(r['payload']) for r in db.execute('SELECT * FROM state')}
    changed=[]
    for symbol in SYMBOLS:
        closed_bars(inputs[symbol],input_asof)
        try: update_state(inputs[symbol],previous.get(symbol))
        except ValueError as exc:
            if str(exc)!='SOURCE_REVISION_REQUIRES_REVIEW': raise
            changed.append(symbol)
    if not changed: return None
    last=db.execute("SELECT value FROM metadata WHERE key='lastAutomaticRecoveryAt'").fetchone()
    if last and asof-int(last[0])<RECOVERY_COOLDOWN_MS and not reviewed:
        raise ValueError('SOURCE_REVISION_RECOVERY_COOLDOWN_REQUIRES_REVIEW')
    for symbol in SYMBOLS:
        second=closed_bars(fetch('/fapi/v1/klines',{'symbol':symbol,'interval':'5m',
            'startTime':inputs[symbol][0][0],'endTime':inputs[symbol][-1][6],'limit':1000}),input_asof)
        if second!=inputs[symbol]: raise ValueError('UNSTABLE_SOURCE_REVISION_REQUIRES_REVIEW')
    epoch=db.execute("SELECT value FROM metadata WHERE key='sourceEpoch'").fetchone()
    epoch=int(epoch[0])+1 if epoch else 1
    new={s:update_state(inputs[s],None) for s in SYMBOLS}
    evidence={'version':RECOVERY_VERSION,'sourceEpoch':epoch,'at':asof,
        'reason':'REVIEWED_CLOSED_CANDLE_SOURCE_REVISION' if reviewed else 'CONFIRMED_CLOSED_CANDLE_SOURCE_REVISION',
        'reviewed':reviewed,'ingestionVersion':INGESTION_VERSION,'changedSymbols':changed,
        'previousState':previous,'newState':new,'inputs':inputs,
        'meaning':'New source vintage only; old scores preserved; pending quarantined, not rescored.'}
    encoded=json.dumps(evidence,sort_keys=True,allow_nan=False).encode()
    digest=hashlib.sha256(encoded).hexdigest()
    atomic_json(folder/('source-epoch-'+str(epoch)+'-'+digest+'.json'),evidence)
    backup=folder/('before-source-epoch-'+str(epoch)+'.sqlite3')
    if backup.exists(): raise ValueError('RECOVERY_BACKUP_ALREADY_EXISTS_REVIEW_REQUIRED')
    with sqlite3.connect(backup) as target: db.backup(target)
    return {'epoch':epoch,'at':asof,'newState':new,'evidenceHash':digest}


def apply_recovery(db, plan):
    if plan is None: return
    db.execute("UPDATE forecasts SET outcome='UNKNOWN_SOURCE_REVISION',scored_at=? WHERE outcome='PENDING'",(plan['at'],))
    for symbol,state in plan['newState'].items():
        db.execute('INSERT OR REPLACE INTO state VALUES(?,?)',(symbol,json.dumps(state,allow_nan=False)))
    for key,value in [('sourceEpoch',str(plan['epoch'])),('lastAutomaticRecoveryAt',str(plan['at'])),
                      ('sourceRecoveryEvidenceHash',plan['evidenceHash'])]:
        db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',(key,value))


def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--state-dir',required=True)
    parser.add_argument('--review-source-revision',action='store_true',
        help='Explicit operator-reviewed recovery; double-read and immutable epoch evidence still required')
    args=parser.parse_args(); folder=Path(args.state_dir); folder.mkdir(parents=True,exist_ok=True)
    payload={'methodVersion':VERSION,'lambda':LAM,'mode':'SHADOW_OBSERVATION_ONLY',
             'executionAuthority':False,'modelInputChanged':False,'riskSizingChanged':False,
             'source':'BINANCE_USDM_PUBLIC_MARKET_DATA','scope':'ASTRA_TESTNET_RESEARCH_SIDECAR',
             'symbols':list(SYMBOLS),'horizonsBars':list(HORIZONS),'tickStartedAt':now(),
             'forecastTiming':'NEXT_FULL_FUTURE_BAR; no backdated current-bar forecast',
             'limitations':['NOT_ALPHA','NOT_TAIL_RISK_CALIBRATED','ONLY_3_VALIDATED_RESEARCH_SYMBOLS',
                            'MULTIBAR_OUTCOMES_OVERLAP_DO_NOT_TREAT_AS_INDEPENDENT',
                            '6H_HISTORICAL_UNDERFORECASTING_16_TO_20_PERCENT',
                            'FORWARD_TIMING_HAS_EXTRA_LEAD_VS_HISTORICAL_ZERO_LEAD_TEST'],
             'codeHash':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    payload.update(ingestionVersion=INGESTION_VERSION,settlementLagMs=SETTLEMENT_LAG_MS,
                   sourceStability='EXACT_DOUBLE_READ_NOT_A_GUARANTEE_AGAINST_FUTURE_REVISIONS')
    db=None
    try:
        asof=int(public_get('/fapi/v1/time')['serverTime'])
        if abs(now()-asof)>5000: raise ValueError('CLOCK_SKEW')
        # Avoid treating a just-closed exchange candle as settled. The forecast is
        # still issued prospectively; disclose the older information cutoff.
        input_asof=asof-SETTLEMENT_LAG_MS
        end=(input_asof//STEP)*STEP-1
        inputs={s:closed_bars(public_get('/fapi/v1/klines',{'symbol':s,'interval':'5m',
            'endTime':end,'limit':1000}),input_asof) for s in SYMBOLS}
        for s in SYMBOLS:
            second=closed_bars(public_get('/fapi/v1/klines',{'symbol':s,'interval':'5m',
                'startTime':inputs[s][0][0],'endTime':end,'limit':1000}),input_asof)
            if second!=inputs[s]: raise ValueError('UNSTABLE_SOURCE_RETRY_NEXT_TICK')
        issued=now()
        if issued-asof>60000: raise ValueError('SNAPSHOT_COLLECTION_TOO_SLOW')
        db=connect(folder/'shadow.sqlite3')
        recovery=revision_recovery(db,inputs,asof,folder,input_asof=input_asof,
                                   reviewed=args.review_source_revision)
        issued=now()
        if issued-asof>60000: raise ValueError('SNAPSHOT_COLLECTION_TOO_SLOW')
        with db:
            apply_recovery(db,recovery)
            observations=[apply_observation(db,s,inputs[s],issued) for s in SYMBOLS]
            if now()>=future_start(issued): raise ValueError('PERSIST_DEADLINE_MISSED')
            row=db.execute("SELECT value FROM metadata WHERE key='successfulTicks'").fetchone()
            ticks=int(row[0])+1 if row else 1
            db.execute("INSERT OR REPLACE INTO metadata VALUES('successfulTicks',?)",(str(ticks),))
        stats=[dict(r) for r in db.execute('SELECT symbol,horizon,outcome,source_epoch AS sourceEpoch,count(*) AS n,avg(loss_delta) AS meanQLIKEDelta FROM forecasts GROUP BY symbol,horizon,outcome,source_epoch ORDER BY source_epoch,symbol,horizon,outcome')]
        epoch=db.execute("SELECT value FROM metadata WHERE key='sourceEpoch'").fetchone()
        payload.update(sourceEpoch=int(epoch[0]) if epoch else 0,sourceEpochMeaning='Separate source vintages; previous epoch pending forecasts quarantined at reviewed source revision, never rescored.')
        payload.update(sourceRecoveryVersion=RECOVERY_VERSION,automaticRecovery=bool(recovery))
        payload.update(status='HEALTHY',lastSuccessfulTickAt=now(),successfulTicks=ticks,observations=observations,evaluation=stats)
        atomic_json(folder/'status.json',payload)
        print(json.dumps({'status':'HEALTHY','successfulTicks':ticks,'symbols':list(SYMBOLS),'at':payload['lastSuccessfulTickAt']}),flush=True)
    except Exception as exc:
        if db: db.rollback()
        payload.update(status='ERROR',failedAt=now(),errorType=type(exc).__name__,error=str(exc))
        atomic_json(folder/'status.json',payload)
        print(json.dumps({'status':'ERROR','error':str(exc)}),flush=True)
        raise
    finally:
        if db: db.close()


if __name__=='__main__': main()
