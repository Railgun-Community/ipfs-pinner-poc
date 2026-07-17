import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import type { EthGetLogsChunkedOptions, EthLog } from '../src/eth-rpc.js'
import { logger } from '../src/logger.js'
import {
  VERIFYING_KEY_SET_TOPIC,
  VerifyingKeySource,
  decodeVerifyingKeySetLog
} from '../src/verifying-key-source.js'

const VALID_CID = 'QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU'
const CONTRACT_ADDRESS = '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9'
const ABI_WORD_BYTES = 32
const ABI_WORD_HEX_LENGTH = ABI_WORD_BYTES * 2
const VERIFYING_KEY_HEAD_WORDS = 16
const VERIFYING_KEY_FIXED_POINT_WORDS = 14

type Warning = {
  message: string
  fields: Record<string, unknown> | undefined
}

const originalWarn = logger.warn

afterEach(() => {
  logger.warn = originalWarn
})

test('decodes a VerifyingKeySet log payload', () => {
  const data = encodeVerifyingKeySetData({
    nullifiers: 2n,
    commitments: 3n,
    artifactsIPFSHash: VALID_CID
  })

  const decoded = decodeVerifyingKeySetLog(makeLog(data))

  assert.equal(decoded.nullifiers, 2n)
  assert.equal(decoded.commitments, 3n)
  assert.equal(decoded.artifactsIPFSHash, VALID_CID)
})

test('collect skips malformed artifact CIDs with a warning', async () => {
  const warnings = captureWarnings()
  const source = new VerifyingKeySource({
    chainId: 1,
    rpcURL: 'http://rpc.local',
    contractAddress: CONTRACT_ADDRESS,
    deploymentBlock: 14693013n
  }, {
    fetchLogs: async () => [
      makeLog(encodeVerifyingKeySetData({
        nullifiers: 2n,
        commitments: 2n,
        artifactsIPFSHash: 'not-a-cid'
      })),
      makeLog(encodeVerifyingKeySetData({
        nullifiers: 3n,
        commitments: 3n,
        artifactsIPFSHash: VALID_CID
      }))
    ]
  })

  const entries = await source.collect()

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.cid.toString(), VALID_CID)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.message, 'verifying key event has invalid artifacts CID, skipping')
})

test('collect skips a chain with no RPC URL without fetching logs', async () => {
  const warnings = captureWarnings()
  let fetchCalled = false
  const source = new VerifyingKeySource({
    chainId: 1,
    rpcURL: '',
    contractAddress: CONTRACT_ADDRESS,
    deploymentBlock: 14693013n
  }, {
    fetchLogs: async () => {
      fetchCalled = true
      return []
    }
  })

  const entries = await source.collect()

  assert.deepEqual(entries, [])
  assert.equal(fetchCalled, false)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.message, 'verifying key source has no RPC URL, skipping')
})

test('collect formats verifying-key pin names from chain and circuit dimensions', async () => {
  let fetchOptions: EthGetLogsChunkedOptions | undefined
  const source = new VerifyingKeySource({
    chainId: 11155111,
    rpcURL: 'http://rpc.local',
    contractAddress: CONTRACT_ADDRESS,
    deploymentBlock: 5784866n
  }, {
    fetchLogs: async options => {
      fetchOptions = options
      return [makeLog(encodeVerifyingKeySetData({
        nullifiers: 13n,
        commitments: 256n,
        artifactsIPFSHash: VALID_CID
      }))]
    }
  })

  const entries = await source.collect()

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.name, 'railgun/11155111/vkey/13x256')
  assert.equal(fetchOptions?.address, CONTRACT_ADDRESS)
  assert.deepEqual(fetchOptions?.topics, [VERIFYING_KEY_SET_TOPIC])
  assert.equal(fetchOptions?.fromBlock, 5784866n)
})

function captureWarnings (): Warning[] {
  const warnings: Warning[] = []
  logger.warn = (message: string, fields?: Record<string, unknown>) => {
    warnings.push({ message, fields })
  }
  return warnings
}

function makeLog (data: string): EthLog {
  return {
    address: CONTRACT_ADDRESS,
    topics: [VERIFYING_KEY_SET_TOPIC],
    data
  }
}

function encodeVerifyingKeySetData (event: DecodedTestEvent): string {
  const artifactsTail = encodeAbiString(event.artifactsIPFSHash)
  const icTail = word(0n)
  const verifyingKeyHeadByteLength = BigInt(VERIFYING_KEY_HEAD_WORDS * ABI_WORD_BYTES)
  const icOffset = verifyingKeyHeadByteLength + BigInt(artifactsTail.length / 2)
  const verifyingKeyHead = [
    word(verifyingKeyHeadByteLength),
    Array.from({ length: VERIFYING_KEY_FIXED_POINT_WORDS }, () => word(0n)).join(''),
    word(icOffset)
  ].join('')

  return `0x${
    word(event.nullifiers)
  }${
    word(event.commitments)
  }${
    word(BigInt(ABI_WORD_BYTES * 3))
  }${
    verifyingKeyHead
  }${
    artifactsTail
  }${
    icTail
  }`
}

function encodeAbiString (value: string): string {
  const valueHex = bytesToHex(new TextEncoder().encode(value))
  return `${word(BigInt(valueHex.length / 2))}${padHexToWord(valueHex)}`
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

type DecodedTestEvent = {
  nullifiers: bigint
  commitments: bigint
  artifactsIPFSHash: string
}
