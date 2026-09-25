import json,unittest
from astra_v8_runner import share_quant_metadata,context_chars,bounded_context
class BudgetTests(unittest.TestCase):
    def test_references_are_lossless(self):
        value={'scope':'symbol-independent','uncertainty':'UNKNOWN','data':'x'*350}
        ctx={'quantEvidence':{'snapshot':{'rows':[{'symbol':s,'strategyEvidence':dict(value)} for s in ('A','B')]}}}
        original=json.loads(json.dumps(ctx));share_quant_metadata(ctx)
        for row in ctx['quantEvidence']['snapshot']['rows']:
            row['strategyEvidence']=ctx['quantEvidence']['snapshot']['sharedMetadata'][row['strategyEvidence']['$quantRef']]
        ctx['quantEvidence']['snapshot'].pop('sharedMetadata');ctx['quantEvidence']['snapshot'].pop('referenceContract')
        self.assertEqual(ctx['quantEvidence'],original['quantEvidence'])
    def test_distinct_scopes_not_shared(self):
        ctx={'quantEvidence':{'snapshot':{'rows':[{'strategyEvidence':{'scope':s,'data':'x'*350}} for s in ('A','B')]}}}
        share_quant_metadata(ctx);self.assertNotIn('sharedMetadata',ctx['quantEvidence']['snapshot'])
    def test_repeat_compaction_preserves_references(self):
        ctx={'quantEvidence':{'snapshot':{'rows':[{'strategyEvidence':{'scope':'same','data':'x'*350}} for _ in range(2)]}}}
        share_quant_metadata(ctx)
        before=json.loads(json.dumps(ctx));share_quant_metadata(ctx)
        self.assertEqual(ctx,before)
        for row in ctx['quantEvidence']['snapshot']['rows']:
            row['costContext']={'dataQuality':{'status':'DEGRADED','explanation':'y'*350}}
        share_quant_metadata(ctx)
        shared=ctx['quantEvidence']['snapshot']['sharedMetadata']
        self.assertEqual(shared['q0'],before['quantEvidence']['snapshot']['sharedMetadata']['q0'])
        for row in ctx['quantEvidence']['snapshot']['rows']:
            self.assertEqual(shared[row['costContext']['dataQuality']['$quantRef']]['status'],'DEGRADED')
    def test_nested_unknown_reasons_preserved(self):
        reason=['UNKNOWN_MISSING_OBSERVATION']*30
        ctx={'quantEvidence':{'snapshot':{'rows':[{'dataQuality':{'reasons':reason[:]}} for _ in range(3)]}}}
        share_quant_metadata(ctx);s=ctx['quantEvidence']['snapshot']
        for row in s['rows']:self.assertEqual(s['sharedMetadata'][row['dataQuality']['reasons']['$quantRef']],reason)
    def test_wire_length(self):
        c={'a':[{'b':1}]*100};self.assertEqual(context_chars(c),len(json.dumps(c,separators=(',',':'))))
    def test_still_rejects_genuinely_oversize(self):
        with self.assertRaises(Exception):bounded_context({'data':'x'*65000})
if __name__=='__main__':unittest.main()
