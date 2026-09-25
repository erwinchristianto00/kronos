"""Read-only model/authentication probe. Never imports a trading client."""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ["HERMES_HOME"] = str(ROOT / "hermes-home")
sys.path.insert(0, str(ROOT / "work/hermes-agent"))

from hermes_cli.runtime_provider import resolve_runtime_provider
from run_agent import AIAgent

runtime = resolve_runtime_provider(requested="openai-codex", target_model="gpt-6-astra")
agent = AIAgent(
    model="gpt-6-astra", provider=runtime["provider"],
    api_key=runtime["api_key"], base_url=runtime["base_url"], api_mode=runtime["api_mode"],
    reasoning_config={"enabled": True, "effort": "high"},
    enabled_toolsets=[], max_iterations=1, run_budget_seconds=90,
    skip_context_files=True, skip_memory=True, skip_background_review=True,
    quiet_mode=True, fallback_model=None,
)
if agent.model != "gpt-6-astra" or agent.provider != "openai-codex" or agent.tools:
    raise RuntimeError("Probe identity/tool isolation failed")
result = agent.run_conversation("Connection test only. Reply exactly ASTRA_CONNECTION_OK. Do not call tools.")
print(json.dumps({"model": agent.model, "provider": agent.provider,
                  "reasoning": agent.reasoning_config, "completed": result.get("completed"),
                  "response": result.get("final_response"), "api_calls": result.get("api_calls")}, default=str))
if not result.get("completed") or result.get("final_response", "").strip() != "ASTRA_CONNECTION_OK":
    raise SystemExit(1)
