# Rejection funnel

All **2884** normalized outcome records reconcile exactly once.

```json
{
  "MISSING_DECISION_SNAPSHOT": {
    "count": 2820,
    "pct": 97.7809
  },
  "NO_ELIGIBLE_PRE_OPEN_DECISION": {
    "count": 64,
    "pct": 2.2191
  }
}
```

The primary reason is the first unmet causal-chain stage; secondary deficiencies are preserved in raw source pointers and never silently used to change the primary bucket.
