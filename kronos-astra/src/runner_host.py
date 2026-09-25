"""Host-only activation, fixed loopback routing and cadence policy, never model-controlled."""
import json
from pathlib import Path


def host_config(root: Path) -> dict:
    return json.loads((root / "runner-config.json").read_text())


def gateway_base(root: Path) -> str:
    config = host_config(root)
    if config.get("enabled") is not True:
        raise RuntimeError("Runner disabled on this host; VPS is the sole active runner")
    port = config.get("gatewayPort")
    if type(port) is not int or port not in (3112, 43112):
        raise RuntimeError("Invalid Testnet loopback gateway port")
    return f"http://127.0.0.1:{port}"


def execution_config(root: Path):
    """Optional host execution overrides. Absent means the module defaults apply."""
    return host_config(root).get("execution") or {}


def cadence_config(root: Path):
    """Optional host cadence overrides. Absent means the module defaults apply."""
    return host_config(root).get("cadence")
