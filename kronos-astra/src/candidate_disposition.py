"""Candidate dispositions. Supervisor may schedule WATCH reassessment, never orders."""
import copy
import math

VERSION='CANDIDATE_DISPOSITION_V3_WATCH_REASSESSMENT'
REASONS=('ENTRY_DISPLACEMENT','COST','NO_STRUCTURE','LOW_CONVICTION','DATA_QUALITY','RISK','OTHER')
TEXT={'type':'string','minLength':10,'maxLength':1200}
# One authority for both the advertised JSON schema and host validation.
CONDITION_OPERATORS={'executableSpreadBps':('LTE',),
                     'executablePrice':('LTE','GTE','BETWEEN'),
                     'closedCandleTime':('GT',)}
CONDITION={'type':'object','additionalProperties':False,
    'required':['metric','operator','value','basis'],
    'properties':{'metric':{'type':'string','enum':['executableSpreadBps','executablePrice','closedCandleTime']},
        'operator':{'type':'string','enum':sorted({o for ops in CONDITION_OPERATORS.values() for o in ops})},
        'value':{'type':'number'},'upperValue':{'type':'number'},'basis':TEXT},
    'oneOf':[{'properties':{'metric':{'const':metric},'operator':{'const':op},
                            'value':{'minimum':0} if metric=='executableSpreadBps' else {'exclusiveMinimum':0}},
              **({'required':['upperValue'],'properties':{'metric':{'const':metric},'operator':{'const':op},
                   'value':{'exclusiveMinimum':0},'upperValue':{'exclusiveMinimum':0}}}
                 if op=='BETWEEN' else {'not':{'required':['upperValue']}})}
             for metric,ops in CONDITION_OPERATORS.items() for op in ops]}
SCHEMA={'type':'array','maxItems':32,'items':{'type':'object','additionalProperties':False,
    'required':['opportunityId','symbol','candidateDisposition','reasonCode','reason'],
    'properties':{'opportunityId':{'type':'string'},'symbol':{'type':'string'},
        'candidateDisposition':{'type':'string','enum':['WATCH','NO_TRADE']},
        'reasonCode':{'type':'string','enum':list(REASONS)},'reason':TEXT,
        'revisitCondition':CONDITION,'expiresAt':{'type':'number'},'invalidation':TEXT},
    'oneOf':[
        {'properties':{'candidateDisposition':{'const':'WATCH'}},
         'required':['revisitCondition','expiresAt','invalidation']},
        {'properties':{'candidateDisposition':{'const':'NO_TRADE'}},
         'not':{'anyOf':[{'required':[k]} for k in ('revisitCondition','expiresAt','invalidation')]}}
    ]}}
RULES='''CANDIDATE CLASSIFICATION (report-only, no new execution authority):
For every assessedOpportunityId in a NO_TRADE decision supply candidateAssessments,
one row per exact supplied candidate ID and symbol. candidateDisposition is WATCH
when a possible hypothesis needs a concrete change, NO_TRADE when no defensible
setup exists. Use reasonCode and a specific per-symbol reason, not one batch reason.
Keep each reason to 1-2 concise sentences: one observed fact and the specific
geometry/timing contradiction. Do not recite the whole Quant snapshot. For COST,
past momentum or ATR is not expected future return; do not subtract fees from it
to invent an expected margin. If no target/stop was formed, say so explicitly.
WATCH requires revisitCondition {metric, operator, value, basis}, expiresAt (future
Unix milliseconds), and invalidation. Metrics: executableSpreadBps/LTE,
executablePrice/LTE (at or below), executablePrice/GTE (at or above),
executablePrice/BETWEEN with upperValue, or closedCandleTime/GT. upperValue is only
allowed for BETWEEN; prices must be positive and BETWEEN upperValue > value. Derive review
conditions from observed structure or existing limits and explain the basis;
do not invent a magic threshold, weaken cost/risk gates, or claim an order was
scheduled. If no defensible concrete condition exists, use NO_TRADE instead.
NO_TRADE must OMIT revisitCondition, expiresAt and invalidation (not null).
Derive expiry from the supplied contextBuiltAt Unix-millisecond clock, never from
an imagined calendar date. Host assessedAt is the validation clock; a stale expiry
is rejected, not silently extended. Inspect returned candidateReport issues.
WATCH is NOT astra_decide WAIT and does not create a frozen plan or order.
After a confirmed host report, the supervisor registers a durable watch. Fresh
trigger matches schedule model reassessment, in addition to six new candidates;
expiry, cooldown, existing plans/positions and model budget still apply. A price
condition must hold for both bid and ask because WATCH has no executable side.
For watchReassessment candidates recheck the original thesis and textual
invalidation first. NO_TRADE closes the watch; renewed WATCH requires a fresh
defensible condition/expiry. Entry still requires a new explicit plan/ENTER and
all unchanged host/gateway guards. Never infer that a watch trigger is entry permission.
Keep operational action NO_TRADE for this no-order decision. The host reports its
execution result separately. Do not add candidateAssessments to ENTER/management
or plan WAIT/REPLAN/ABANDON calls. Continue using their unchanged contracts.
MARKET_STATE_ONLY does not prove continuation odds, win probability, expectancy or
absence of edge. Explain timing/geometry relative to available evidence; do not
convert Z-score into a probability or a prediction. estimatedNetEdge stays UNKNOWN.
Use the host candidateReport result as authority: if reporting is INCOMPLETE,
say so and name the UNKNOWN rows. Do not claim every WATCH was accepted.
The tool record already contains per-symbol disposition, reason, review condition,
expiry and invalidation. Do not repeat those fields in a second final narrative.
Final response only references host receipts, at most three short lines;
BATCH_ACTION NO_NEW_POSITION only if no entry actually occurred.
'''

def number(x):
    return type(x) in (int,float) and math.isfinite(x)

def text_ok(x):
    return isinstance(x,str) and 10<=len(x.strip())<=1200

def build_report(args,context,at):
    """Bad/missing reporting is explicit UNKNOWN, never an execution exception."""
    if args.get('action')!='NO_TRADE':return None
    candidates={r['opportunityId']:r.get('symbol') or (r.get('frozenPlan') or {}).get('symbol')
                for r in context.get('marketCandidates',[])+context.get('opportunities',[])}
    selected=list(dict.fromkeys(args.get('assessedOpportunityIds',[])))
    if not selected:return None
    supplied=args.get('candidateAssessments',[])
    rows=supplied if isinstance(supplied,list) and len(supplied)<=32 else []
    issues=[];result=[]
    if not isinstance(supplied,list) or len(supplied)>32:issues.append('INVALID_ASSESSMENT_ARRAY')
    if any(not isinstance(r,dict) or r.get('opportunityId') not in selected for r in rows):
        issues.append('UNASSESSED_OR_INVALID_ROW')
    for oid in selected:
        matches=[r for r in rows if isinstance(r,dict) and r.get('opportunityId')==oid]
        failures=[];r=matches[0] if len(matches)==1 else {}
        if len(matches)!=1:failures.append('MISSING_OR_DUPLICATE_ASSESSMENT')
        if r.get('symbol')!=candidates.get(oid):failures.append('SYMBOL_MISMATCH')
        if set(r)-set(SCHEMA['items']['properties']):failures.append('UNSUPPORTED_FIELDS')
        if r.get('candidateDisposition') not in ('WATCH','NO_TRADE'):failures.append('INVALID_DISPOSITION')
        if r.get('reasonCode') not in REASONS or not text_ok(r.get('reason')):failures.append('INVALID_REASON')
        if r.get('candidateDisposition')=='WATCH':
            c=r.get('revisitCondition');c=c if isinstance(c,dict) else {}
            pair=(c.get('metric'),c.get('operator'))
            valid=isinstance(pair[0],str) and isinstance(pair[1],str) and pair[1] in CONDITION_OPERATORS.get(pair[0],())
            valid=valid and number(c.get('value')) and c['value']>=0 and text_ok(c.get('basis'))
            if pair[0]!='executableSpreadBps':valid=valid and c.get('value',0)>0
            valid=valid and not set(c)-set(CONDITION['properties'])
            if c.get('operator')=='BETWEEN':
                valid=valid and number(c.get('upperValue')) and c['upperValue']>c['value']>0
            elif 'upperValue' in c:valid=False
            if not valid:failures.append('INVALID_REVISIT_CONDITION')
            if not number(r.get('expiresAt')) or r['expiresAt']<=at:failures.append('INVALID_EXPIRY')
            if not text_ok(r.get('invalidation')):failures.append('MISSING_INVALIDATION')
        elif any(k in r for k in ('revisitCondition','expiresAt','invalidation')):
            failures.append('NO_TRADE_HAS_WATCH_FIELDS')
        value={'opportunityId':oid,'symbol':candidates.get(oid),'reportingStatus':'INCOMPLETE' if failures else 'COMPLETE',
               'candidateDisposition':'UNKNOWN' if failures else r['candidateDisposition'],
               'issues':failures,'estimatedNetEdge':'UNKNOWN',
               'evidenceStatus':'MARKET_STATE_ONLY','meaning':'MODEL_ASSESSMENT_NOT_VALIDATED_ALPHA'}
        if not failures:value.update(copy.deepcopy(r))
        result.append(value)
    return {'schemaVersion':VERSION,'decisionId':args.get('id'),'assessedAt':at,
            'reportingStatus':'COMPLETE' if not issues and all(not r['issues'] for r in result) else 'INCOMPLETE',
            'issues':issues,'candidates':result,'assessmentN':len(result),'batchIntent':'NO_NEW_POSITION',
            'executionAuthority':False,'automaticallyScheduled':False}

def cycle_reports(records,job_id,actions):
    reports=[]
    for r in records:
        if r.get('kind')!='DECISION_INTENT' or r.get('jobId')!=job_id or not r.get('candidateReport'):continue
        outcomes=[a for a in actions if a.get('decisionId')==r['decisionId']]
        outcome=outcomes[-1].get('outcome') if outcomes else None
        reports.append({**copy.deepcopy(r['candidateReport']),
                        'decisionExecutionOutcome':'NO_NEW_POSITION' if outcome=='VALID_NO_TRADE' else 'UNCONFIRMED',
                        'hostOutcome':outcome})
    return reports

def render_reports(reports):
    lines=['PER-SYMBOL CANDIDATE ASSESSMENTS (WATCH can queue reassessment; never an order or automatic entry):']
    for report in reports:
        confirmed = report['decisionExecutionOutcome']=='NO_NEW_POSITION'
        display_status=report['reportingStatus'] if confirmed else 'INCOMPLETE'
        lines.append('Decision '+str(report['decisionId'])+': '+report['decisionExecutionOutcome']+'; reporting '+display_status)
        if not confirmed:
            lines.append('Schema '+report['reportingStatus']+' but execution unconfirmed; WATCH proposals are NOT registered.')
        for r in report['candidates']:
            lines.append(str(r['symbol'])+' | '+r['candidateDisposition']+' | '+str(r.get('reasonCode','UNKNOWN'))+' | '+str(r.get('reason',r['issues'])))
            if r['candidateDisposition']=='WATCH':
                lines.append('REVIEW '+str(r['revisitCondition'])+'; expiresAt '+str(r['expiresAt'])+'; INVALIDATION '+r['invalidation'])
    lines.append('Statistical edge UNKNOWN. Raw model rationale is not validated probability.')
    return '\n'.join(lines)
