"""One-shot public Testnet market snapshot. GET-only; no key, account or order API.

Not a runner or automation. Symbols passed here are a data sample, not a lane
universe restriction. Output uses exclusive creation so prior evidence survives.
"""
import argparse
import concurrent.futures
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path
from astra_quant_v4 import contract

BASE = 'https://demo-fapi.binance.com'
PATHS = frozenset(('/fapi/v1/time','/fapi/v1/klines','/fapi/v1/ticker/bookTicker','/fapi/v1/premiumIndex'))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Redirect forbidden: Testnet source identity must not change')


def public_get(path, **params):
    if path not in PATHS:
        raise ValueError('Endpoint outside read-only public market allowlist')
    url = BASE+path+'?'+urllib.parse.urlencode(params)
    request = urllib.request.Request(url, method='GET', headers={'User-Agent':'Kronos-ReadOnly-Quant/1'})
    # Deliberately no retry loop; rate-limit and transport failures stay visible.
    with urllib.request.build_opener(NoRedirect()).open(request,timeout=15) as response:
        if urllib.parse.urlsplit(response.geturl()).netloc != 'demo-fapi.binance.com':
            raise ValueError('Unexpected source host')
        return json.load(response)


def collect(symbols, bars=500):
    if not symbols or len(set(symbols))!=len(symbols) or len(symbols)>20:
        raise ValueError('Choose a unique bounded sample of 1..20 symbols per snapshot')
    if any(not re.fullmatch(r'[A-Z0-9]{2,30}USDT',s) for s in symbols):
        raise ValueError('Invalid USD-M symbol')
    if type(bars) is not int or not 61 <= bars <= 1000:
        raise ValueError('Snapshot history limit must be 61..1000')
    start = public_get('/fapi/v1/time')['serverTime']
    def fetch(symbol):
        klines = public_get('/fapi/v1/klines',symbol=symbol,interval='5m',limit=bars,endTime=start-1)
        premium = public_get('/fapi/v1/premiumIndex',symbol=symbol)
        book = public_get('/fapi/v1/ticker/bookTicker',symbol=symbol)
        if book.get('symbol')!=symbol or premium.get('symbol')!=symbol or not isinstance(klines,list):
            raise ValueError('Market response identity mismatch')
        candles = [{'openTime':int(k[0]),'open':float(k[1]),'high':float(k[2]),'low':float(k[3]),
                    'close':float(k[4]),'volume':float(k[5]),'closeTime':int(k[6]),'quoteVolume':float(k[7])}
                   for k in klines]
        return {'symbol':symbol,'intervalMs':300000,'candles':candles,'features':{},
                'book':{'bid':float(book['bidPrice']),'ask':float(book['askPrice']),'time':int(book['time'])},
                'economics':{'funding':{'status':'INDICATIVE','rate':float(premium['lastFundingRate']),
                                      'nextFundingTime':int(premium['nextFundingTime']), 'observedAt':premium.get('time')},
                             'commission':{'status':'UNKNOWN','takerRate':None}},
                'provenance':{'host':BASE,'requestedAtServer':start,'interval':'5m','rawBook':book,'rawPremium':premium}}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        rows=list(pool.map(fetch,symbols))
    end=public_get('/fapi/v1/time')['serverTime']
    for row in rows:
        row['observedAt']=end
    raw={'source':'BINANCE_USDM_TESTNET','status':{'environment':'testnet'},'rows':rows,
         'collectionStartedAt':start,'collectionFinishedAt':end,
         'scope':'PUBLIC_MARKET_SAMPLE_NOT_LANE_UNIVERSE_OR_ACCOUNT_STATE'}
    q=contract(raw,end)
    return raw,q


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--symbols',nargs='+',required=True)
    p.add_argument('--bars',type=int,default=500)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    a.output.mkdir(parents=True,exist_ok=True)
    for name in ('raw-market.json','quant-snapshot.json','provenance.json'):
        if (a.output/name).exists():
            raise SystemExit('Existing evidence will not be overwritten')
    raw,q=collect(a.symbols,a.bars)
    hashes={}
    for name,value in (('raw-market.json',raw),('quant-snapshot.json',q)):
        body=json.dumps(value,indent=2,allow_nan=False)
        with (a.output/name).open('x') as stream:
            stream.write(body)
        hashes[name]=hashlib.sha256(body.encode()).hexdigest()
    with (a.output/'provenance.json').open('x') as stream:
        json.dump({'artifactHashes':hashes,'collectorHash':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   'collectionFinishedAt':raw['collectionFinishedAt'],'testnetOnly':True,'ordersEnabled':False,
                   'symbolsAreSampleOnly':True},stream,indent=2)
    print(json.dumps({'output':str(a.output),'symbols':a.symbols,'at':raw['collectionFinishedAt'],
        'measurements':[{'symbol':r['symbol'],'regime':r['regime'],'betaBTC':r['beta'],
                         'status':(r.get('measurement') or {}).get('status'),
                         'closedBarsN':(r.get('measurement') or {}).get('closedBarsN')} for r in q['rows']]}))


if __name__=='__main__':
    main()
