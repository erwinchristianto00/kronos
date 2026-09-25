"""Bounded public Testnet formation reads. No order or account authority."""
import copy
import json
import math
import unicodedata
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ORIGIN = 'https://demo-fapi.binance.com'
METHOD = 'TESTNET_FORMATION_REFRESH_V1'


def read_public(path, params):
    if path not in ('/fapi/v1/klines', '/fapi/v1/ticker/bookTicker'):
        raise ValueError('READ_ONLY_MARKET_ROUTE_REQUIRED')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    url = ORIGIN + path + '?' + urllib.parse.urlencode(params)
    with urllib.request.build_opener(NoRedirect).open(url, timeout=8) as response:
        return json.load(response)


def number(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError('NONFINITE_MARKET_VALUE')
    return value


def refresh_candidates(raw, read=read_public, clock=lambda: int(time.time()*1000)):
    if raw.get('source') != 'BINANCE_USDM_TESTNET' or raw.get('status', {}).get('environment') != 'testnet':
        raise ValueError('TESTNET_ONLY')
    rows = raw.get('rows', [])
    symbols = [r.get('symbol') for r in rows]
    # Membership was checked against exchange filters by the authenticated gateway.
    # Keep transport validation consistent with its Unicode contract names.
    invalid = any(not isinstance(s, str) or not 4 < len(s) <= 80 or not s.endswith('USDT')
                  or any(c.isspace() or unicodedata.category(c).startswith('C')
                         or c in '/?&#\\' for c in s) for s in symbols)
    if invalid or not 1 <= len(rows) <= 6 or len(set(symbols)) != len(symbols):
        raise ValueError('BOUNDED_UNIQUE_FORMATION_BATCH_REQUIRED')

    def candles(row):
        r = copy.deepcopy(row)
        r['features'] = {}  # Never mix gateway features with refreshed candles.
        r['candles'], r['book'] = [], None
        r['marketRefresh'] = {'methodVersion': METHOD, 'source': ORIGIN, 'startedAt': clock()}
        try:
            values = read('/fapi/v1/klines', {'symbol': r['symbol'], 'interval': '5m', 'limit': 100})
            at = clock()
            r['candles'] = [dict(zip(('open', 'high', 'low', 'close', 'volume'), map(number, c[1:6])),
                                 closeTime=number(c[6]), quoteVolume=number(c[7]))
                            for c in values if number(c[6]) < at]
        except Exception:
            r['marketRefresh']['candleError'] = 'PUBLIC_TESTNET_CANDLE_READ_FAILED'
        return r

    def book(row):
        try:
            b = read('/fapi/v1/ticker/bookTicker', {'symbol': row['symbol']})
            if b.get('symbol') != row['symbol']:
                raise ValueError('BOOK_SYMBOL_MISMATCH')
            bid, ask, stamp = number(b['bidPrice']), number(b['askPrice']), number(b['time'])
            if not 0 < bid <= ask or not 0 <= clock()-stamp <= 5000:
                raise ValueError('INVALID_OR_STALE_BOOK')
            row['book'] = {'bid': bid, 'ask': ask, 'time': stamp}
        except Exception:
            row['marketRefresh']['bookError'] = 'PUBLIC_TESTNET_BOOK_READ_FAILED'
        eco = row.setdefault('economics', {})
        for key in ('spreadBps', 'feeAndSpreadBps', 'bookFresh', 'bookTime'):
            eco.pop(key, None)
        b = row['book']
        eco['bookFresh'] = b is not None
        if b:
            eco['bookTime'] = b['time']
            eco['spreadBps'] = (b['ask']-b['bid'])/((b['ask']+b['bid'])/2)*10000
            fees = eco.get('roundTripTakerFeeBps')
            if type(fees) in (int, float) and math.isfinite(fees):
                eco['feeAndSpreadBps'] = fees+eco['spreadBps']
        row['observedAt'] = clock()
        row['marketRefresh']['completedAt'] = row['observedAt']
        return row

    with ThreadPoolExecutor(max_workers=6) as pool:
        updated = list(pool.map(candles, rows))
        # Slow history phase completes BEFORE final executable quotes.
        updated = list(pool.map(book, updated))
    result = {**copy.deepcopy(raw), 'rows': updated, 'at': clock()}
    if raw.get('contextMode') == 'FORMATION_METADATA_V1':
        result.update(contextMode='FORMATION_REFRESH_V2', metadataSourceMode='FORMATION_METADATA_V1',
                      marketDataComplete=all(r.get('candles') and r.get('book') for r in updated))
    return result
