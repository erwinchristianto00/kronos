#!/usr/bin/env python3
"""
Phase-1B Step 1 — reacquire the FROZEN Tier-A corpus (BTCUSDT/ETHUSDT, 2026-01..06) from the free public
data.binance.vision dump. NOT an authenticated exchange API; NOT Level-2 data.

Rules (operator-frozen):
- exact original URLs; verify every SHA-256 against the frozen manifest (1h klines) or Binance's .CHECKSUM sidecar;
- REJECT any file whose checksum differs (do not silently substitute a newer file);
- extract into collision-safe dirs; raw files kept read-only; download date recorded separately from market ts.

Primary (verified vs FROZEN manifest): 1h klines (12 files). Archival (verified vs Binance .CHECKSUM): markPrice 1h,
fundingRate, 15m klines. On any unavailability or mismatch: STOP and report (non-zero exit).
"""
import hashlib, json, os, ssl, stat, sys, time, urllib.request, zipfile
from pathlib import Path

BASE = "https://data.binance.vision/data/futures/um/monthly"
SYMBOLS = ["BTCUSDT", "ETHUSDT"]
MONTHS = ["01", "02", "03", "04", "05", "06"]
YEAR = "2026"
API_DIR = Path(__file__).resolve().parent.parent
DATA = API_DIR / "artifacts" / "simulation" / "data"
RAW = DATA / "raw"
EXTRACT = DATA / "extracted"
FROZEN_MANIFEST = API_DIR / "artifacts" / "replay" / "tier-a-proof" / "6mo" / "data-manifest.json"

def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def fetch(url: str, dest: Path, retries=3) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    ctx = ssl.create_default_context()
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=60, context=ctx) as r, open(dest, "wb") as f:
                f.write(r.read())
            return True
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return False  # genuinely unavailable
            time.sleep(1.5 * (attempt + 1))
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return False

def parse_checksum_sidecar(p: Path) -> str:
    # Binance .CHECKSUM lines: "<sha256>  <filename>"
    txt = p.read_text().strip().split()
    return txt[0] if txt else ""

def ro(p: Path):
    try: os.chmod(p, stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)
    except Exception: pass

def main():
    frozen = json.loads(FROZEN_MANIFEST.read_text())
    frozen_by_file = {e["file"]: e for e in frozen.get("entries", [])}  # e.g. "BTCUSDT-1h-2026-01/..csv"
    manifest = {
        "reacquiredAtProcessingMs": int(time.time() * 1000),
        "provider": "data.binance.vision (free public dump; NOT authenticated; NOT L2)",
        "period": "2026-01..06", "symbols": SYMBOLS, "year": YEAR,
        "frozenManifestHash": frozen.get("manifestHash"),
        "datasets": [], "rejections": [], "unavailable": [],
    }

    # dataset specs: (key, url_infix, has_interval, verify_vs_frozen)
    specs = [
        ("klines_1h", "klines", "1h", True),        # PRIMARY — verified vs frozen manifest
        ("markPriceKlines_1h", "markPriceKlines", "1h", False),
        ("fundingRate", "fundingRate", None, False),
        ("klines_15m", "klines", "15m", False),      # archival (frozen timeframe)
    ]

    ok = True
    for key, infix, interval, verify_frozen in specs:
        for sym in SYMBOLS:
            for mm in MONTHS:
                if interval:
                    fname = f"{sym}-{interval}-{YEAR}-{mm}.zip"
                    url = f"{BASE}/{infix}/{sym}/{interval}/{fname}"
                    stem = f"{sym}-{interval}-{YEAR}-{mm}"
                    ext_dir = EXTRACT / key / sym / interval / stem
                    raw_sub = RAW / key / sym / interval
                else:
                    fname = f"{sym}-fundingRate-{YEAR}-{mm}.zip"
                    url = f"{BASE}/{infix}/{sym}/{fname}"
                    stem = f"{sym}-fundingRate-{YEAR}-{mm}"
                    ext_dir = EXTRACT / key / sym / stem
                    raw_sub = RAW / key / sym
                zip_dest = raw_sub / fname
                chk_dest = raw_sub / (fname + ".CHECKSUM")

                if not fetch(url, zip_dest):
                    manifest["unavailable"].append({"dataset": key, "url": url})
                    if verify_frozen:
                        ok = False  # a PRIMARY file being unavailable is fatal
                    continue
                got_checksum = fetch(url + ".CHECKSUM", chk_dest)
                zip_sha = sha256_file(zip_dest)
                # 1) verify zip vs Binance .CHECKSUM sidecar
                sidecar_ok = None
                if got_checksum:
                    want = parse_checksum_sidecar(chk_dest)
                    sidecar_ok = (want.lower() == zip_sha.lower())
                    if not sidecar_ok:
                        manifest["rejections"].append({"dataset": key, "file": fname, "reason": "zip sha256 != .CHECKSUM sidecar", "got": zip_sha, "want": want})
                        ok = False
                        continue
                # extract CSV
                ext_dir.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(zip_dest) as z:
                    names = z.namelist()
                    z.extractall(ext_dir)
                csv_name = names[0]
                csv_path = ext_dir / csv_name
                csv_sha = sha256_file(csv_path)
                # 2) verify extracted CSV vs FROZEN manifest (primary klines only)
                frozen_ok = None
                if verify_frozen:
                    fkey = f"{stem}/{csv_name}"
                    fe = frozen_by_file.get(fkey)
                    if fe is None:
                        manifest["rejections"].append({"dataset": key, "file": fkey, "reason": "not in frozen manifest"})
                        ok = False
                        continue
                    frozen_ok = (fe["sha256"].lower() == csv_sha.lower())
                    if not frozen_ok:
                        manifest["rejections"].append({"dataset": key, "file": fkey, "reason": "extracted CSV sha256 != FROZEN manifest", "got": csv_sha, "want": fe["sha256"]})
                        ok = False
                        continue
                ro(zip_dest); ro(csv_path)
                # row/time bounds (causal): parse first/last openTime
                lines = [l for l in csv_path.read_text().splitlines() if l and l[0].isdigit()]
                rows = len(lines)
                first_open = int(lines[0].split(",")[0]) if lines else None
                last_open = int(lines[-1].split(",")[0]) if lines else None
                manifest["datasets"].append({
                    "dataset": key, "symbol": sym, "month": mm, "interval": interval,
                    "url": url, "zipSha256": zip_sha, "csvName": csv_name, "csvSha256": csv_sha,
                    "sidecarVerified": sidecar_ok, "frozenManifestVerified": frozen_ok,
                    "rows": rows, "firstOpenTimeMs": first_open, "lastOpenTimeMs": last_open,
                    "extractDir": str(ext_dir.relative_to(DATA)),
                })

    # top-level immutable index hash (of the verified dataset entries, order-normalized)
    idx = sorted([f"{d['dataset']}|{d['symbol']}|{d['month']}|{d['csvSha256']}" for d in manifest["datasets"]])
    manifest["immutableIndexHash"] = hashlib.sha256("\n".join(idx).encode()).hexdigest()
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "HISTORICAL_DATA_MANIFEST.json").write_text(json.dumps(manifest, indent=1))

    primary = [d for d in manifest["datasets"] if d["dataset"] == "klines_1h"]
    print(f"datasets verified: {len(manifest['datasets'])}  (primary 1h klines: {len(primary)}/12)")
    print(f"rejections: {len(manifest['rejections'])}  unavailable: {len(manifest['unavailable'])}")
    print(f"immutableIndexHash: {manifest['immutableIndexHash']}")
    if not ok or len(primary) != 12:
        print("STOP: primary corpus incomplete or a checksum mismatched — see HISTORICAL_DATA_MANIFEST.json", file=sys.stderr)
        sys.exit(2)
    print("OK: primary 1h corpus fully verified against the frozen manifest.")

if __name__ == "__main__":
    main()
