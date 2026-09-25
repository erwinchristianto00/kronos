"""The two named decision policies and a read-only availability probe.

Astra's primary policy is `gpt-6-astra` at high reasoning on the existing
openai-codex subscription. The declared fallback is `claude-opus-5` at max
reasoning on Anthropic.

A fallback is a DIFFERENT decision policy, not a spare copy of the same one. The
same setup can be judged differently by a different model, so every record a
session produces carries the identity that produced it. Study arms count fallback
cycles rather than discarding them — the role is lane-global, so a switch lands on
both arms at once and cannot bias one against the other — and each arm reports the
policy composition that produced it, so a reader can still tell a strategy result
from a model result.

The host picks the role and freezes it into the job. A running session never
switches model mid-turn, and the model never chooses its own policy.

This module imports no trading client, opens no gateway and places no order. The
probe runs in its own process so a hung provider can never delay the host's
position poll or native protection.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

PRIMARY = "PRIMARY"
FALLBACK = "FALLBACK"
ROLES = (PRIMARY, FALLBACK)

POLICIES = {
    PRIMARY: {"role": PRIMARY, "model": "gpt-6-astra", "provider": "openai-codex", "effort": "high"},
    FALLBACK: {"role": FALLBACK, "model": "claude-opus-5", "provider": "anthropic", "effort": "max"},
}

# A probe answer older than this is not evidence about the provider right now.
PROBE_TTL_MS = 300000
PROBE_TIMEOUT_SECONDS = 120
PROBE_PROMPT = "Connection test only. Reply exactly ASTRA_CONNECTION_OK. Do not call tools."
PROBE_EXPECTED = "ASTRA_CONNECTION_OK"


def policy(role):
    if role not in POLICIES:
        raise ValueError("Unknown model role: " + str(role))
    return dict(POLICIES[role])


def identity(spec):
    """The exact triple that must match the constructed agent, in record form."""
    return {"modelRole": spec["role"], "model": spec["model"],
            "modelProvider": spec["provider"], "reasoningEffort": spec["effort"]}


def probe(role, *, root=None, timeout=PROBE_TIMEOUT_SECONDS, python=None, run_as=None):
    """Run one isolated, tool-free round trip. Returns a plain result dict.

    Never raises for an unavailable provider: absence of a credential and a dead
    provider are both ordinary answers here, and neither may take the host down.

    `root` is the RUNTIME directory that owns `work/hermes-agent` and `hermes-home`,
    which is not necessarily where this module sits — a staging copy probing the
    installed runtime is exactly the preflight case. `run_as` runs the probe as the
    service account so a token refresh cannot leave root-owned files in its profile.
    """
    root = Path(root or Path(__file__).resolve().parent)
    command = [python or sys.executable, "-B", str(Path(__file__).resolve()), "--role", role, "--probe"]
    if run_as:
        command = ["runuser", "-u", run_as, "--"] + command
    environment = {**os.environ, "ASTRA_RUNTIME_ROOT": str(root)}
    try:
        done = subprocess.run(command, cwd=str(root), capture_output=True, text=True,
                              timeout=timeout, env=environment)
    except subprocess.TimeoutExpired:
        return {"role": role, "available": False, "reason": "PROBE_TIMEOUT"}
    line = next((l for l in reversed(done.stdout.splitlines()) if l.strip().startswith("{")), "")
    try:
        return json.loads(line)
    except ValueError:
        return {"role": role, "available": False, "reason": "PROBE_NO_RESULT",
                "detail": (done.stderr or done.stdout)[-400:]}


def _run_probe(role):
    """In-process probe body; only ever reached in the dedicated subprocess."""
    spec = policy(role)
    # The runtime that owns the agent and its credential profile, which is not this
    # file's directory when a staged release probes the installed runtime.
    root = Path(os.environ.get("ASTRA_RUNTIME_ROOT") or Path(__file__).resolve().parent)
    os.environ.setdefault("HERMES_HOME", str(root / "hermes-home"))
    sys.path.insert(0, str(root / "work/hermes-agent"))
    from hermes_cli.runtime_provider import resolve_runtime_provider
    from run_agent import AIAgent

    runtime = resolve_runtime_provider(requested=spec["provider"], target_model=spec["model"])
    agent = AIAgent(model=spec["model"], provider=runtime["provider"], api_key=runtime["api_key"],
                    base_url=runtime["base_url"], api_mode=runtime["api_mode"],
                    reasoning_config={"enabled": True, "effort": spec["effort"]},
                    enabled_toolsets=[], max_iterations=1, run_budget_seconds=90,
                    skip_context_files=True, skip_memory=True, skip_background_review=True,
                    quiet_mode=True, fallback_model=None)
    try:
        # An agent that came back as a different model or with tools attached is not
        # the policy we asked about, so its answer says nothing about that policy.
        if agent.model != spec["model"] or agent.provider != spec["provider"] or agent.tools:
            return {**identity(spec), "role": role, "available": False, "reason": "PROBE_IDENTITY_MISMATCH",
                    "observedModel": agent.model, "observedProvider": agent.provider}
        result = agent.run_conversation(PROBE_PROMPT)
    finally:
        try:
            agent.close()
        except Exception:
            pass
    ok = bool(result.get("completed")) and str(result.get("final_response") or "").strip() == PROBE_EXPECTED
    return {**identity(spec), "role": role, "available": ok,
            "reason": "OK" if ok else "PROBE_INCOMPLETE",
            "apiCalls": result.get("api_calls")}


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", default=PRIMARY, choices=list(ROLES))
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    if not args.probe:
        print(json.dumps({"policies": POLICIES}, indent=2))
        return
    try:
        result = _run_probe(args.role)
    except BaseException as error:  # a missing credential is an answer, not a crash
        result = {"role": args.role, "available": False, "reason": "PROBE_ERROR",
                  "detail": str(error)[:400]}
    print(json.dumps(result))
    raise SystemExit(0 if result.get("available") else 1)


if __name__ == "__main__":
    main()
