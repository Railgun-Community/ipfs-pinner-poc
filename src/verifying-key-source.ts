import { CID } from 'multiformats/cid'

import type { EthGetLogsChunkedOptions, EthLog } from './eth-rpc.js'
import { EthRpcClient } from './eth-rpc.js'
import { logger } from './logger.js'
import type { PinEntry, PinSource } from './types.js'

const VERIFYING_KEY_SET_TOPIC = '0x3d09e10d1c966d01c4a2c14d0ac9af253486aa5e99b6cffe9019c4d43eb1fb23'
const ABI_WORD_BYTES = 32
const ABI_WORD_HEX_LENGTH = ABI_WORD_BYTES * 2
const TOP_LEVEL_VERIFYING_KEY_OFFSET_BYTE = ABI_WORD_BYTES * 2

type VerifyingKeySourceConfig = {
  chainId: number
  rpcURL: string | undefined
  contractAddress: string
  deploymentBlock: bigint
}

type VerifyingKeyLogFetcher = (options: EthGetLogsChunkedOptions) => Promise<EthLog[]>

type VerifyingKeySourceDependencies = {
  fetchLogs?: VerifyingKeyLogFetcher
}

type DecodedVerifyingKeySet = {
  nullifiers: bigint
  commitments: bigint
  artifactsIPFSHash: string
}

class VerifyingKeySource implements PinSource {
  #chainId: number
  #rpcURL: string | undefined
  #contractAddress: string
  #deploymentBlock: bigint
  #fetchLogs: VerifyingKeyLogFetcher | undefined

  constructor (config: VerifyingKeySourceConfig, dependencies: VerifyingKeySourceDependencies = {}) {
    this.#chainId = config.chainId
    this.#rpcURL = config.rpcURL?.trim()
    this.#contractAddress = config.contractAddress
    this.#deploymentBlock = config.deploymentBlock
    this.#fetchLogs = dependencies.fetchLogs
  }

  async collect (): Promise<PinEntry[]> {
    const rpcURL = this.#rpcURL
    if (rpcURL === undefined || rpcURL === '') {
      logger.warn('verifying key source has no RPC URL, skipping', {
        chainId: this.#chainId,
        contractAddress: this.#contractAddress
      })
      return []
    }

    const logs = await this.#collectLogs(rpcURL)
    const entries: PinEntry[] = []
    for (const log of logs) {
      let decoded: DecodedVerifyingKeySet
      try {
        decoded = decodeVerifyingKeySetLog(log)
      } catch (error) {
        logger.warn('verifying key log failed to decode, skipping', {
          chainId: this.#chainId,
          contractAddress: this.#contractAddress,
          error: error instanceof Error ? error.message : String(error)
        })
        continue
      }

      let cid: CID
      try {
        cid = CID.parse(decoded.artifactsIPFSHash)
      } catch {
        logger.warn('verifying key event has invalid artifacts CID, skipping', {
          chainId: this.#chainId,
          nullifiers: decoded.nullifiers,
          commitments: decoded.commitments,
          cid: decoded.artifactsIPFSHash
        })
        continue
      }

      entries.push({
        cid,
        name: `railgun/${this.#chainId.toString()}/vkey/${decoded.nullifiers.toString()}x${decoded.commitments.toString()}`
      })
    }

    return entries
  }

  async #collectLogs (rpcURL: string): Promise<EthLog[]> {
    const options: EthGetLogsChunkedOptions = {
      address: this.#contractAddress,
      topics: [VERIFYING_KEY_SET_TOPIC],
      fromBlock: this.#deploymentBlock
    }
    if (this.#fetchLogs !== undefined) return this.#fetchLogs(options)
    return new EthRpcClient({ rpcURL }).getLogsInChunks(options)
  }
}

function decodeVerifyingKeySetLog (log: EthLog): DecodedVerifyingKeySet {
  const topic = log.topics[0]
  if (topic?.toLowerCase() !== VERIFYING_KEY_SET_TOPIC) {
    throw new Error(`log topic is not VerifyingKeySet: ${topic ?? 'missing'}`)
  }
  return decodeVerifyingKeySetData(log.data)
}

function decodeVerifyingKeySetData (data: string): DecodedVerifyingKeySet {
  const dataHex = normalizeAbiData(data)
  const nullifiers = readAbiUint256(dataHex, 0)
  const commitments = readAbiUint256(dataHex, ABI_WORD_BYTES)
  const verifyingKeyOffset = readAbiOffset(dataHex, 0, TOP_LEVEL_VERIFYING_KEY_OFFSET_BYTE, 'verifyingKey offset')
  const artifactsIPFSHashOffset = readAbiOffset(
    dataHex,
    verifyingKeyOffset,
    verifyingKeyOffset,
    'artifactsIPFSHash offset'
  )
  const artifactsIPFSHash = readAbiString(dataHex, artifactsIPFSHashOffset)

  return { nullifiers, commitments, artifactsIPFSHash }
}

function normalizeAbiData (data: string): string {
  if (!/^0x[0-9a-fA-F]*$/.test(data)) throw new Error('ABI data is not hex')
  const dataHex = data.slice(2)
  if (dataHex.length % ABI_WORD_HEX_LENGTH !== 0) throw new Error('ABI data is not word-aligned')
  return dataHex
}

function readAbiUint256 (dataHex: string, byteOffset: number): bigint {
  const start = byteOffset * 2
  const end = start + ABI_WORD_HEX_LENGTH
  const word = dataHex.slice(start, end)
  if (word.length !== ABI_WORD_HEX_LENGTH) throw new Error(`ABI word out of range at byte offset ${byteOffset.toString()}`)
  return BigInt(`0x${word}`)
}

function readAbiOffset (dataHex: string, baseByteOffset: number, offsetWordByteOffset: number, label: string): number {
  const offset = readAbiUint256(dataHex, offsetWordByteOffset)
  if (offset % BigInt(ABI_WORD_BYTES) !== 0n) throw new Error(`ABI ${label} is not word-aligned`)
  const relativeByteOffset = bigintToSafeByteOffset(offset, label)
  const absoluteByteOffset = baseByteOffset + relativeByteOffset
  if (absoluteByteOffset > dataHex.length / 2) throw new Error(`ABI ${label} points outside data`)
  return absoluteByteOffset
}

function readAbiString (dataHex: string, byteOffset: number): string {
  const byteLength = bigintToSafeByteOffset(readAbiUint256(dataHex, byteOffset), 'string length')
  const valueByteOffset = byteOffset + ABI_WORD_BYTES
  const valueHexStart = valueByteOffset * 2
  const valueHexEnd = valueHexStart + byteLength * 2
  if (valueHexEnd > dataHex.length) throw new Error('ABI string extends outside data')
  return new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(dataHex.slice(valueHexStart, valueHexEnd)))
}

function bigintToSafeByteOffset (value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`ABI ${label} exceeds safe JavaScript range`)
  // String slicing requires number indexes after ABI offsets and lengths are bounds-checked.
  return Number(value)
}

function hexToBytes (hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

export { VERIFYING_KEY_SET_TOPIC, VerifyingKeySource, decodeVerifyingKeySetData, decodeVerifyingKeySetLog }
export type { DecodedVerifyingKeySet, VerifyingKeyLogFetcher, VerifyingKeySourceConfig, VerifyingKeySourceDependencies }
