"""Read-only, pre-decision evidence bridge. Never infers a fill or an alpha label."""
import copy
import hashlib
import json

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,allow_nan=False).encode()).hexdigest()

def decision_context(intent, actuality, job, quant_record=None, narrative_record=None):
    if (job.get('id') != intent.get('jobId') or job.get('fingerprint') != intent.get('fingerprint')
            or job.get('rawContext',{}).get('source') != 'BINANCE_USDM_TESTNET'
            or job.get('rawContext',{}).get('status',{}).get('environment') != 'testnet'
            or not isinstance(job.get('contextBuiltAt'),(int,float))
            or job['contextBuiltAt'] > intent['recordedAt']):
        raise ValueError('Decision provenance mismatch')
    args=intent.get('input',{});context=job.get('context',{})
    selected=set(args.get('assessedOpportunityIds',[]))
    selected.update(x for x in (args.get('setupId'),args.get('opportunityId')) if x)
    candidates=context.get('marketCandidates',[])+context.get('opportunities',[])
    chosen=[r for r in candidates if r.get('opportunityId') in selected]
    plan=args.get('plan')
    symbol_of=lambda r:r.get('symbol') or (r.get('frozenPlan') or {}).get('symbol')
    if plan and not any(symbol_of(r) == plan.get('symbol') for r in candidates):
        raise ValueError('Unselected plan symbol')
    if plan:
        chosen.extend(r for r in candidates if symbol_of(r)==plan.get('symbol') and r not in chosen)
    q={}
    if quant_record:
        if (quant_record.get('jobId') != job['id'] or quant_record.get('fingerprint') != intent['fingerprint']
                or quant_record.get('recordedAt',float('inf')) > intent['recordedAt']):
            raise ValueError('Quant provenance mismatch or hindsight')
        q=quant_record.get('snapshot',{})
    rows=[]
    for item in chosen[:8]:
        frozen=item.get('frozenPlan') or (plan if plan and symbol_of(item)==plan.get('symbol') else {})
        symbol=item.get('symbol') or frozen.get('symbol')
        measured=next((r for r in q.get('rows',[]) if r.get('symbol')==symbol),{})
        rows.append({'opportunityId':item.get('opportunityId'),'symbol':symbol,
            'side':frozen.get('side'), 'frozenPlan':copy.deepcopy(frozen) or None,
            'book':copy.deepcopy(item.get('book')), 'assessment':copy.deepcopy(item.get('assessment')),
            'marketContext':copy.deepcopy(measured.get('marketContext')),
            'costContext':copy.deepcopy(measured.get('costContext')),
            'strategyEvidence':copy.deepcopy(measured.get('strategyEvidence')),
            'dataQuality':{'status':measured.get('dataQuality',{}).get('status'),
                           'reasons':measured.get('dataQuality',{}).get('reasons',[])}})
    result=actuality.get('executionResult') or actuality.get('result') or {}
    out={'schemaVersion':'HERMES_DECISION_EVIDENCE_V1','jobId':job['id'],
         'episodeId':args.get('setupId') or (plan or {}).get('id') or job['id'],
         'contextBuiltAt':job['contextBuiltAt'],'decisionAt':intent['recordedAt'],
         'sourceJobHash':digest(job),'sourceIntentHash':digest(intent),
         'quantSnapshotHash':quant_record.get('snapshotHash') if quant_record else None,
         'reason':args.get('reason'),'reasonSource':'MODEL_RATIONALE_NOT_VERIFIED_CAUSALITY',
         'candidateReport':copy.deepcopy(intent.get('candidateReport')),
         'candidateSelection':copy.deepcopy(context.get('candidateSelection')),
         'assessedOpportunityIds':sorted(selected),'candidates':rows,
         'candidateCoverage':{'selectedN':len(chosen),'includedN':len(rows),
             'unresolvedIds':sorted(selected-{r.get('opportunityId') for r in chosen})},
         'hostOutcome':actuality.get('outcome'),
         'hostRejection':result.get('entry_error') or result.get('decision_error') or result.get('errorDetail') or result.get('error'),
         'reassessment':{k:copy.deepcopy(result.get(k)) for k in ('status','rootPlanId','childPlanId','attemptsUsed','changedFields')},
         'hostValidation':copy.deepcopy(result.get('hostValidation')),
         'portfolioContext':copy.deepcopy(q.get('portfolioContext')),
         'meaning':'PRE_DECISION_CONTEXT_NOT_FILL_OR_COUNTERFACTUAL_PROFIT'}
    roots={r.get('reassessment',{}).get('rootPlanId') for r in chosen if r.get('reassessment')}
    if narrative_record:
        value=narrative_record.get('snapshot') or {}
        if (narrative_record.get('jobId') != job['id'] or narrative_record.get('fingerprint') != intent['fingerprint']
                or narrative_record.get('recordedAt',float('inf')) > intent['recordedAt']
                or value.get('asOf',job['contextBuiltAt']) > job['contextBuiltAt']):
            raise ValueError('Narrative provenance mismatch or hindsight')
        out['narrativeEvidence']={k:copy.deepcopy(v) for k,v in value.items() if k!='rows'}
        out['narrativeEvidence']['rows']={symbol_of(r):copy.deepcopy(value.get('rows',{}).get(symbol_of(r))) for r in chosen[:8]}
        out['narrativeEvidence']['deliveredRecordHash']=digest(narrative_record)
        out['narrativeEvidence']['profitEffect']='UNPROVEN_NO_CAUSAL_COMPARISON'
    roots.discard(None)
    if len(roots)==1:out['episodeId']=next(iter(roots))
    if result.get('rootPlanId'):out['episodeId']=result['rootPlanId']
    if len(json.dumps(out))>22000:
        # Explicit bounded summary; full input is addressed by source hashes above.
        for r in out['candidates']:
            for key in ('marketContext','costContext'):
                if isinstance(r.get(key),dict):r[key].pop('dataQuality',None)
            reasons = r['dataQuality']['reasons']
            # Current quant contracts group reasons by dimension; legacy records
            # use a list. Preserve the type/keys, never reinterpret keys as reasons.
            if isinstance(reasons, dict):
                bounded = dict(list(reasons.items())[:8])
            elif isinstance(reasons, list):
                bounded = reasons[:8]
            else:
                bounded = reasons  # unknown shape is evidence, not a clean bill
            if bounded != reasons:
                r['dataQuality']['reasonsCompaction'] = {
                    'originalHash': digest(reasons), 'originalCount': len(reasons),
                    'retainedCount': len(bounded), 'meaning': 'BOUNDED_PROJECTION_NOT_COMPLETE'}
            r['dataQuality']['reasons'] = bounded
        out['summaryCompacted']=True
    # Exclude oversized fields explicitly instead of breaking the entire coaching
    # queue. Hashes retain provenance; absent details cannot become lesson support.
    while len(json.dumps(out))>24000 and out['candidates']:
        removed=out['candidates'].pop()
        out.setdefault('omittedCandidateIds',[]).append(removed['opportunityId'])
    if len(json.dumps(out))>24000:
        out['portfolioContext']=None
        out['portfolioOmitted']='CONTEXT_SIZE_LIMIT'
    if len(json.dumps(out))>24000 and out.get('candidateReport'):
        report=out['candidateReport']
        out['candidateReport']={'schemaVersion':report['schemaVersion'],
                                'reportingStatus':report['reportingStatus'],
                                'assessmentN':report['assessmentN'],
                                'omitted':'CONTEXT_SIZE_LIMIT_FULL_REPORT_IN_SOURCE_INTENT'}
    if len(json.dumps(out))>24000 and out.get('candidateSelection'):
        selection=out['candidateSelection']
        out['candidateSelection']={k:selection.get(k) for k in ('methodVersion','rankingHash','sourceHash','observedAt','selectedAt','meaning')}
        out['candidateSelection']['omitted']='CONTEXT_SIZE_LIMIT_FULL_SELECTION_IN_SOURCE_JOB'
    out['candidateCoverage']['includedN']=len(out['candidates'])
    return out
