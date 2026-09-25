"""Public-media attention, not alpha, social sentiment, wallet flow or order authority.

Untrusted publisher text is parsed locally into fixed labels/counts. No article
body or arbitrary headline instruction is passed to a trading model.
"""
import copy
import email.utils
import hashlib
import html
from functools import lru_cache
import json
import queue
import re
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from astra_v8_host import atomic_json, digest

VERSION = 'PUBLIC_MEDIA_ATTENTION_V1'
INTERVAL = 600000
TTL = 1200000
WINDOW = 86400000
SOURCES = {'coindesk': 'https://www.coindesk.com/arc/outboundfeeds/rss',
           'decrypt': 'https://decrypt.co/feed', 'cointelegraph': 'https://cointelegraph.com/rss'}
DOMAINS = {'coindesk': 'coindesk.com', 'decrypt': 'decrypt.co', 'cointelegraph': 'cointelegraph.com'}
ALIASES = {'BTC': ('bitcoin',), 'ETH': ('ethereum', 'ether'), 'SOL': ('solana',),
           'DOGE': ('dogecoin',), 'XRP': ('xrp',), 'ADA': ('cardano',), 'AVAX': ('avalanche',),
           'LINK': ('chainlink',), 'DOT': ('polkadot',), 'SUI': ('sui',), 'HYPE': ('hyperliquid',),
           'LTC': ('litecoin',), 'BCH': ('bitcoin cash',), 'BNB': ('bnb',)}
TOPICS = {'ETF': ('etf', 'exchange traded fund'), 'REGULATION': ('regulation', 'sec', 'court', 'lawsuit'),
          'SECURITY': ('hack', 'exploit', 'breach', 'stolen'), 'PROTOCOL': ('upgrade', 'mainnet', 'fork'),
          'SUPPLY': ('unlock', 'burn', 'issuance'), 'ADOPTION': ('adoption', 'partnership', 'integration')}
RULES = '''PUBLIC MEDIA ATTENTION: narrativeContext contains measured publisher coverage only.
Topic labels are headline keyword matches, NOT verified catalysts, causal demand,
sentiment, smart money, buy/sell direction, probability or validated edge. More
coverage can describe bad news, a crowded trade, or a move already completed.
Use this as discovery/context only; current price/geometry, cost and risk guards
remain final. Missing/stale/partial coverage is not negative evidence. Wallet flow
and social attention are UNKNOWN. Do not invent absent catalysts or wallet trades.
Hermes may use only the delivered pre-decision snapshot, never later news. A
selection change is not proof of incremental profit; no causal comparison exists.
'''


def read(source):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    request = urllib.request.Request(SOURCES[source], headers={'User-Agent': 'Astra-Testnet-Research/1.0'})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
        data = response.read(1000001)
    if len(data) > 1000000:
        raise ValueError('FEED_TOO_LARGE')
    return data


def clean(text):
    return ' '.join(re.sub(r'<[^>]*>', ' ', html.unescape(text or '')).split())[:300]


def parse(source, data, at):
    if source not in SOURCES or len(data) > 1000000 or b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('UNSAFE_OR_OVERSIZED_XML')
    tree = ET.fromstring(data)
    items = tree.findall('.//item')
    if not items:
        raise ValueError('NO_RSS_ITEMS')
    rows, excluded = [], {}
    for item in items[:200]:
        reason = None
        try:
            title = clean(item.findtext('title'))
            url = urllib.parse.urlsplit((item.findtext('link') or '').strip())
            if (url.scheme != 'https' or url.username or url.password or url.port not in (None,443)
                    or url.hostname not in (DOMAINS[source], 'www.'+DOMAINS[source])):
                raise ValueError('UNVERIFIED_ARTICLE_LINK')
            canonical = urllib.parse.urlunsplit(('https', url.netloc, url.path, '', ''))
            dt = email.utils.parsedate_to_datetime(item.findtext('pubDate') or '')
            if dt.tzinfo is None:
                raise ValueError('MISSING_TIMEZONE')
            published = int(dt.timestamp()*1000)
            if not title:
                raise ValueError('MISSING_TITLE')
            if published > at:
                raise ValueError('FUTURE_PUBLICATION')
            if at-published > WINDOW:
                raise ValueError('OLD_PUBLICATION')
            key = digest(canonical)
            rows.append({'id':key,'source':source,'url':canonical,'title':title,'publishedAt':published,
                         'titleHash':digest(re.sub(r'\W+', ' ', title.lower()).strip())})
        except Exception as error:
            reason = str(error) if isinstance(error,ValueError) else 'INVALID_PUBLICATION'
        if reason:
            excluded[reason] = excluded.get(reason,0)+1
    return rows, {'source':source,'fetchedAt':at,'status':'AVAILABLE','rawHash':hashlib.sha256(data).hexdigest(),
                  'itemN':len(items),'eligibleN':len(rows),'excluded':excluded}


@lru_cache(maxsize=4096)
def patterns(symbol):
    base=symbol[:-4]
    explicit=re.compile(r'(?<![\w$])\$'+re.escape(base)+r'(?!\w)|(?<!\w)'+re.escape(symbol)+r'(?!\w)',re.I)
    named=tuple(re.compile(r'(?<!\w)'+re.escape(name)+r'(?!\w)',re.I) for name in ALIASES.get(base,()))
    return explicit,named


def symbols_for(title, universe):
    result=[]
    for symbol in sorted(set(universe)):
        if not isinstance(symbol,str) or not symbol.endswith('USDT'):
            continue
        base=symbol[:-4]
        # No guessed multiplier-token mapping. Exact exchange symbol or cashtag
        # works across the universe; names need an explicit versioned mapping.
        expression,names=patterns(symbol)
        explicit=expression.search(title)
        named=any(expression.search(title) for expression in names)
        if base=='BTC' and re.search(r'bitcoin cash',title,re.I) and not re.search(r'\bbitcoin\b(?! cash)',title,re.I):
            named=False
        if explicit or named:
            result.append(symbol)
    return result


def merge(previous, fetched, at):
    previous=previous or {}
    if previous and previous.get('version')!=VERSION:
        raise ValueError('NARRATIVE_VERSION_MISMATCH')
    state=copy.deepcopy(previous) if previous else {'version':VERSION,'startedAt':at,'articles':{},'receipts':{}}
    for source,(rows,receipt) in fetched.items():
        state['receipts'][source]=receipt
        if receipt['status']=='AVAILABLE':
            for row in rows:
                # Old title edits/publication rewrites do not manufacture a new event.
                state['articles'].setdefault(row['id'],{**row,'firstSeenAt':at})
    state['articles']={k:v for k,v in state['articles'].items() if 0<=at-v['firstSeenAt']<=WINDOW
                       and 0<=at-v['publishedAt']<=WINDOW}
    state['observedAt']=at
    available=sorted(s for s,r in state['receipts'].items() if r.get('status')=='AVAILABLE'
                     and 0<=at-r.get('fetchedAt',0)<=TTL)
    state['polls']=[p for p in state.get('polls',[]) if at-p['at']<=WINDOW]
    state['polls'].append({'at':at,'available':available})
    state['sourceSnapshotHash']=digest({k:v for k,v in state.items() if k!='sourceSnapshotHash'})
    return state


def snapshot(state, universe, at):
    state=state or {}
    fresh={s for s,r in state.get('receipts',{}).items() if r.get('status')=='AVAILABLE'
           and 0<=at-r.get('fetchedAt',0)<=TTL}
    boundary=at-7200000
    polls=sorted((p for p in state.get('polls',[]) if p['at']<=at),key=lambda p:p['at'])
    anchor=[p for p in polls if p['at']<=boundary]
    window=([anchor[-1]] if anchor else [])+[p for p in polls if p['at']>boundary]
    complete_history=bool(anchor) and all(set(p['available'])==set(SOURCES) for p in window)
    complete_history=complete_history and all(b-a<=TTL for a,b in zip([p['at'] for p in window],[p['at'] for p in window][1:]+[at]))
    matched={s:[] for s in universe}
    for row in state.get('articles',{}).values():
        if (row['source'] not in fresh or not 0<=at-row['firstSeenAt']<=WINDOW
                or not 0<=at-row['publishedAt']<=WINDOW):continue
        for symbol in symbols_for(row['title'], universe):matched[symbol].append(row)
    values={}
    for symbol,articles in matched.items():
        # Syndicated identical headlines count once, not as multiple confirmations.
        unique={}
        for row in sorted(articles,key=lambda r:(r['firstSeenAt'],r['id'])):
            unique.setdefault(row['titleHash'],row)
        rows=list(unique.values());sources=sorted({r['source'] for r in rows})
        topics=sorted({topic for topic,words in TOPICS.items() for row in rows
                       if any(re.search(r'(?<!\w)'+re.escape(word)+r'(?!\w)',row['title'],re.I) for word in words)})
        recent=sum(at-r['firstSeenAt']<3600000 for r in rows)
        prior=sum(3600000<=at-r['firstSeenAt']<7200000 for r in rows)
        values[symbol]={'status':'OBSERVED_MEDIA_COVERAGE' if rows else 'UNKNOWN_NO_MATCHED_COVERAGE',
            'uniqueHeadlineN':len(rows),'publisherN':len(sources),'sourceIds':sources,
            'topicKeywords':topics,'firstSeenAt':min((r['firstSeenAt'] for r in rows),default=None),
            'lastSeenAt':max((r['firstSeenAt'] for r in rows),default=None),
            'latestPublishedAt':max((r['publishedAt'] for r in rows),default=None),
            'observedMentions1h':recent if fresh else None,
            'observedChange1h':recent-prior if complete_history and len(fresh)==len(SOURCES) else None,
            'baselineStatus':'PROSPECTIVE_OBSERVATIONS' if complete_history else 'WARMING_UP_OR_PARTIAL',
            'evidenceIds':[r['id'] for r in sorted(rows,key=lambda r:r['firstSeenAt'],reverse=True)[:3]]}
    result={'version':VERSION,'asOf':at,'dataQuality':'GOOD' if len(fresh)==len(SOURCES) else 'DEGRADED' if fresh else 'UNKNOWN',
        'availableSources':sorted(fresh),'sourceSnapshotHash':state.get('sourceSnapshotHash'),
        'rows':values,'walletFlow':'UNKNOWN_NO_VERIFIED_ONCHAIN_SOURCE','socialAttention':'UNKNOWN_NO_SOCIAL_SOURCE',
        'evidenceStatus':'MARKET_STATE_ONLY','meaning':'PUBLISHER_ATTENTION_NOT_DEMAND_OR_ALPHA',
        'mappingVersion':VERSION,'executionAuthority':False}
    result['coverageMeaning']='ALLOWLISTED_RSS_MAPPED_HEADLINES_NOT_ALL_NEWS_OR_SOCIAL_MARKET'
    result['snapshotHash']=digest(result)
    return result


def select_exploration(selection, ranked, coverage, context, excluded=()):
    original=copy.deepcopy(selection)
    if context.get('version')!=VERSION or context.get('dataQuality') not in ('GOOD','DEGRADED'):
        return original
    if len(original.get('selected',[]))!=6:return original
    selected=original['selected'];used={r['symbol'] for r in selected[:5]}|set(excluded)
    last={}
    for job in coverage.get('jobs',{}).values():
        if job.get('outcome') is not None:
            for s in job.get('symbols',[]):last[s]=max(last.get(s,0),job['at'])
    candidates=[]
    for row in ranked:
        n=context['rows'].get(row['symbol'],{})
        if (row['symbol'] not in used and n.get('publisherN',0)>=2 and n.get('uniqueHeadlineN',0)>=2
                and n.get('lastSeenAt',0)>last.get(row['symbol'],0)):
            candidates.append((row,n))
    if candidates:
        row,n=sorted(candidates,key=lambda pair:(-pair[1]['publisherN'],-pair[1]['uniqueHeadlineN'],pair[0]['symbol']))[0]
        selected[-1]={**copy.deepcopy(row),'slot':'NARRATIVE_EXPLORATION','narrativeSnapshotHash':context['snapshotHash']}
    original['narrativeComparison']={'baselineSymbols':[r['symbol'] for r in selection['selected']],
        'actualSymbols':[r['symbol'] for r in selected],'snapshotHash':context['snapshotHash'],
        'changed':selected[-1]['symbol']!=selection['selected'][-1]['symbol'],
        'meaning':'SAME_TIME_SELECTION_COMPARISON_NOT_COUNTERFACTUAL_PROFIT'}
    return original


def compact(context, symbols):
    out={k:copy.deepcopy(v) for k,v in context.items() if k!='rows'}
    out['rows']={s:{k:v for k,v in context['rows'].get(s,{}).items() if k not in ('baselineStatus',)} for s in sorted(set(symbols))}
    out['deliveredHash']=digest(out)
    return out


def revalidate(context, at):
    stamp=context.get('asOf')
    if type(stamp) not in (int,float) or not 0<=at-stamp<=TTL:
        return {'version':VERSION,'snapshotHash':context.get('snapshotHash'),
                'status':'UNKNOWN_STALE_NARRATIVE','dataQuality':'UNKNOWN','executionAuthority':False}
    return copy.deepcopy(context)


class Attention:
    def __init__(self, root, reader=read):
        self.path=Path(root)/'hermes-home/v8/narrative-attention.json'
        self.reader=reader;self.worker=None;self.messages=queue.Queue();self.next_at=0;self.error=None
        try:
            self.state=json.loads(self.path.read_text()) if self.path.exists() else {}
            if self.state and self.state.get('version')!=VERSION:raise ValueError('VERSION_MISMATCH')
        except Exception:
            self.state={};self.error='INVALID_PERSISTED_NARRATIVE';self.next_at=float('inf')

    def _fetch(self):
        def one(source):
            try:
                data=self.reader(source);at=int(time.time()*1000)
                return source,parse(source,data,at)
            except Exception:
                return source,([],{'source':source,'status':'UNAVAILABLE','fetchedAt':int(time.time()*1000)})
        with ThreadPoolExecutor(max_workers=3) as pool:
            self.messages.put(dict(pool.map(one,SOURCES)))

    def poll(self, universe, at):
        if self.worker is not None and not self.worker.is_alive():
            try:
                state=merge(self.state,self.messages.get_nowait(),at)
                atomic_json(self.path,state);self.state=state
            except Exception:
                self.error='NARRATIVE_REFRESH_FAILED'
            self.worker=None
        if self.worker is None and at>=self.next_at:
            self.next_at=at+INTERVAL
            self.worker=threading.Thread(target=self._fetch,daemon=True,name='public-media-attention')
            self.worker.start()
        return snapshot(self.state,universe,at)
