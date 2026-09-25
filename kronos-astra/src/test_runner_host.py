import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from runner_host import gateway_base
import astra_runner


class HostTests(unittest.TestCase):
    def test_missing_config_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                gateway_base(Path(directory))

    def test_disabled_and_non_boolean_values_fail_closed(self):
        for enabled in (False, None, 1, "true"):
            with self.subTest(enabled=enabled), patch.object(Path, "read_text", return_value=json.dumps({"enabled": enabled, "gatewayPort": 3112})):
                with self.assertRaises(RuntimeError):
                    gateway_base(Path("unused"))

    def test_only_explicit_loopback_ports(self):
        for port in (3112, 43112):
            with patch.object(Path, "read_text", return_value=json.dumps({"enabled": True, "gatewayPort": port})):
                self.assertEqual(gateway_base(Path("unused")), f"http://127.0.0.1:{port}")
        for port in (3103, "3112", True, 80, None):
            with patch.object(Path, "read_text", return_value=json.dumps({"enabled": True, "gatewayPort": port})):
                with self.assertRaises(RuntimeError):
                    gateway_base(Path("unused"))

    def test_disabled_gateway_never_reads_secret_or_opens_network(self):
        with patch.object(astra_runner, "gateway_base", side_effect=RuntimeError("disabled")), patch.object(Path, "read_text") as read, patch.object(astra_runner.urllib.request, "urlopen") as send:
            with self.assertRaises(RuntimeError):
                astra_runner.gateway("/decision", {"action": "OPEN"})
            read.assert_not_called()
            send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
