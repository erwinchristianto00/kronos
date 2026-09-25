"""Read-only deployed transport/inline-budget proof; no model or decision call."""
import json
from astra_runner import context_result

seen = []
offset = 0
lengths = []
while offset is not None:
    response = context_result({"symbols": [], "overviewOffset": offset})
    lengths.append(len(response))
    context = json.loads(response)
    assert context["contextVersion"] == "ASTRA_EXPERIMENT_CONTEXT_V2"
    assert context["status"]["environment"] == "testnet"
    seen.extend(row[0] for row in context["overview"]["rows"])
    offset = context["overviewPage"]["nextOffset"]
assert seen == context["universe"]
selected = json.loads(context_result({"symbols": ["DOGEUSDT"]}))
economics = selected["rows"][0]["economics"]
assert economics["commission"]["status"] == "AVAILABLE"
assert economics["bookFresh"] and economics["feeAndSpreadBps"] is not None
assert economics["funding"]["status"] == "INDICATIVE"
print(json.dumps({"readOnly": True, "universeCount": len(seen), "inlinePageChars": lengths,
                  "screening": context["screening"], "sampleSymbol": "DOGEUSDT", "economics": economics}))
