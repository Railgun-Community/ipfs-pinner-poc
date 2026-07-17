import { CID } from 'multiformats/cid'

import type { EthCallRequest, EthGetLogsChunkedOptions, EthLog } from './eth-rpc.js'
import { EthRpcClient } from './eth-rpc.js'
import { logger } from './logger.js'
import type { PinEntry, PinSource } from './types.js'

// Derived with `cast sig-event 'Proposal(uint256,address)'`.
const VOTING_PROPOSAL_TOPIC = '0xe56c149b9a4f632c327b2bc8b691ebfd0d76354ca7b678faea1effbd9d9f223d'
// Derived with `cast sig "proposals(uint256)"`.
const PROPOSALS_SELECTOR = '0x013cf08b'
const ABI_WORD_BYTES = 32
const ABI_WORD_HEX_LENGTH = ABI_WORD_BYTES * 2
const ADDRESS_BYTES = 20
const ADDRESS_HEX_LENGTH = ADDRESS_BYTES * 2
const ADDRESS_PADDING_HEX_LENGTH = ABI_WORD_HEX_LENGTH - ADDRESS_HEX_LENGTH
const PROPOSAL_GETTER_HEAD_WORDS = 10
const PROPOSAL_DOCUMENT_OFFSET_WORD_BYTE_OFFSET = ABI_WORD_BYTES * 2
const MAX_UINT256 = (1n << 256n) - 1n

type VotingProposalSourceConfig = {
  chainId: number
  rpcURL: string | undefined
  contractAddress: string
  deploymentBlock: bigint
}

type VotingProposalLogFetcher = (options: EthGetLogsChunkedOptions) => Promise<EthLog[]>
type VotingProposalCallFetcher = (request: EthCallRequest, blockTag: string) => Promise<string>

type VotingProposalSourceDependencies = {
  fetchLogs?: VotingProposalLogFetcher
  call?: VotingProposalCallFetcher
}

type DecodedProposalLog = {
  id: bigint
  proposer: string
}

class VotingProposalSource implements PinSource {
  #chainId: number
  #rpcURL: string | undefined
  #contractAddress: string
  #deploymentBlock: bigint
  #fetchLogs: VotingProposalLogFetcher | undefined
  #call: VotingProposalCallFetcher | undefined

  constructor (config: VotingProposalSourceConfig, dependencies: VotingProposalSourceDependencies = {}) {
    this.#chainId = config.chainId
    this.#rpcURL = config.rpcURL?.trim()
    this.#contractAddress = config.contractAddress
    this.#deploymentBlock = config.deploymentBlock
    this.#fetchLogs = dependencies.fetchLogs
    this.#call = dependencies.call
  }

  async collect (): Promise<PinEntry[]> {
    const rpcURL = this.#rpcURL
    if (rpcURL === undefined || rpcURL === '') {
      logger.warn('voting proposal source has no RPC URL, skipping', {
        chainId: this.#chainId,
        contractAddress: this.#contractAddress
      })
      return []
    }

    const logs = await this.#collectLogs(rpcURL)
    const entries: PinEntry[] = []
    for (const log of logs) {
      let decodedLog: DecodedProposalLog
      try {
        decodedLog = decodeProposalLog(log)
      } catch (error) {
        logger.warn('voting proposal log failed to decode, skipping', {
          chainId: this.#chainId,
          contractAddress: this.#contractAddress,
          error: error instanceof Error ? error.message : String(error)
        })
        continue
      }

      const result = await this.#callProposal(rpcURL, decodedLog.id)
      let proposalDocument: string
      try {
        proposalDocument = decodeProposalDocument(result)
      } catch (error) {
        logger.warn('voting proposal getter failed to decode, skipping', {
          chainId: this.#chainId,
          contractAddress: this.#contractAddress,
          id: decodedLog.id,
          proposer: decodedLog.proposer,
          error: error instanceof Error ? error.message : String(error)
        })
        continue
      }

      let cid: CID
      try {
        cid = CID.parse(proposalDocument)
      } catch {
        logger.warn('voting proposal has invalid document CID, skipping', {
          chainId: this.#chainId,
          id: decodedLog.id,
          proposer: decodedLog.proposer,
          cid: proposalDocument
        })
        continue
      }

      entries.push({
        cid,
        name: `railgun/${this.#chainId.toString()}/gov-proposal/${decodedLog.id.toString()}`
      })
    }

    return entries
  }

  async #collectLogs (rpcURL: string): Promise<EthLog[]> {
    const options: EthGetLogsChunkedOptions = {
      address: this.#contractAddress,
      topics: [VOTING_PROPOSAL_TOPIC],
      fromBlock: this.#deploymentBlock
    }
    if (this.#fetchLogs !== undefined) return this.#fetchLogs(options)
    return new EthRpcClient({ rpcURL }).getLogsInChunks(options)
  }

  async #callProposal (rpcURL: string, id: bigint): Promise<string> {
    const request: EthCallRequest = {
      to: this.#contractAddress,
      data: encodeProposalsCall(id)
    }
    if (this.#call !== undefined) return this.#call(request, 'latest')
    return new EthRpcClient({ rpcURL }).call(request)
  }
}

function decodeProposalLog (log: EthLog): DecodedProposalLog {
  const topic = log.topics[0]
  if (topic?.toLowerCase() !== VOTING_PROPOSAL_TOPIC) {
    throw new Error(`log topic is not Proposal: ${topic ?? 'missing'}`)
  }
  if (log.data !== '0x') throw new Error('Proposal log data is not empty')
  return {
    id: readIndexedUint256(log.topics[1], 'proposal id'),
    proposer: readIndexedAddress(log.topics[2], 'proposer')
  }
}

function encodeProposalsCall (id: bigint): string {
  return `${PROPOSALS_SELECTOR}${uint256ToAbiWord(id)}`
}

function decodeProposalDocument (data: string): string {
  const dataHex = normalizeAbiData(data)
  const proposalDocumentOffset = readAbiOffset(
    dataHex,
    0,
    PROPOSAL_DOCUMENT_OFFSET_WORD_BYTE_OFFSET,
    PROPOSAL_GETTER_HEAD_WORDS * ABI_WORD_BYTES,
    'proposalDocument offset'
  )
  return readAbiString(dataHex, proposalDocumentOffset)
}

function normalizeAbiData (data: string): string {
  if (!/^0x[0-9a-fA-F]*$/.test(data)) throw new Error('ABI data is not hex')
  const dataHex = data.slice(2)
  if (dataHex.length % ABI_WORD_HEX_LENGTH !== 0) throw new Error('ABI data is not word-aligned')
  return dataHex
}

function readIndexedUint256 (topic: string | undefined, label: string): bigint {
  return BigInt(`0x${normalizeAbiTopic(topic, label)}`)
}

function readIndexedAddress (topic: string | undefined, label: string): string {
  const topicHex = normalizeAbiTopic(topic, label).toLowerCase()
  const padding = topicHex.slice(0, ADDRESS_PADDING_HEX_LENGTH)
  if (padding !== '0'.repeat(ADDRESS_PADDING_HEX_LENGTH)) throw new Error(`ABI indexed ${label} is not an address`)
  return `0x${topicHex.slice(ADDRESS_PADDING_HEX_LENGTH)}`
}

function normalizeAbiTopic (topic: string | undefined, label: string): string {
  if (topic === undefined) throw new Error(`ABI indexed ${label} is missing`)
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) throw new Error(`ABI indexed ${label} is not a word`)
  return topic.slice(2)
}

function readAbiUint256 (dataHex: string, byteOffset: number): bigint {
  const start = byteOffset * 2
  const end = start + ABI_WORD_HEX_LENGTH
  const word = dataHex.slice(start, end)
  if (word.length !== ABI_WORD_HEX_LENGTH) throw new Error(`ABI word out of range at byte offset ${byteOffset.toString()}`)
  return BigInt(`0x${word}`)
}

function readAbiOffset (
  dataHex: string,
  baseByteOffset: number,
  offsetWordByteOffset: number,
  minimumAbsoluteByteOffset: number,
  label: string
): number {
  const offset = readAbiUint256(dataHex, offsetWordByteOffset)
  if (offset % BigInt(ABI_WORD_BYTES) !== 0n) throw new Error(`ABI ${label} is not word-aligned`)
  const relativeByteOffset = bigintToSafeByteOffset(offset, label)
  const absoluteByteOffset = baseByteOffset + relativeByteOffset
  if (absoluteByteOffset < minimumAbsoluteByteOffset) throw new Error(`ABI ${label} points inside static head`)
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

function uint256ToAbiWord (value: bigint): string {
  if (value < 0n || value > MAX_UINT256) throw new Error(`Invalid uint256: ${value.toString()}`)
  return value.toString(16).padStart(ABI_WORD_HEX_LENGTH, '0')
}

function hexToBytes (hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

export {
  PROPOSALS_SELECTOR,
  VOTING_PROPOSAL_TOPIC,
  VotingProposalSource,
  decodeProposalDocument,
  decodeProposalLog,
  encodeProposalsCall
}
export type {
  DecodedProposalLog,
  VotingProposalCallFetcher,
  VotingProposalLogFetcher,
  VotingProposalSourceConfig,
  VotingProposalSourceDependencies
}
