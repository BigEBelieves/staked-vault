#!/usr/bin/env python3
"""Read-only Base snapshot and allowlisted STAKED V3 transaction planner. Never signs/sends."""
import argparse, hashlib, json, os, re, sys, time, urllib.request, ssl, subprocess
from urllib.parse import urlsplit
VAULT='0x6e6c236d5ef18caf835faf2bd495ed48e3f8ccc5'
TOKEN='0x731d4066a8375fc590fcd9dfe8d9e58670cb8ba3'
USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
BNKR='0x22af33fe49fd1fa80c7149773dde5890d3c76f3b'
RUNTIME_SHA256={'0x731d4066a8375fc590fcd9dfe8d9e58670cb8ba3': '42478fba81b9ab32a3df3ab4a4f8acd67a4528f1d295a0a32924b4eb583fce4d', '0x6e6c236d5ef18caf835faf2bd495ed48e3f8ccc5': '1451d033a400907d1af06737cd23981268020c983025b7d13ca8ce5313dba391'}
MAX=2**256-1
SEL={'stake':'a694fc3a','withdraw':'2e1a7d4d','early-withdraw':'6b5b9696','claim':'3d18b912','approve':'095ea7b3','balance':'70a08231','allowance':'dd62ed3e','lock':'23792279','earned':'211dc32d','token':'cc7a262e','usdc':'3e413bee','bnkr':'72247519','duration':'485d3834','penalty':'5c82a112','preview':'bbc6f1dc'}
def address(s):
    if not isinstance(s,str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}',s) or int(s,16)==0: raise ValueError('Valid nonzero wallet address required')
    return s.lower()
def word(n):
    if type(n) is not int or not 0<=n<=MAX: raise ValueError('Invalid uint256')
    return f'{n:064x}'
def aw(s): return address(s)[2:].zfill(64)
def amount(s):
    if not isinstance(s,str) or not re.fullmatch(r'(0|[1-9][0-9]*)(\.[0-9]{1,18})?',s): raise ValueError('Use a plain positive decimal with at most 18 places; no commas/exponents')
    a,_,b=s.partition('.'); n=int(a)*10**18+int(b.ljust(18,'0') or '0')
    if not 0<n<=MAX: raise ValueError('Amount out of range')
    return n
def calldata(method,*args): return '0x'+SEL[method]+''.join(args)
def plan(s,action,quantity=None,accept_early=False):
    account=address(s['account'])
    if s['chainId']!=8453 or s['vault'].lower()!=VAULT or s['token'].lower()!=TOKEN: raise ValueError('Wrong chain or contracts')
    for k in ['timestamp','block','walletBalance','stake','allowance','lockEnd','earnedUsdc','earnedBnkr']:
        word(s[k])
    if action=='preview-early-withdraw':
        n=amount(quantity)
        if n>s['stake']: raise ValueError('Amount exceeds stake')
        if s['timestamp']>=s['lockEnd']: raise ValueError('Position matured; no early penalty preview needed')
        return {'action':action,'snapshot':s,'transaction':None}
    if action=='status': return {'action':'status','snapshot':s,'transaction':None}
    if action not in ['stake','withdraw','early-withdraw','claim']: raise ValueError('Action not allowed')
    locked=s['timestamp']<s['lockEnd']; warnings=[]; target=VAULT; method=action
    if action=='claim':
        if quantity is not None: raise ValueError('Claim takes no amount')
        if locked: raise ValueError('Rewards locked until lockEnd')
        if s['earnedUsdc']==0 and s['earnedBnkr']==0: raise ValueError('No accrued rewards at snapshot')
        data=calldata('claim')
    else:
        n=amount(quantity)
        if action=='stake':
            if n>s['walletBalance']: raise ValueError('Insufficient STAKED balance')
            warnings.append('Seven-day lock. Adding a deposit resets the lock for the ENTIRE existing position.')
            if s['allowance']!=n:
                target=TOKEN;method='approve';data=calldata('approve',aw(VAULT),word(n))
                warnings.append('Approval only. Wait for success and regenerate the stake plan from fresh state.')
            else: data=calldata('stake',word(n))
        else:
            if n>s['stake']: raise ValueError('Amount exceeds stake')
            if action=='withdraw' and locked: raise ValueError('Locked: do not substitute early withdrawal')
            if action=='early-withdraw':
                if not locked: raise ValueError('Position matured; request an ordinary withdrawal plan')
                if not accept_early: raise ValueError('Explicit acceptance of early penalty and ALL reward forfeiture required')
                warnings.append('Burns 20% of withdrawn amount and forfeits ALL pending account rewards, including rewards on tokens left staked.')
            data=calldata(action,word(n))
    return {'action':action,'step':method,'snapshot':s,'warnings':warnings,'expiresAt':s['timestamp']+120,
            'transaction':{'chainId':8453,'from':account,'to':target,'value':'0x0','data':data},
            'requiresUserAuthorization':True,'requiresFreshSimulation':True}
class Rpc:
    """Read-only JSON-RPC over verified HTTPS; transport never changes on an error."""
    def __init__(self,url,transport=None):
        parsed=urlsplit(url)
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment: raise ValueError('HTTPS RPC without userinfo/fragment required')
        self.url=url
        self.transport=transport or os.environ.get('STAKED_RPC_TRANSPORT','python')
        if self.transport not in ['python','curl']: raise ValueError('Transport must be python or curl')
    def request(self,payload):
        if self.transport=='curl':
            # -q must be first: do not load a curlrc that could disable TLS checks.
            args=['curl','-q','--proto','=https','--max-time','25','--silent','--show-error',
                  '--request','POST','--header','Content-Type: application/json',
                  '--user-agent','StakedVaultPlanner/1.1','--data-binary','@-',
                  '--write-out','\n%{http_code}','--url',self.url]
            ca=os.environ.get('SSL_CERT_FILE')
            if ca: args+=['--cacert',ca]
            try: r=subprocess.run(args,input=payload,capture_output=True,timeout=30,check=False)
            except (OSError,subprocess.TimeoutExpired): raise ValueError('curl unavailable or timed out; no transaction prepared') from None
            if r.returncode:
                raise ValueError('TLS verification failed; configure a trusted CA bundle' if r.returncode==60 else 'curl HTTPS request failed; no transaction prepared')
            try: body,status=r.stdout.rsplit(b'\n',1);status=int(status)
            except (ValueError,AttributeError): raise ValueError('Malformed curl response') from None
            return status,body
        try:
            context=ssl.create_default_context()
            req=urllib.request.Request(self.url,payload,{'Content-Type':'application/json','User-Agent':'StakedVaultPlanner/1.1'})
            with urllib.request.urlopen(req,timeout=25,context=context) as r: return r.status,r.read()
        except urllib.error.HTTPError as e: return e.code,b''
        except (ssl.SSLError,urllib.error.URLError):
            raise ValueError('Python HTTPS failed; check trusted CA configuration and RPC connectivity') from None
    def __call__(self,method,params):
        if method not in ['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_call']: raise ValueError('RPC method not read-only')
        payload=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode()
        for attempt in range(4):
            time.sleep(1.2)
            status,body=self.request(payload)
            if status==429 and attempt<3: time.sleep(2**attempt);continue
            if status!=200: raise ValueError('RPC HTTP '+str(status)+'; stop without a transaction')
            try: out=json.loads(body)
            except (ValueError,UnicodeDecodeError): raise ValueError('RPC returned non-JSON data') from None
            if not isinstance(out,dict) or out.get('id')!=1 or out.get('jsonrpc')!='2.0': raise ValueError('Malformed JSON-RPC response')
            if 'error' in out:
                error=out['error']
                if isinstance(error,dict) and error.get('code') in [-32016,-32005,429] and attempt<3: time.sleep(2**attempt);continue
                raise ValueError('RPC rejected read; stop without a transaction')
            if 'result' not in out: raise ValueError('RPC result missing')
            return out['result']
        raise ValueError('RPC retry budget exhausted')
def snapshot(rpc,account,now=None):
    account=address(account)
    if int(rpc('eth_chainId',[]),16)!=8453: raise ValueError('Not Base mainnet')
    head=rpc('eth_blockNumber',[]); b=rpc('eth_getBlockByNumber',[head,False]); timestamp=int(b['timestamp'],16)
    if abs((time.time() if now is None else now)-timestamp)>120: raise ValueError('Stale chain snapshot')
    for contract in [VAULT,TOKEN]:
        code=rpc('eth_getCode',[contract,head])
        if hashlib.sha256(bytes.fromhex(code[2:])).hexdigest()!=RUNTIME_SHA256[contract]: raise ValueError('Contract code mismatch')
    def call(to,method,*args):
        raw=rpc('eth_call',[{'to':to,'data':calldata(method,*args)},head])
        if not isinstance(raw,str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{64})+',raw): raise ValueError('Malformed contract read')
        return [int(raw[i:i+64],16) for i in range(2,len(raw),64)]
    for method,expected in [('token',TOKEN),('usdc',USDC),('bnkr',BNKR)]:
        if call(VAULT,method)!=[int(expected,16)]: raise ValueError('Vault token mismatch')
    if call(VAULT,'duration')!=[604800] or call(VAULT,'penalty')!=[2000]: raise ValueError('Vault rules mismatch')
    s={'account':account,'chainId':8453,'vault':VAULT,'token':TOKEN,'block':int(head,16),'blockHash':b['hash'],'timestamp':timestamp}
    for key,to,method,args in [('walletBalance',TOKEN,'balance',[aw(account)]),('stake',VAULT,'balance',[aw(account)]),('allowance',TOKEN,'allowance',[aw(account),aw(VAULT)]),('lockEnd',VAULT,'lock',[aw(account)]),('earnedUsdc',VAULT,'earned',[aw(USDC),aw(account)]),('earnedBnkr',VAULT,'earned',[aw(BNKR),aw(account)])]:
        values=call(to,method,*args)
        if len(values)!=1: raise ValueError('Wrong return length')
        s[key]=values[0]
    if rpc('eth_getBlockByNumber',[head,False])['hash']!=b['hash']: raise ValueError('Snapshot reorganized')
    return s
def json_safe(v):
    if isinstance(v,dict): return {k:json_safe(x) for k,x in v.items()}
    if isinstance(v,list): return [json_safe(x) for x in v]
    return str(v) if type(v) is int and abs(v)>2**53-1 else v

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['status','stake','withdraw','early-withdraw','preview-early-withdraw','claim']);p.add_argument('--account',required=True);p.add_argument('--amount');p.add_argument('--accept-early-penalty',action='store_true');a=p.parse_args()
    try:
        rpc=Rpc(os.environ.get('STAKED_READ_RPC','https://mainnet.base.org'));s=snapshot(rpc,a.account);result=plan(s,a.action,a.amount,a.accept_early_penalty)
        if a.action in ['early-withdraw','preview-early-withdraw']:
            raw=rpc('eth_call',[{'to':VAULT,'data':calldata('preview',aw(a.account),word(amount(a.amount)))},hex(s['block'])])
            if not re.fullmatch(r'0x[0-9a-fA-F]{256}',raw): raise ValueError('Invalid withdrawal preview')
            result['earlyPreviewWei']=dict(zip(['returnedStaked','burnedStaked','forfeitedUsdc','forfeitedBnkr'],[str(int(raw[i:i+64],16)) for i in range(2,len(raw),64)]))
            result['earlyPreviewWei']['remainingStaked']=str(s['stake']-amount(a.amount))
        if result.get('transaction'):
            tx=result['transaction']
            rpc('eth_call',[{k:tx[k] for k in ['from','to','value','data']},hex(s['block'])])
            if time.time()>result['expiresAt']: raise ValueError('Plan expired during reads; retry read-only')
            result['snapshotSimulation']='passed; repeat immediately before submission'
        for key in ['walletBalance','stake','allowance','earnedUsdc','earnedBnkr']:
            result['snapshot'][key]=str(result['snapshot'][key])
        print(json.dumps(json_safe(result),indent=2))
    except Exception as e:
        print(json.dumps({'error':str(e) if isinstance(e,ValueError) else 'Read failed; no transaction prepared','transaction':None}));sys.exit(1)
