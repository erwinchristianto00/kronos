"""One-shot read-only VPS gateway evidence capture; no runner or model invocation.

Writes new local artifacts only. Uses existing SSH authentication and gateway
token in place on VPS; never copies credentials or invokes order routes.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from quant_snapshot import snapshot, LANE


REMOTE_READ = '''cd /opt/kronos-astra/runtime && python3 -c 'import json; import astra_runner as e; print(json.dumps(e.gateway("/context", {"symbols":["BTCUSDT","ETHUSDT"]})))' '''


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', required=True)
    args = p.parse_args()
    dest = Path(args.output)
    if dest.exists(): raise SystemExit('Output must be a new local directory')
    result = subprocess.run(['ssh', '-i', '/Users/erwin/.ssh/contabo_dtc', '-o', 'IdentitiesOnly=yes',
                             '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'root@194.233.71.109',
                             REMOTE_READ], capture_output=True, text=True, timeout=200, check=True)
    raw = json.loads(result.stdout)
    if raw.get('source') != 'BINANCE_USDM_TESTNET' or raw.get('status',{}).get('laneId') != LANE:
        raise SystemExit('Wrong gateway source or lane')
    # Only retain the fields needed for the snapshot; no closed-trade history,
    # account-wide wallet information or legacy decision journal in this artifact.
    raw['status'] = {k: raw['status'].get(k) for k in ('environment','laneId','active')}
    raw = {k: raw[k] for k in ('source','at','rows','status')}
    for row in raw['rows']: row['observedAt'] = raw['at']
    quant = snapshot(raw, raw['at'])
    dest.mkdir()
    artifacts = {'gateway-raw.json': raw, 'quant-context.json': quant}
    hashes = {}
    for name, obj in artifacts.items():
        payload = json.dumps(obj, indent=2, sort_keys=True, allow_nan=False)+'\n'
        with (dest/name).open('x') as f: f.write(payload)
        hashes[name] = hashlib.sha256(payload.encode()).hexdigest()
    source_hashes = {name: hashlib.sha256((Path(__file__).parent/name).read_bytes()).hexdigest()
                     for name in ('portfolio_attribution.py','quant_snapshot.py','quant_measurements.py','inspect_quant_gateway.py')}
    with (dest/'provenance.json').open('x') as f:
        json.dump({'asOf': raw['at'], 'artifacts': hashes, 'sourceHashes': source_hashes,
                   'scope': 'READ_ONLY_TESTNET_GATEWAY_LOCAL_ANALYSIS_NOT_DEPLOYED',
                   'timestampMeaning': 'SOURCE_RESPONSE_TIMESTAMP_NOT_CONTINUOUS_LIVE_PROOF'}, f, indent=2)
    print(json.dumps({'output': str(dest), 'asOf': raw['at'],
                      'ownedPositionsN': len(raw['status']['active']),
                      'rows': [{'symbol': r['symbol'], 'quality': r['dataQuality']['status'],
                                'makerFee': r['costContext']['makerFee'], 'takerFee': r['costContext']['takerFee']}
                               for r in quant['rows']]}))


if __name__ == '__main__': main()
