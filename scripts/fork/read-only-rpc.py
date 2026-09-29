#!/usr/bin/env python3
"""Optional curl-backed read-only upstream for a local Anvil fork. Never forwards writes."""
import argparse
import hashlib
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--port', type=int, default=8554)
parser.add_argument('--cache', default='/tmp/staked-base-rpc-cache')
args = parser.parse_args()
# Separate endpoints so changing RPC/network cannot reuse another provider's state.
cache = Path(args.cache) / hashlib.sha256(args.url.encode()).hexdigest()[:16]
cache.mkdir(parents=True, exist_ok=True)
allowed = {'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber',
           'eth_getBlockByHash', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode',
           'eth_getStorageAt', 'eth_getProof', 'eth_call', 'eth_getTransactionByHash',
           'eth_getTransactionReceipt', 'eth_getLogs', 'eth_gasPrice'}
limit = threading.Semaphore(4)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *unused):
        pass

    def rpc(self, request):
        method = request.get('method')
        if method not in allowed:
            return {'jsonrpc': '2.0', 'id': request.get('id'), 'error': {'code': -32601, 'message': 'Read-only fork upstream: method denied'}}
        params = request.get('params', [])
        key = hashlib.sha256(json.dumps([method, params], sort_keys=True).encode()).hexdigest()
        filename = cache / (key + '.json')
        immutable = method not in {'eth_blockNumber', 'eth_gasPrice'} and not any(tag in json.dumps(params) for tag in ['latest', 'pending', 'safe', 'finalized'])
        if immutable and filename.exists():
            result = json.loads(filename.read_text())
            result['id'] = request.get('id')
            return result
        payload = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
        with limit:
            print(method, 'fetch', flush=True)
            for _ in range(3):
                response = subprocess.run(['curl', '-fsS', '--max-time', '20', args.url,
                    '-H', 'Content-Type: application/json', '--data', payload], capture_output=True, text=True)
                try:
                    result = json.loads(response.stdout)
                    if 'result' in result:
                        if immutable and result['result'] is not None:
                            filename.write_text(json.dumps(result))
                        result['id'] = request.get('id')
                        return result
                    if result.get('error', {}).get('code') != -32016:
                        result['id'] = request.get('id')
                        return result
                except (ValueError, TypeError):
                    continue
        return {'jsonrpc': '2.0', 'id': request.get('id'), 'error': {'code': -32000, 'message': 'Read-only upstream failed'}}

    def do_POST(self):
        try:
            request = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            result = [self.rpc(r) for r in request] if isinstance(request, list) else self.rpc(request)
            data = json.dumps(result).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (ValueError, BrokenPipeError):
            self.close_connection = True

print(f'Read-only fork upstream listening on 127.0.0.1:{args.port}', flush=True)
ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
