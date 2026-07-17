import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import type { EthCallRequest, EthGetLogsChunkedOptions, EthLog } from '../src/eth-rpc.js'
import { logger } from '../src/logger.js'
import {
  DEFAULT_GOVERNANCE_PROPOSAL_MAX_DAG_SIZE_BYTES,
  VOTING_PROPOSAL_TOPIC,
  VotingProposalSource,
  decodeProposalDocument,
  decodeProposalLog,
  encodeProposalsCall
} from '../src/voting-proposal-source.js'

const VALID_CID = 'QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU'
const CONTRACT_ADDRESS = '0xc480F68A3dcC3EdD82134FAB45C14A0FcF1dA3CC'
const PROPOSER_ADDRESS = '0x1234567890AbCdEf1234567890aBcdef12345678'
const ABI_WORD_BYTES = 32
const ABI_WORD_HEX_LENGTH = ABI_WORD_BYTES * 2
const PROPOSAL_GETTER_HEAD_WORDS = 10

type Warning = {
  message: string
  fields: Record<string, unknown> | undefined
}

type RecordedCall = {
  request: EthCallRequest
  blockTag: string
}

const originalWarn = logger.warn

afterEach(() => {
  logger.warn = originalWarn
})

test('decodes a proposals(id) response payload', () => {
  const decoded = decodeProposalDocument(encodeProposalGetterResult(VALID_CID))

  assert.equal(decoded, VALID_CID)
})

test('collect skips malformed proposal document CIDs with a warning', async () => {
  const warnings = captureWarnings()
  const source = new VotingProposalSource({
    chainId: 1,
    rpcURL: 'http://rpc.local',
    contractAddress: CONTRACT_ADDRESS,
    deploymentBlock: 15505853n
  }, {
    fetchLogs: async () => [makeLog(2n)],
    call: async () => encodeProposalGetterResult('not-a-cid')
  })

  const entries = await source.collect()

  assert.deepEqual(entries, [])
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.message, 'voting proposal has invalid document CID, skipping')
})

test('collect skips empty proposal document strings with a warning', async () => {
  const warnings = captureWarnings()
  const source = new VotingProposalSource({
    chainId: 1,
    rpcURL: 'http://rpc.local',
    contractAddress: CONTRACT_ADDRESS,
    deploymentBlock: 15505853n
  }, {
    fetchLogs: async () => [makeLog(3n)],
    call: async () => encodeProposalGetterResult('')
  })

  const entries = await source.collect()

  assert.deepEqual(entries, [])
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.message, 'voting proposal has invalid document CID, skipping')
})

test('collect skips a chain with no RPC URL without fetching logs or calling proposals', async () => {
  const warnings = captureWarnings()
  let fetchCalled = false
  let callCalled = false
  const source = new VotingProposalSource({
    chainId: 1,
    rpcURL: undefined,
    contractAddress: CONTRACT_ADDRESS,
    deploymentBlock: 15505853n
  }, {
    fetchLogs: async () => {
      fetchCalled = true
      return []
    },
    call: async () => {
      callCalled = true
      return encodeProposalGetterResult(VALID_CID)
    }
  })

  const entries = await source.collect()

  assert.deepEqual(entries, [])
  assert.equal(fetchCalled, false)
  assert.equal(callCalled, false)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.message, 'voting proposal source has no RPC URL, skipping')
})

test('collect formats voting proposal pin names from chain and proposal id', async () => {
  let fetchOptions: EthGetLogsChunkedOptions | undefined
  const calls: RecordedCall[] = []
  const source = new VotingProposalSource({
    chainId: 1,
    rpcURL: 'http://rpc.local',
    contractAddress: CONTRACT_ADDRESS,
    deploymentBlock: 15505853n
  }, {
    fetchLogs: async options => {
      fetchOptions = options
      return [makeLog(24n)]
    },
    call: async (request, blockTag) => {
      calls.push({ request, blockTag })
      return encodeProposalGetterResult(VALID_CID)
    }
  })

  const entries = await source.collect()

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.cid.toString(), VALID_CID)
  assert.equal(entries[0]?.name, 'railgun/1/gov-proposal/24')
  assert.equal(entries[0]?.maxDagSizeBytes, DEFAULT_GOVERNANCE_PROPOSAL_MAX_DAG_SIZE_BYTES)
  assert.equal(fetchOptions?.address, CONTRACT_ADDRESS)
  assert.deepEqual(fetchOptions?.topics, [VOTING_PROPOSAL_TOPIC])
  assert.equal(fetchOptions?.fromBlock, 15505853n)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.request.to, CONTRACT_ADDRESS)
  assert.equal(calls[0]?.request.data, encodeProposalsCall(24n))
  assert.equal(calls[0]?.blockTag, 'latest')
})

test('decodes a Proposal event log from indexed topics', () => {
  const decoded = decodeProposalLog(makeLog(17n, PROPOSER_ADDRESS))

  assert.equal(decoded.id, 17n)
  assert.equal(decoded.proposer, PROPOSER_ADDRESS.toLowerCase())
})

function captureWarnings (): Warning[] {
  const warnings: Warning[] = []
  logger.warn = (message: string, fields?: Record<string, unknown>) => {
    warnings.push({ message, fields })
  }
  return warnings
}

function makeLog (id: bigint, proposer = PROPOSER_ADDRESS): EthLog {
  return {
    address: CONTRACT_ADDRESS,
    topics: [VOTING_PROPOSAL_TOPIC, topicWord(id), addressTopic(proposer)],
    data: '0x'
  }
}

function encodeProposalGetterResult (proposalDocument: string): string {
  const documentTail = encodeAbiString(proposalDocument)
  const documentOffset = BigInt(PROPOSAL_GETTER_HEAD_WORDS * ABI_WORD_BYTES)
  return `0x${
    word(1n)
  }${
    addressWord(PROPOSER_ADDRESS)
  }${
    word(documentOffset)
  }${
    word(1_710_000_000n)
  }${
    word(1_710_000_100n)
  }${
    word(10n)
  }${
    word(20n)
  }${
    word(3n)
  }${
    word(600n)
  }${
    word(86_400n)
  }${
    documentTail
  }`
}

function encodeAbiString (value: string): string {
  const valueHex = bytesToHex(new TextEncoder().encode(value))
  return `${word(BigInt(valueHex.length / 2))}${padHexToWord(valueHex)}`
}

function topicWord (value: bigint): string {
  return `0x${word(value)}`
}

function addressTopic (address: string): string {
  return `0x${addressWord(address)}`
}

function addressWord (address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`invalid address: ${address}`)
  return address.slice(2).padStart(ABI_WORD_HEX_LENGTH, '0')
}

function word (value: bigint): string {
  return value.toString(16).padStart(ABI_WORD_HEX_LENGTH, '0')
}

function padHexToWord (hex: string): string {
  const remainder = hex.length % ABI_WORD_HEX_LENGTH
  if (remainder === 0) return hex
  return hex.padEnd(hex.length + ABI_WORD_HEX_LENGTH - remainder, '0')
}

function bytesToHex (bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
