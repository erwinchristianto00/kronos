#!/usr/bin/env python3
"""Cloud-only immutable acquisition of one official Binance CMS catalogue."""

import hashlib
import json
import os
import pathlib
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def stable(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def require_environment():
    study = os.environ["_STUDY"]
    generation_sha = os.environ["_GENERATION_SHA"]
    catalog_id_text = os.environ["_CATALOG_ID"]
    fetch_all_details_text = os.environ["_FETCH_ALL_DETAILS"]
    if len(generation_sha) < 7 or any(character not in "0123456789abcdef" for character in generation_sha.lower()):
        raise RuntimeError("LIFECYCLE_CATALOG_GENERATION_SHA_INVALID")
    if not catalog_id_text.isdigit() or int(catalog_id_text) <= 0:
        raise RuntimeError("LIFECYCLE_CATALOG_ID_INVALID")
    if fetch_all_details_text not in ("true", "false"):
        raise RuntimeError("LIFECYCLE_CATALOG_FETCH_ALL_DETAILS_INVALID")
    return study, generation_sha, int(catalog_id_text), fetch_all_details_text == "true"


def acquire_catalog(study, generation_sha, catalog_id, fetch_all_details):
    root = pathlib.Path("/workspace/binance-cms-lifecycle")
    root.mkdir(parents=True)
    endpoint = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query"
    detail_endpoint = "https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query"
    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "clienttype": "web",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.binance.com/en/support/announcement",
    }
    requests = []
    last_request_at = 0.0

    def get_json(url, relative_path):
        nonlocal last_request_at
        elapsed = time.monotonic() - last_request_at
        if elapsed < 2.0:
            time.sleep(2.0 - elapsed)
        for attempt in range(6):
            requested_at_ms = int(time.time() * 1000)
            try:
                response = urlopen(Request(url, headers=headers), timeout=45)
                payload = response.read()
                last_request_at = time.monotonic()
                if response.status != 200:
                    raise RuntimeError(f"LIFECYCLE_CATALOG_HTTP_{response.status}")
                parsed = json.loads(payload.decode("utf8"))
                target = root / relative_path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload)
                requests.append({
                    "relativePath": relative_path,
                    "url": url,
                    "httpStatus": response.status,
                    "retrievedAtMs": requested_at_ms,
                    "sizeBytes": len(payload),
                    "fileHash": sha256(payload),
                })
                return parsed
            except HTTPError as error:
                last_request_at = time.monotonic()
                if error.code not in (429, 500, 502, 503, 504) or attempt == 5:
                    raise RuntimeError(f"LIFECYCLE_CATALOG_HTTP_{error.code}") from error
                retry_after = error.headers.get("Retry-After")
                time.sleep(float(retry_after) if retry_after and retry_after.isdigit() else min(60, 5 * (2 ** attempt)))
            except (URLError, TimeoutError) as error:
                last_request_at = time.monotonic()
                if attempt == 5:
                    raise RuntimeError("LIFECYCLE_CATALOG_NETWORK_FAILURE") from error
                time.sleep(min(60, 5 * (2 ** attempt)))

    def catalog_page(page_no):
        query = urlencode({"type": "1", "catalogId": str(catalog_id), "pageNo": str(page_no), "pageSize": "10"})
        payload = get_json(endpoint + "?" + query, f"pages/catalog-{catalog_id}-page-{page_no:04d}.json")
        catalogs = ((payload.get("data") or {}).get("catalogs") or [])
        if payload.get("code") != "000000" or payload.get("success") is not True or len(catalogs) != 1:
            raise RuntimeError("LIFECYCLE_CATALOG_RESPONSE_INVALID")
        catalog = catalogs[0]
        if catalog.get("catalogId") != catalog_id or not isinstance(catalog.get("articles"), list):
            raise RuntimeError("LIFECYCLE_CATALOG_SHAPE_INVALID")
        return catalog

    first = catalog_page(1)
    total = first.get("total")
    if not isinstance(total, int) or total <= 0:
        raise RuntimeError("LIFECYCLE_CATALOG_TOTAL_INVALID")
    articles = []
    for page_no in range(1, (total + 9) // 10 + 1):
        catalog = first if page_no == 1 else catalog_page(page_no)
        if catalog.get("total") != total or catalog.get("catalogName") != first.get("catalogName"):
            raise RuntimeError("LIFECYCLE_CATALOG_CHANGED_DURING_CRAWL")
        for index, article in enumerate(catalog["articles"]):
            if (
                not isinstance(article.get("id"), int) or article["id"] <= 0
                or not isinstance(article.get("code"), str) or not article["code"] or len(article["code"]) > 256
                or not isinstance(article.get("title"), str) or not article["title"].strip() or len(article["title"]) > 4096
                or not isinstance(article.get("releaseDate"), int) or article["releaseDate"] <= 0
            ):
                raise RuntimeError(f"LIFECYCLE_CATALOG_ARTICLE_INVALID_PAGE_{page_no}_INDEX_{index}")
            articles.append(article)
    if len(articles) != total or len({article["id"] for article in articles}) != total or len({article["code"] for article in articles}) != total:
        raise RuntimeError("LIFECYCLE_CATALOG_COVERAGE_INVALID")

    def candidate(article):
        title = article["title"].upper()
        pair = any(value in title for value in ("BTC/USDT", "ETH/USDT", "BTCUSDT", "ETHUSDT"))
        return ("FUTURES" in title and pair) or ("FUTURES" in title and "DELIST" in title)

    selected = sorted(articles if fetch_all_details else (article for article in articles if candidate(article)), key=lambda article: (article["releaseDate"], article["code"]))
    for article in selected:
        detail = get_json(detail_endpoint + "?" + urlencode({"articleCode": article["code"]}), f"details/{article['code']}.json")
        data = detail.get("data") or {}
        if detail.get("code") != "000000" or data.get("id") != article["id"] or data.get("title") != article["title"] or not isinstance(data.get("body"), str):
            raise RuntimeError("LIFECYCLE_CATALOG_DETAIL_INVALID")

    requests.sort(key=lambda entry: entry["relativePath"])
    bundle_hash = sha256(stable([{"relativePath": entry["relativePath"], "fileHash": entry["fileHash"]} for entry in requests]).encode())
    titles = [article["title"] for article in articles]
    evidence = {
        "schemaVersion": "KronosBinanceCmsLifecycleRaw/v2",
        "status": "RAW_CATALOG_ACQUIRED_NOT_A_TIMELINE",
        "provider": "Binance",
        "exchange": "BINANCE_USDM",
        "datasetId": f"binance-cms-public-announcements-catalog-{catalog_id}",
        "catalog": {"catalogId": catalog_id, "catalogName": first.get("catalogName"), "articleCount": total, "pageCount": (total + 9) // 10, "pageSize": 10},
        "generation": {"generationToolSha": generation_sha, "generatedAtMs": int(time.time() * 1000)},
        "requests": requests,
        "archiveBundleHash": bundle_hash,
        "detailCoverage": {"mode": "ALL_CATALOG_ARTICLES" if fetch_all_details else "FUTURES_TITLE_CANDIDATES", "detailArticleCount": len(selected)},
        "candidateArticleCodes": [article["code"] for article in selected],
        "candidateSummary": {
            "btcOrEthFuturesTitleCount": sum(1 for title in titles if "FUTURES" in title.upper() and any(pair in title.upper() for pair in ("BTC/USDT", "ETH/USDT", "BTCUSDT", "ETHUSDT"))),
            "futuresDelistTitleCount": sum(1 for title in titles if "FUTURES" in title.upper() and "DELIST" in title.upper()),
        },
        "limitations": [
            "The raw catalogue is official announcement evidence, not an asserted lifecycle timeline.",
            "A full-detail Delisting corpus can support body-level instrument matching, but does not by itself establish unannounced availability changes.",
            "No listing/delisting or futures-availability timeline is produced by this acquisition alone.",
            "REAL_TIER1 remains forbidden until an authoritative complete lifecycle transition source is validated.",
        ],
    }
    manifest_bytes = (stable(evidence) + "\n").encode()
    manifest_hash = sha256(manifest_bytes)
    (root / "acquisition-manifest.json").write_bytes(manifest_bytes)
    target = f"{study}/raw/lifecycle-binance-cms-catalog-{catalog_id}/v2/{bundle_hash}"
    for path in sorted(path for path in root.rglob("*") if path.is_file()):
        relative = path.relative_to(root).as_posix()
        remote = f"{target}/{relative}"
        result = subprocess.run(["gcloud", "storage", "cp", str(path), remote, "--if-generation-match=0"], text=True, capture_output=True)
        if result.returncode:
            existing = pathlib.Path("/workspace/existing") / sha256(remote.encode())
            existing.parent.mkdir(parents=True, exist_ok=True)
            subprocess.check_call(["gcloud", "storage", "cp", remote, str(existing)])
            if sha256(existing.read_bytes()) != sha256(path.read_bytes()):
                raise RuntimeError(f"LIFECYCLE_CATALOG_IMMUTABLE_CONFLICT_{relative}")
    print(stable({"status": "PASS", "rawRoot": target, "archiveBundleHash": bundle_hash, "acquisitionManifestHash": manifest_hash, "objectCount": len(requests), "candidateArticleCodes": evidence["candidateArticleCodes"], "candidateSummary": evidence["candidateSummary"], "realTier1StillForbidden": True}))


if __name__ == "__main__":
    acquire_catalog(*require_environment())
