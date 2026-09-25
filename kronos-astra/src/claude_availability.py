"""Host-only provider wait gate. No trade tools, fallback, or alpha evidence."""
import argparse,contextlib,io,json,os,subprocess,sys,time
from pathlib import Path
from astra_v8_host import atomic_json
MODELS=(('claude-sonnet-5','medium'),('claude-opus-5','high'))
RETRY_MS=900000
LEASE_MS=86400000

def valid(result,at):
    rows=result.get('checks',[])
    return (result.get('passed') is True and len(rows)==2
            and 0<=at-result.get('checkedAt',0)<LEASE_MS
            and all(row.get('model')==model and row.get('effort')==effort and row.get('passed') is True
                    for row,(model,effort) in zip(rows,MODELS)))

class Availability:
    def __init__(self,root,clock):
        self.root=Path(root);self.clock=clock;self.proc=None;self.started=0
        self.path=self.root/'hermes-home/v8/claude-availability.json'
        self.result_path=self.root/'hermes-home/v8/claude-probe-result.json'
        self.state=json.loads(self.path.read_text()) if self.path.exists() else {'status':'WAITING_FOR_CLAUDE','nextProbeAt':0,'failures':0}
    def save(self):atomic_json(self.path,self.state)
    def ready(self):return self.state.get('status')=='READY' and valid(self.state.get('result',{}),self.clock())
    def failed(self):
        self.state.pop('reason',None)  # provider failure must not inherit a budget-only bypass
        failures=self.state.get('failures',0)+1
        self.state.update(status='WAITING_FOR_CLAUDE',failures=failures,
                          nextProbeAt=self.clock()+min(4,2**min(failures-1,2))*RETRY_MS)
        self.save()
    def tick(self,calls,budget,exclude_modes=()):
        at=self.clock()
        if self.proc is not None:
            if self.proc.poll() is None:
                if at-self.started<=90000:return False
                self.proc.kill();self.proc.wait(timeout=5);self.proc=None;self.failed();return False
            result={}
            if self.result_path.exists():
                try:result=json.loads(self.result_path.read_text())
                except ValueError:pass
            self.proc=None;self.state['result']=result
            if result.get('probeStartedAt')==self.started and valid(result,at):
                self.state.update(status='READY',failures=0,readyAt=at);self.save()
            else:self.failed()
        if self.ready():return True
        used=sum(c['at']//86400000==at//86400000 for c in calls if c.get('mode') not in exclude_modes)
        # A budget-only deferral can become eligible after a split. Never bypass
        # real provider backoff or reset the ledger to accomplish this.
        if self.state.get('reason')=='EXISTING_DAILY_MODEL_BUDGET' and used+2<=budget:
            self.state.pop('reason',None);self.state['nextProbeAt']=at
        if at<self.state.get('nextProbeAt',0):return False
        if used+2>budget:
            self.state.update(status='WAITING_FOR_CLAUDE',reason='EXISTING_DAILY_MODEL_BUDGET',nextProbeAt=(at//86400000+1)*86400000)
            self.save();return False
        self.started=at
        calls.extend([{'at':at,'mode':'CLAUDE_HEALTH_PROBE','model':model} for model,_ in MODELS])
        self.state.update(status='WAITING_FOR_CLAUDE',probeStartedAt=at,nextProbeAt=at+RETRY_MS);self.save()
        self.proc=subprocess.Popen([sys.executable,'-B',str(Path(__file__).resolve()),'--probe','--started',str(at),'--output',str(self.result_path)],
                                   cwd=self.root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return False

def probe(started,output):
    root=Path(__file__).resolve().parent
    os.environ['HERMES_HOME']=str(root/'hermes-home');sys.path.insert(0,str(root/'work/hermes-agent'))
    rows=[]
    for model,effort in MODELS:
        row={'model':model,'effort':effort,'passed':False}
        try:
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                from hermes_cli.runtime_provider import resolve_runtime_provider
                from agent.anthropic_adapter import build_anthropic_client,build_anthropic_kwargs,create_anthropic_message
                from agent.anthropic_credentials import _is_oauth_token
                r=resolve_runtime_provider(requested='anthropic',target_model=model)
                client=build_anthropic_client(r['api_key'],r['base_url'],timeout=20).with_options(max_retries=0)
                try:
                    kwargs=build_anthropic_kwargs(model,[{'role':'user','content':'Connection check. Reply exactly CONNECTION_OK.'}],
                        tools=[],max_tokens=512,reasoning_config={'enabled':True,'effort':effort},
                        is_oauth=_is_oauth_token(r['api_key']),base_url=r['base_url'])
                    result=create_anthropic_message(client,kwargs)
                    row['passed']=''.join(getattr(b,'text','') for b in result.content).strip()=='CONNECTION_OK'
                finally:client.close()
        except Exception as err:row.update(errorType=type(err).__name__,httpStatus=getattr(err,'status_code',None))
        rows.append(row)
    atomic_json(output,{'probeStartedAt':started,'checkedAt':int(time.time()*1000),'checks':rows,
                        'passed':all(r['passed'] for r in rows),'toolsAllowed':False})

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--probe',action='store_true');p.add_argument('--started',type=int);p.add_argument('--output')
    a=p.parse_args()
    if a.probe:probe(a.started,a.output)
