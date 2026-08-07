#!/usr/bin/env python3
"""Recover a timeout-interrupted immutable Binance CMS raw corpus.

This never refreshes or reinterprets an announcement catalogue.  It only fills
objects that are absent from a pre-existing immutable acquisition manifest, and
accepts a re-read from Binance only when its bytes match that manifest's
recorded SHA-256 and size exactly.  Existing GCS objects are re-hashed before
they are accepted.  This makes a timeout during the original per-file GCS
upload recoverable without changing the corpus identity or touching the large
Binance Vision archives.
"""

import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


HASH = set("0123456789abcdef")


def stable(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def shell(*args, capture=False):
    if capture:
        return subprocess.check_output(args, text=True)
    subprocess.check_call(args)


def require(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"LIFECYCLE_RECOVERY_ENV_REQUIRED_{name}")
    return value


def gcs_bytes(uri):
    return subprocess.check_output(["gcloud", "storage", "cat", uri])


def gcs_exists(uri):
    result = subprocess.run(["gcloud", "storage", "objects", "describe", uri, "--format=json"], text=True, capture_output=True)
    if result.returncode == 0:
        return json.loads(result.stdout)
    if "matched no objects" in result.stderr or "No URLs matched" in result.stderr:
        return None
    raise RuntimeError(f"LIFECYCLE_RECOVERY_GCS_DESCRIBE_FAILED_{uri}_{result.stderr.strip()}")


def read_verified_gcs(uri, expected):
    metadata = gcs_exists(uri)
    if metadata is None:
        return None
    if int(metadata.get("size", -1)) != expected["sizeBytes"]:
        raise RuntimeError(f"LIFECYCLE_RECOVERY_GCS_SIZE_CONFLICT_{expected['relativePath']}")
    payload = gcs_bytes(uri)
    if len(payload) != expected["sizeBytes"] or sha256(payload) != expected["fileHash"]:
        raise RuntimeError(f"LIFECYCLE_RECOVERY_GCS_HASH_CONFLICT_{expected['relativePath']}")
    return metadata


def official_headers():
    return {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "clienttype": "web",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.binance.com/en/support/announcement",
    }


def retrieve_exact(entry):
    for attempt in range(6):
        retrieved_at_ms = int(time.time() * 1000)
        try:
            response = urlopen(Request(entry["url"], headers=official_headers()), timeout=45)
            payload = response.read()
            status = response.status
            if status != 200:
                raise RuntimeError(f"LIFECYCLE_RECOVERY_HTTP_{status}_{entry['relativePath']}")
            if len(payload) != entry["sizeBytes"] or sha256(payload) != entry["fileHash"]:
                raise RuntimeError(f"LIFECYCLE_RECOVERY_SOURCE_IDENTITY_MISMATCH_{entry['relativePath']}")
            return payload, retrieved_at_ms, status
        except HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 5:
                raise RuntimeError(f"LIFECYCLE_RECOVERY_HTTP_{error.code}_{entry['relativePath']}") from error
        except (URLError, TimeoutError) as error:
            if attempt == 5:
                raise RuntimeError(f"LIFECYCLE_RECOVERY_NETWORK_FAILURE_{entry['relativePath']}") from error
        time.sleep(min(60, 5 * (2 ** attempt)))
    raise RuntimeError(f"LIFECYCLE_RECOVERY_UNREACHABLE_{entry['relativePath']}")


def immutable_upload(path, uri, entry):
    result = subprocess.run(["gcloud", "storage", "cp", str(path), uri, "--if-generation-match=0"], text=True, capture_output=True)
    if result.returncode:
        if read_verified_gcs(uri, entry) is None:
            raise RuntimeError(f"LIFECYCLE_RECOVERY_UPLOAD_FAILED_{entry['relativePath']}_{result.stderr.strip()}")
    if read_verified_gcs(uri, entry) is None:
        raise RuntimeError(f"LIFECYCLE_RECOVERY_UPLOAD_MISSING_{entry['relativePath']}")


def validate_manifest(manifest):
    if (
        manifest.get("schemaVersion") != "KronosBinanceCmsLifecycleRaw/v2"
        or manifest.get("status") != "RAW_CATALOG_ACQUIRED_NOT_A_TIMELINE"
        or manifest.get("provider") != "Binance"
        or manifest.get("exchange") != "BINANCE_USDM"
        or not isinstance(manifest.get("requests"), list)
        or len(manifest["requests"]) == 0
        or not isinstance(manifest.get("archiveBundleHash"), str)
        or len(manifest["archiveBundleHash"]) != 64
        or any(character not in HASH for character in manifest["archiveBundleHash"])
    ):
        raise RuntimeError("LIFECYCLE_RECOVERY_MANIFEST_INVALID")
    paths = set()
    previous = ""
    for entry in manifest["requests"]:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("relativePath"), str)
            or not entry["relativePath"]
            or entry["relativePath"] == "acquisition-manifest.json"
            or entry["relativePath"] in paths
            or entry["relativePath"] < previous
            or not isinstance(entry.get("url"), str)
            or not entry["url"].startswith("https://www.binance.com/bapi/composite/v1/public/cms/")
            or entry.get("httpStatus") != 200
            or not isinstance(entry.get("retrievedAtMs"), int)
            or not isinstance(entry.get("sizeBytes"), int)
            or entry["sizeBytes"] <= 0
            or not isinstance(entry.get("fileHash"), str)
            or len(entry["fileHash"]) != 64
            or any(character not in HASH for character in entry["fileHash"])
        ):
            raise RuntimeError("LIFECYCLE_RECOVERY_MANIFEST_REQUEST_INVALID")
        paths.add(entry["relativePath"])
        previous = entry["relativePath"]
    expected_bundle = sha256(stable([{"relativePath": entry["relativePath"], "fileHash": entry["fileHash"]} for entry in manifest["requests"]]).encode())
    if expected_bundle != manifest["archiveBundleHash"]:
        raise RuntimeError("LIFECYCLE_RECOVERY_MANIFEST_BUNDLE_INVALID")


def main():
    raw_root = require("_RAW_ROOT").rstrip("/")
    generation_sha = require("_GENERATION_SHA")
    if len(generation_sha) < 7 or any(character not in HASH for character in generation_sha.lower()):
        raise RuntimeError("LIFECYCLE_RECOVERY_GENERATION_SHA_INVALID")
    manifest_uri = f"{raw_root}/acquisition-manifest.json"
    manifest_bytes = gcs_bytes(manifest_uri)
    manifest = json.loads(manifest_bytes.decode("utf8"))
    validate_manifest(manifest)
    recovered = []
    retained = []
    work = pathlib.Path("/workspace/lifecycle-recovery")
    work.mkdir(parents=True, exist_ok=True)
    for entry in manifest["requests"]:
        remote = f"{raw_root}/{entry['relativePath']}"
        if read_verified_gcs(remote, entry) is not None:
            retained.append(entry["relativePath"])
            continue
        payload, retrieved_at_ms, status = retrieve_exact(entry)
        temporary = work / entry["relativePath"]
        temporary.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_bytes(payload)
        immutable_upload(temporary, remote, entry)
        recovered.append({"relativePath": entry["relativePath"], "retrievedAtMs": retrieved_at_ms, "httpStatus": status, "fileHash": entry["fileHash"]})
        # Binance accepts a steady request cadence; this only applies to the
        # small missing CMS JSON objects and never touches Binance Vision BBO.
        time.sleep(2)

    for entry in manifest["requests"]:
        if read_verified_gcs(f"{raw_root}/{entry['relativePath']}", entry) is None:
            raise RuntimeError(f"LIFECYCLE_RECOVERY_FINAL_OBJECT_MISSING_{entry['relativePath']}")
    core = {
        "schemaVersion": "KronosBinanceCmsLifecycleRecovery/v1",
        "status": "COMPLETE_EXACT_MANIFEST_BYTES_VERIFIED",
        "rawRoot": raw_root,
        "originalManifestSha256": sha256(manifest_bytes),
        "archiveBundleHash": manifest["archiveBundleHash"],
        "requestCount": len(manifest["requests"]),
        "retainedObjectCount": len(retained),
        "recoveredObjects": recovered,
        "generationToolSha": generation_sha,
    }
    recovery_hash = sha256(stable(core).encode())
    recovery = {**core, "recoveryHash": recovery_hash}
    recovery_path = work / "recovery-manifest.json"
    recovery_path.write_text(stable(recovery) + "\n", encoding="utf8")
    recovery_uri = f"{raw_root}/recovery-v1/{recovery_hash}.json"
    result = subprocess.run(["gcloud", "storage", "cp", str(recovery_path), recovery_uri, "--if-generation-match=0"], text=True, capture_output=True)
    if result.returncode:
        if gcs_bytes(recovery_uri) != recovery_path.read_bytes():
            raise RuntimeError("LIFECYCLE_RECOVERY_MARKER_CONFLICT")
    if gcs_bytes(recovery_uri) != recovery_path.read_bytes():
        raise RuntimeError("LIFECYCLE_RECOVERY_MARKER_RELOAD_FAILED")
    print(stable({"status": "PASS", "rawRoot": raw_root, "archiveBundleHash": manifest["archiveBundleHash"], "requestCount": len(manifest["requests"]), "retainedObjectCount": len(retained), "recoveredObjectCount": len(recovered), "recoveryHash": recovery_hash, "recoveryUri": recovery_uri}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
