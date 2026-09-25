"""Probe every declared policy and report what the providers actually accept.

One isolated, tool-free round trip per policy. This answers §19: are these exact model
identifiers real, and is each declared reasoning effort accepted? A provider that is
out of quota answers 429 before the effort is ever exercised, so its effort stays
UNVERIFIED rather than being reported as accepted.

Reveals no credential: only the model id, the effort and the provider's verdict.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import astra_router_v9 as ROUTER

PROMPT = "Connection test only. Reply exactly ASTRA_CONNECTION_OK. Do not call tools."
EXPECTED = "ASTRA_CONNECTION_OK"
TIMEOUT = 180


def _probe(spec):
    root = Path(os.environ.get("ASTRA_RUNTIME_ROOT") or Path(__file__).resolve().parent)
    os.environ.setdefault("HERMES_HOME", str(root / "hermes-home"))
    sys.path.insert(0, str(root / "work/hermes-agent"))
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from run_agent import AIAgent

    runtime = resolve_runtime_provider(requested=spec["provider"], target_model=spec["model"])
    agent = AIAgent(model=spec["model"], provider=runtime["provider"], api_key=runtime["api_key"],
                    base_url=runtime["base_url"], api_mode=runtime["api_mode"],
                    reasoning_config={"enabled": True, "effort": spec["effort"]},
                    enabled_toolsets=[], max_iterations=1, run_budget_seconds=120,
                    skip_context_files=True, skip_memory=True, skip_background_review=True,
                    quiet_mode=True, fallback_model=None)
    try:
        if agent.model != spec["model"] or agent.provider != spec["provider"] or agent.tools:
            return {"available": False, "reason": "PROBE_IDENTITY_MISMATCH",
                    "observedModel": agent.model, "observedProvider": agent.provider}
        result = agent.run_conversation(PROMPT)
    finally:
        try:
            agent.close()
        except Exception:
            pass
    ok = bool(result.get("completed")) and str(result.get("final_response") or "").strip() == EXPECTED
    error = str(result.get("error") or "")
    return {"available": ok, "reason": "OK" if ok else (ROUTER.classify_provider_error(error)
                                                        or "PROBE_INCOMPLETE"),
            "providerError": error[:160] or None, "apiCalls": result.get("api_calls")}


def main():
    if "--one" in sys.argv:
        task, role = sys.argv[sys.argv.index("--one") + 1].split("/")
        spec = ROUTER.policy(task, role)
        try:
            print(json.dumps({**ROUTER.identity(spec), **_probe(spec)}))
        except BaseException as error:  # a missing credential is an answer, not a crash
            print(json.dumps({**ROUTER.identity(spec), "available": False,
                              "reason": "PROBE_ERROR", "providerError": str(error)[:160]}))
        return
    rows = []
    for task, role in ROUTER.POLICIES:
        done = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()),
                               "--one", task + "/" + role], capture_output=True, text=True,
                              timeout=TIMEOUT, env={**os.environ})
        line = next((l for l in reversed(done.stdout.splitlines()) if l.strip().startswith("{")), "")
        try:
            rows.append(json.loads(line))
        except ValueError:
            rows.append({"taskType": task, "modelRole": role, "available": False,
                         "reason": "PROBE_NO_RESULT", "providerError": (done.stderr or "")[-160:]})
    for r in rows:
        # An effort is only "accepted" if a call at that effort actually completed.
        r["effortVerified"] = bool(r.get("available"))
    print(json.dumps(rows, indent=2))
    print("\nSUMMARY")
    for r in rows:
        print("  %-12s %-10s %-14s effort=%-7s %s%s" % (
            r.get("taskType"), r.get("modelRole"), r.get("model"), r.get("reasoningEffort"),
            "ACCEPTED" if r["effortVerified"] else "UNVERIFIED (" + str(r.get("reason")) + ")",
            "" if r["effortVerified"] else ""))


if __name__ == "__main__":
    main()
