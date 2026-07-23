import { logger } from './logger.js'

const DEFAULT_GET_LOGS_CHUNK_SIZE = 5_000n

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

type EthRpcClientOptions = {
  rpcURL: string
  fetchFn?: FetchLike
}

type EthLog = {
  address: string
  topics: string[]
  data: string
  blockNumber?: string
  transactionHash?: string
  logIndex?: string
}

type EthGetLogsFilter = {
  address: string
  topics: readonly string[]
  fromBlock: bigint
  toBlock: bigint
}

type EthGetLogsChunkedOptions = {
  address: string
  topics: readonly string[]
  fromBlock: bigint
  toBlock?: bigint
  chunkSize?: bigint
}

type EthCallRequest = {
  to: string
  data: string
}

type JsonRpcErrorObject = {
  code: number
  message: string
  data?: unknown
}

class EthRpcClient {
  #rpcURL: string
  #fetch: FetchLike
  #nextId = 1

  constructor (options: EthRpcClientOptions) {
    this.#rpcURL = options.rpcURL
    this.#fetch = options.fetchFn ?? fetch
  }

  async getBlockNumber (): Promise<bigint> {
    const result = await this.#request('eth_blockNumber', [])
    if (!isHexString(result)) throw new Error('Ethereum RPC eth_blockNumber returned non-hex result')
    return parseRpcHexBigInt(result, 'eth_blockNumber result')
  }

  async getLogs (filter: EthGetLogsFilter): Promise<EthLog[]> {
    const result = await this.#request('eth_getLogs', [{
      address: filter.address,
      topics: [...filter.topics],
      fromBlock: blockNumberToRpcHex(filter.fromBlock),
      toBlock: blockNumberToRpcHex(filter.toBlock)
    }])
    if (!isEthLogArray(result)) throw new Error('Ethereum RPC eth_getLogs returned invalid logs result')
    return result
  }

  async call (request: EthCallRequest, blockTag = 'latest'): Promise<string> {
    const result = await this.#request('eth_call', [{
      to: request.to,
      data: request.data
    }, blockTag])
    if (!isHexString(result)) throw new Error('Ethereum RPC eth_call returned non-hex result')
    return result
  }

  async getLogsInChunks (options: EthGetLogsChunkedOptions): Promise<EthLog[]> {
    const chunkSize = options.chunkSize ?? DEFAULT_GET_LOGS_CHUNK_SIZE
    if (chunkSize <= 0n) throw new Error(`Invalid eth_getLogs chunk size: ${chunkSize.toString()}`)

    const latestBlock = options.toBlock ?? await this.getBlockNumber()
    if (latestBlock < options.fromBlock) return []

    const totalChunks = ((latestBlock - options.fromBlock) / chunkSize) + 1n
    let chunkIndex = 0n

    const logs: EthLog[] = []
    let fromBlock = options.fromBlock
    while (fromBlock <= latestBlock) {
      const chunkEndCandidate = fromBlock + chunkSize - 1n
      const toBlock = chunkEndCandidate < latestBlock ? chunkEndCandidate : latestBlock
      chunkIndex++
      logger.info('eth_getLogs chunk', {
        address: options.address,
        fromBlock,
        toBlock,
        chunk: chunkIndex,
        totalChunks
      })
      logs.push(...await this.getLogs({
        address: options.address,
        topics: options.topics,
        fromBlock,
        toBlock
      }))
      fromBlock = toBlock + 1n
    }
    return logs
  }

  async #request (method: string, params: unknown[]): Promise<unknown> {
    const response = await this.#fetch(this.#rpcURL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.#nextId++,
        method,
        params
      })
    })
    if (!response.ok) {
      throw new Error(`Ethereum RPC ${method} HTTP failure: ${response.status} ${await response.text()}`)
    }

    const payload: unknown = await response.json()
    if (!isRecord(payload)) throw new Error(`Ethereum RPC ${method} returned non-object response`)
    if (Object.hasOwn(payload, 'error')) {
      const error = payload['error']
      if (isJsonRpcErrorObject(error)) {
        throw new Error(`Ethereum RPC ${method} error ${error.code.toString()}: ${error.message}`)
      }
      throw new Error(`Ethereum RPC ${method} returned malformed error response`)
    }
    if (!Object.hasOwn(payload, 'result')) throw new Error(`Ethereum RPC ${method} returned response without result`)
    return payload['result']
  }
}

function blockNumberToRpcHex (blockNumber: bigint): string {
  if (blockNumber < 0n) throw new Error(`Invalid negative block number: ${blockNumber.toString()}`)
  // Ethereum JSON-RPC requires block numbers as hex strings at the request boundary.
  return `0x${blockNumber.toString(16)}`
}

function parseRpcHexBigInt (value: string, label: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`)
  return BigInt(value)
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHexString (value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)
}

function isEthLogArray (value: unknown): value is EthLog[] {
  return Array.isArray(value) && value.every(isEthLog)
}

function isEthLog (value: unknown): value is EthLog {
  if (!isRecord(value)) return false
  return (
    isHexString(value['address']) &&
    Array.isArray(value['topics']) &&
    value['topics'].every(isHexString) &&
    isHexString(value['data']) &&
    isOptionalHexString(value['blockNumber']) &&
    isOptionalHexString(value['transactionHash']) &&
    isOptionalHexString(value['logIndex'])
  )
}

function isOptionalHexString (value: unknown): value is string | undefined {
  return value === undefined || isHexString(value)
}

function isJsonRpcErrorObject (value: unknown): value is JsonRpcErrorObject {
  if (!isRecord(value)) return false
  return typeof value['code'] === 'number' && typeof value['message'] === 'string'
}

export { DEFAULT_GET_LOGS_CHUNK_SIZE, EthRpcClient }
export type { EthCallRequest, EthGetLogsChunkedOptions, EthGetLogsFilter, EthLog, EthRpcClientOptions, FetchLike }
