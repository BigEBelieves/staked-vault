import importlib.util,json,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('planner',ROOT/'skills/staked-vault/scripts/plan.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
class PlannerTests(unittest.TestCase):
 def setUp(self):
  self.s=dict(account='0x'+'1'*40,chainId=8453,vault=p.VAULT,token=p.TOKEN,timestamp=1000,block=99,walletBalance=10**30,stake=10**24,allowance=0,lockEnd=900,earnedUsdc=123,earnedBnkr=456)
 def test_exact_decimal(self): self.assertEqual(p.amount('100000.000000000000000001'),100000*10**18+1)
 def test_invalid_amounts(self):
  for a in ['0','-1','1e18','1,000',' 1','1.0000000000000000001',str(2**256),1.1,None]:
   with self.subTest(a=a),self.assertRaises(ValueError):p.amount(a)
 def test_status_read_only(self):self.assertIsNone(p.plan(self.s,'status')['transaction'])
 def test_approval_only_exact(self):
  r=p.plan(self.s,'stake','100000');t=r['transaction'];self.assertEqual(r['step'],'approve');self.assertEqual(t['to'],p.TOKEN);self.assertEqual(t['data'],'0x095ea7b3'+p.aw(p.VAULT)+p.word(10**23));self.assertEqual(t['value'],'0x0')
 def test_reduce_unlimited(self):
  self.s['allowance']=p.MAX;self.assertEqual(p.plan(self.s,'stake','1')['step'],'approve')
 def test_stake_after_approval(self):
  self.s['allowance']=10**18;r=p.plan(self.s,'stake','1');self.assertEqual(r['transaction']['data'],'0xa694fc3a'+p.word(10**18));self.assertIn('ENTIRE',r['warnings'][0])
 def test_insufficient_balance(self):
  self.s['walletBalance']=0
  with self.assertRaises(ValueError):p.plan(self.s,'stake','1')
 def test_locked_withdraw_stops(self):
  self.s['lockEnd']=1001
  with self.assertRaises(ValueError):p.plan(self.s,'withdraw','1')
 def test_unlock_boundary(self):
  self.s['lockEnd']=1000;self.assertEqual(p.plan(self.s,'withdraw','1')['step'],'withdraw')
 def test_overdraw(self):
  with self.assertRaises(ValueError):p.plan(self.s,'withdraw','1000001')
 def test_early_requires_consent(self):
  self.s['lockEnd']=1001
  with self.assertRaises(ValueError):p.plan(self.s,'early-withdraw','1')
 def test_partial_early_all_rewards_warning(self):
  self.s['lockEnd']=1001;r=p.plan(self.s,'early-withdraw','1',True);self.assertIn('ALL pending',r['warnings'][0]);self.assertEqual(r['transaction']['to'],p.VAULT)
 def test_early_preview_without_consent(self):
  self.s['lockEnd']=1001;self.assertIsNone(p.plan(self.s,'preview-early-withdraw','1')['transaction'])
 def test_early_preview_overdraw(self):
  self.s['lockEnd']=1001
  with self.assertRaises(ValueError):p.plan(self.s,'preview-early-withdraw','1000001')
 def test_mature_early_stops(self):
  with self.assertRaises(ValueError):p.plan(self.s,'early-withdraw','1',True)
 def test_locked_claim_stops(self):
  self.s['lockEnd']=1001
  with self.assertRaises(ValueError):p.plan(self.s,'claim')
 def test_claim_no_approval(self):self.assertEqual(p.plan(self.s,'claim')['transaction']['data'],'0x3d18b912')
 def test_empty_claim_stops(self):
  self.s['earnedUsdc']=self.s['earnedBnkr']=0
  with self.assertRaises(ValueError):p.plan(self.s,'claim')
 def test_wrong_identity(self):
  for k,v in [('chainId',1),('vault',p.TOKEN),('token',p.VAULT),('account','0x'+'0'*40)]:
   with self.subTest(k=k),self.assertRaises(ValueError):p.plan({**self.s,k:v},'stake','1')
 def test_unknown_action(self):
  with self.assertRaises(ValueError):p.plan(self.s,'exit')
 def test_no_sending_rpc(self):
  for method in ['eth_sendTransaction','eth_sendRawTransaction','personal_sign','eth_signTypedData_v4']:
   with self.subTest(method=method),self.assertRaises(ValueError):p.Rpc('https://example.org')(method,[])
 def test_json_precision(self):self.assertEqual(p.json_safe({'amount':10**30}),{'amount':str(10**30)})
 def test_uint_range(self):
  for x in [-1,True,2**256]:
   with self.assertRaises(ValueError):p.word(x)
 def test_snapshot_wrong_chain(self):
  with self.assertRaises(ValueError):p.snapshot(lambda m,a:'0x1',self.s['account'],now=1000)
 def test_snapshot_stale(self):
  def rpc(m,a):return {'eth_chainId':'0x2105','eth_blockNumber':'0x63','eth_getBlockByNumber':{'timestamp':'0x1','hash':'0xabc'}}[m]
  with self.assertRaisesRegex(ValueError,'Stale'):p.snapshot(rpc,self.s['account'],now=1000)
 def test_snapshot_code_mismatch(self):
  def rpc(m,a):return {'eth_chainId':'0x2105','eth_blockNumber':'0x63','eth_getBlockByNumber':{'timestamp':hex(1000),'hash':'0xabc'},'eth_getCode':'0x00'}[m]
  with self.assertRaisesRegex(ValueError,'code mismatch'):p.snapshot(rpc,self.s['account'],now=1000)
 def test_pinned_snapshot_and_reorg(self):
  import hashlib
  manifest={'runtimeSha256':{x:hashlib.sha256(b'\x00').hexdigest() for x in [p.VAULT,p.TOKEN]}}
  seen=[];blocks=0
  def rpc(m,a):
   nonlocal blocks
   seen.append((m,a))
   if m=='eth_chainId':return '0x2105'
   if m=='eth_blockNumber':return '0x63'
   if m=='eth_getBlockByNumber':
    blocks+=1;return {'timestamp':hex(1000),'hash':'0xabc' if blocks==1 else '0xdef'}
   if m=='eth_getCode':return '0x00'
   selector=a[0]['data'][2:10];values={p.SEL['token']:int(p.TOKEN,16),p.SEL['usdc']:int(p.USDC,16),p.SEL['bnkr']:int(p.BNKR,16),p.SEL['duration']:604800,p.SEL['penalty']:2000}
   return '0x'+p.word(values.get(selector,0))
  with patch.object(Path,'read_text',side_effect=FileNotFoundError('not mirrored')),patch.object(p,'RUNTIME_SHA256',manifest['runtimeSha256']),self.assertRaisesRegex(ValueError,'reorganized'):p.snapshot(rpc,self.s['account'],now=1000)
  for m,a in seen:
   if m in ['eth_getCode','eth_call']:self.assertEqual(a[-1],'0x63')
class TransportTests(unittest.TestCase):
 def test_manifest_embedded_matches_audit_file(self):
  m=json.loads((ROOT/'skills/staked-vault/references/contracts.json').read_text())
  self.assertEqual(p.RUNTIME_SHA256,m['runtimeSha256'])
 def test_curl_verified_tls_post(self):
  from types import SimpleNamespace
  response=SimpleNamespace(returncode=0,stdout=b'{"jsonrpc":"2.0","id":1,"result":"0x2105"}\n200')
  with patch.object(p.subprocess,'run',return_value=response) as run,patch.object(p.time,'sleep'):
   self.assertEqual(p.Rpc('https://example.org','curl')('eth_chainId',[]),'0x2105')
  args=run.call_args.args[0];self.assertEqual(args[:2],['curl','-q']);self.assertNotIn('--insecure',args);self.assertNotIn('-k',args)
  self.assertIn('POST',args);self.assertIn('@-',args);self.assertEqual(json.loads(run.call_args.kwargs['input'])['method'],'eth_chainId')
 def test_curl_tls_error_stops(self):
  from types import SimpleNamespace
  with patch.object(p.subprocess,'run',return_value=SimpleNamespace(returncode=60)),patch.object(p.time,'sleep'),self.assertRaisesRegex(ValueError,'TLS verification'):
   p.Rpc('https://example.org','curl')('eth_chainId',[])
 def test_http_forbidden_no_retry_or_fallback(self):
  with patch.object(p.Rpc,'request',return_value=(403,b'')) as request,patch.object(p.time,'sleep'),self.assertRaisesRegex(ValueError,'HTTP 403'):
   p.Rpc('https://example.org')('eth_chainId',[])
  self.assertEqual(request.call_count,1)
 def test_get_success_is_not_rpc_success(self):
  with patch.object(p.Rpc,'request',return_value=(200,b'<html>OK</html>')),patch.object(p.time,'sleep'),self.assertRaisesRegex(ValueError,'non-JSON'):
   p.Rpc('https://example.org')('eth_chainId',[])
 def test_wrong_response_id_stops(self):
  with patch.object(p.Rpc,'request',return_value=(200,b'{"jsonrpc":"2.0","id":2,"result":"0x2105"}')),patch.object(p.time,'sleep'),self.assertRaisesRegex(ValueError,'Malformed'):
   p.Rpc('https://example.org')('eth_chainId',[])
 def test_invalid_transport(self):
  with self.assertRaises(ValueError):p.Rpc('https://example.org','insecure')
 def test_forbidden_urls(self):
  for url in ['http://example.org','https://','https://user:secret@example.org','https://example.org/#secret']:
   with self.subTest(url=url),self.assertRaises(ValueError):p.Rpc(url)
 def test_python_verified_context_and_header(self):
  from unittest.mock import MagicMock
  response=MagicMock();response.__enter__.return_value.status=200;response.__enter__.return_value.read.return_value=b'{"jsonrpc":"2.0","id":1,"result":"0x2105"}'
  with patch.object(p.ssl,'create_default_context',return_value='verified') as ctx,patch.object(p.urllib.request,'urlopen',return_value=response) as call,patch.object(p.time,'sleep'):
   self.assertEqual(p.Rpc('https://example.org','python')('eth_chainId',[]),'0x2105')
   ctx.assert_called_once_with();self.assertEqual(call.call_args.kwargs['context'],'verified')
   self.assertEqual(call.call_args.args[0].get_header('User-agent'),'StakedVaultPlanner/1.1')
if __name__=='__main__':unittest.main()
