import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FetchLike } from '../src/eth-rpc.js'
import { EthRpcClient } from '../src/eth-rpc.js'

test('getLogsInChunks scans from deployment block through latest in fixed ranges', async () => {
  const ranges: RpcLogRange[] = []
  const fetchFn: FetchLike = async (_input, init) => {
    const call = readRpcCall(init)
    if (call.method === 'eth_blockNumber') {
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x19' })
    }
    assert.equal(call.method, 'eth_getLogs')
    ranges.push(readLogRange(call.params))
    return jsonResponse({ jsonrpc: '2.0', id: 1, result: [] })
  }
  const client = new EthRpcClient({ rpcURL: 'http://rpc.local', fetchFn })

  const logs = await client.getLogsInChunks({
    address: CONTRACT_ADDRESS,
    topics: [TOPIC],
    fromBlock: 10n,
    chunkSize: 7n
  })

  assert.deepEqual(logs, [])
  assert.deepEqual(ranges, [
    { address: CONTRACT_ADDRESS, topic: TOPIC, fromBlock: '0xa', toBlock: '0x10' },
    { address: CONTRACT_ADDRESS, topic: TOPIC, fromBlock: '0x11', toBlock: '0x17' },
    { address: CONTRACT_ADDRESS, topic: TOPIC, fromBlock: '0x18', toBlock: '0x19' }
  ])
})

test('JSON-RPC error responses throw clear method-specific errors', async () => {
  const fetchFn: FetchLike = async () => jsonResponse({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32005, message: 'range too large' }
  })
  const client = new EthRpcClient({ rpcURL: 'http://rpc.local', fetchFn })

  await assert.rejects(
    async () => client.getBlockNumber(),
    /Ethereum RPC eth_blockNumber error -32005: range too large/
  )
})

const CONTRACT_ADDRESS = '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9'
const TOPIC = '0x3d09e10d1c966d01c4a2c14d0ac9af253486aa5e99b6cffe9019c4d43eb1fb23'

type RpcCall = {
  method: string
  params: unknown[]
}

type RpcLogRange = {
  address: string
  topic: string
  fromBlock: string
  toBlock: string
}

function jsonResponse (payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' }
  })
}

function readRpcCall (init: RequestInit | undefined): RpcCall {
  if (typeof init?.body !== 'string') throw new Error('expected string JSON-RPC request body')
  const parsed: unknown = JSON.parse(init.body)
  if (!isRecord(parsed)) throw new Error('expected JSON-RPC request object')
  const method = parsed['method']
  const params = parsed['params']
  if (typeof method !== 'string') throw new Error('expected JSON-RPC method')
  if (!Array.isArray(params)) throw new Error('expected JSON-RPC params array')
  return { method, params }
}

function readLogRange (params: unknown[]): RpcLogRange {
  const filter = params[0]
  if (!isRecord(filter)) throw new Error('expected eth_getLogs filter')
  const address = filter['address']
  const topics = filter['topics']
  const fromBlock = filter['fromBlock']
  const toBlock = filter['toBlock']
  if (typeof address !== 'string') throw new Error('expected filter address')
  if (!Array.isArray(topics)) throw new Error('expected filter topics')
  const topic = topics[0]
  if (typeof topic !== 'string') throw new Error('expected filter topic')
  if (typeof fromBlock !== 'string') throw new Error('expected filter fromBlock')
  if (typeof toBlock !== 'string') throw new Error('expected filter toBlock')
  return { address, topic, fromBlock, toBlock }
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
