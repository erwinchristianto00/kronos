"""Read-only deployed capital/context proof; never sends a decision or exchange order."""
import json
from astra_runner import context_result, validate_capital_identity

context = json.loads(context_result({"symbols": []}))
status = context["status"]
validate_capital_identity(status)
assert status["wallet"]["fresh"], status["wallet"]
assert status["wallet"]["snapshot"]["walletBalance"] >= 0
assert "cashEquity" not in status and "initialEquity" not in status
assert context["contextVersion"] == "ASTRA_EXPERIMENT_CONTEXT_V2"
print(json.dumps({"readOnly": True, "capital": status["capital"], "wallet": status["wallet"],
                  "astraNet": status["net"], "openN": len(status["active"]),
                  "universeCount": len(context["universe"]), "overviewPage": context["overviewPage"]}))
