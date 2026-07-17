#!/usr/bin/env node
import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

import type { EthLog } from '../src/eth-rpc.js'
import type { FetchLike } from '../src/kubo.js'
import { DagSizeLimitExceededError, KuboClient } from '../src/kubo.js'
import { diffPinsets, mergeSources } from '../src/reconcile.js'
import { StaticListSource } from '../src/static-list.js'
import type { PinEntry, PinSource } from '../src/types.js'
import {
  VERIFYING_KEY_SET_TOPIC,
  VerifyingKeySource
} from '../src/verifying-key-source.js'
import {
  VOTING_PROPOSAL_TOPIC,
  VotingProposalSource,
  encodeProposalsCall
} from '../src/voting-proposal-source.js'

const CHAIN_ID_MAINNET = 1
const FETCH_TIMEOUT_MS = 5_000
const PROPOSAL_SIZE_CAP_BYTES = 1_000_000
const MOCK_VERIFIER_ADDRESS = '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9'
const MOCK_VOTING_ADDRESS = '0xc480F68A3dcC3EdD82134FAB45C14A0FcF1dA3CC'
const MOCK_PROPOSER_ADDRESS = '0x1234567890AbCdEf1234567890aBcdef12345678'
const ABI_WORD_BYTES = 32
const ABI_WORD_HEX_LENGTH = ABI_WORD_BYTES * 2
const VERIFYING_KEY_HEAD_WORDS = 16
const VERIFYING_KEY_FIXED_POINT_WORDS = 14
const PROPOSAL_GETTER_HEAD_WORDS = 10

type DemoCids = {
  staticArtifacts: string
  staticPpoi: string
  verifyingKeyArtifacts: string
  proposalDocument: string
  oversizedProposalDocument: string
}

type MockKuboState = {
  pinned: Set<string>
  pinNames: Map<string, string>
  pinAdds: Array<{ cid: string, name: string }>
}

type ReconcileOutcome = {
  pinned: PinEntry[]
  rejected: Array<{ entry: PinEntry, error: DagSizeLimitExceededError }>
  failed: Array<{ entry: PinEntry, error: unknown }>
}

const main = async (): Promise<void> => {
  const cids = await makeDemoCids()
  const kuboState = makeInitialKuboState(cids)
  const kubo = new KuboClient({
    apiURL: 'http://mock-kubo.local',
    fetchFn: makeMockKuboFetch(kuboState, cids)
  })

  printPitch()

  const sources = makeSources(cids)
  const collectedBySource = await Promise.all(sources.map(async source => source.collect()))
  const desired = mergeSources(collectedBySource)
  const actual = await kubo.listPins()
  const missing = diffPinsets(desired, actual)

  printDiscovery(collectedBySource, desired, actual, kuboState)

  const outcome = await reconcileMissing(missing, kubo)
  printReconcile(outcome, kuboState)
}

function printPitch (): void {
  console.log('RAILGUN IPFS pinner - product demo\n')
  console.log('30-second pitch:')
  console.log('RAILGUN content already has sources of truth: repo-managed artifact CIDs and on-chain events.')
  console.log('This daemon turns those sources into Kubo pin state: collect, dedupe, diff, pin missing content, never unpin.')
  console.log('For permissionless governance proposal documents, it checks DAG size before pinning so one bad CID cannot make the node fetch unbounded data.\n')
}

function printDiscovery (
  collectedBySource: PinEntry[][],
  desired: PinEntry[],
  actual: ReadonlySet<string>,
  kuboState: MockKuboState
): void {
  console.log('1. Discover desired pinset')
  console.log(`   static repo list: ${collectedBySource[0]?.length.toString() ?? '0'} entries`)
  console.log(`   verifying-key events: ${collectedBySource[1]?.length.toString() ?? '0'} entry`)
  console.log(`   governance proposals: ${collectedBySource[2]?.length.toString() ?? '0'} entries`)
  console.log(`   desired total after dedupe: ${desired.length.toString()}\n`)

  console.log('2. Diff against Kubo')
  console.log(`   Kubo already has: ${actual.size.toString()} recursive pin`)
  for (const cid of actual) {
    console.log(`   already pinned: ${kuboState.pinNames.get(cid) ?? cid}`)
  }
  console.log(`   missing pins to reconcile: ${(desired.length - actual.size).toString()}\n`)
}

async function reconcileMissing (missing: PinEntry[], kubo: KuboClient): Promise<ReconcileOutcome> {
  const outcome: ReconcileOutcome = { pinned: [], rejected: [], failed: [] }

  for (const entry of missing) {
    try {
      await kubo.addPin(entry.cid.toString(), entry.name, FETCH_TIMEOUT_MS, entry.maxDagSizeBytes)
      outcome.pinned.push(entry)
    } catch (error) {
      if (error instanceof DagSizeLimitExceededError) {
        outcome.rejected.push({ entry, error })
      } else {
        outcome.failed.push({ entry, error })
      }
    }
  }

  return outcome
}

function printReconcile (outcome: ReconcileOutcome, kuboState: MockKuboState): void {
  console.log('3. Reconcile')
  for (const entry of outcome.pinned) {
    const capped = entry.maxDagSizeBytes === undefined ? '' : ` after dag/stat <= ${entry.maxDagSizeBytes.toString()} bytes`
    console.log(`   PIN ${entry.name}${capped}`)
  }
  for (const rejected of outcome.rejected) {
    console.log(
      `   REJECT ${rejected.entry.name}: ${rejected.error.actualSizeBytes.toString()} > ${rejected.error.maxSizeBytes.toString()} bytes`
    )
  }
  for (const failed of outcome.failed) {
    console.log(`   FAIL ${failed.entry.name}: ${failed.error instanceof Error ? failed.error.message : String(failed.error)}`)
  }

  console.log('\n4. Outcome')
  console.log(`   pin/add calls: ${kuboState.pinAdds.length.toString()}`)
  console.log(`   rejected over size cap: ${outcome.rejected.length.toString()}`)
  console.log(`   failed transiently: ${outcome.failed.length.toString()}`)
  console.log('   final Kubo recursive pins:')
  for (const name of [...kuboState.pinNames.values()].sort()) {
    console.log(`   - ${name}`)
  }
}

function makeSources (cids: DemoCids): PinSource[] {
  return [
    new StaticListSource([
      { cid: cids.staticArtifacts, name: 'railgun-artifacts' },
      { cid: cids.staticPpoi, name: 'ppoi-artifacts' }
    ]),
    new VerifyingKeySource({
      chainId: CHAIN_ID_MAINNET,
      rpcURL: 'mock://mainnet',
      contractAddress: MOCK_VERIFIER_ADDRESS,
      deploymentBlock: 1n
    }, {
      fetchLogs: async () => [
        makeVerifyingKeyLog({
          nullifiers: 2n,
          commitments: 3n,
          artifactsIPFSHash: cids.verifyingKeyArtifacts
        })
      ]
    }),
    new VotingProposalSource({
      chainId: CHAIN_ID_MAINNET,
      rpcURL: 'mock://mainnet',
      contractAddress: MOCK_VOTING_ADDRESS,
      deploymentBlock: 1n,
      maxDagSizeBytes: PROPOSAL_SIZE_CAP_BYTES
    }, {
      fetchLogs: async () => [makeProposalLog(42n), makeProposalLog(43n)],
      call: async request => {
        if (request.data === encodeProposalsCall(42n)) return encodeProposalGetterResult(cids.proposalDocument)
        if (request.data === encodeProposalsCall(43n)) return encodeProposalGetterResult(cids.oversizedProposalDocument)
        throw new Error(`unexpected proposals call data: ${request.data}`)
      }
    })
  ]
}

function makeInitialKuboState (cids: DemoCids): MockKuboState {
  return {
    pinned: new Set([cids.staticPpoi]),
    pinNames: new Map([[cids.staticPpoi, 'railgun/static/ppoi-artifacts']]),
    pinAdds: []
  }
}

function makeMockKuboFetch (state: MockKuboState, cids: DemoCids): FetchLike {
  return async input => {
    const url = new URL(input)

    if (url.pathname === '/api/v0/pin/ls') {
      const Keys: Record<string, { Type: string, Name: string }> = {}
      for (const cid of state.pinned) {
        Keys[cid] = { Type: 'recursive', Name: state.pinNames.get(cid) ?? '' }
      }
      return jsonResponse(200, { Keys })
    }

    if (url.pathname === '/api/v0/dag/stat') {
      const cid = url.searchParams.get('arg') ?? ''
      if (cid === cids.proposalDocument) return jsonLinesResponse([{ TotalSize: 24_000 }])
      if (cid === cids.oversizedProposalDocument) return jsonLinesResponse([{ TotalSize: 500_000 }, { TotalSize: 1_500_000 }])
      return jsonLinesResponse([{ TotalSize: 750_000 }])
    }

    if (url.pathname === '/api/v0/pin/add') {
      const cid = url.searchParams.get('arg') ?? ''
      const name = url.searchParams.get('name') ?? ''
      state.pinAdds.push({ cid, name })
      state.pinned.add(cid)
      state.pinNames.set(cid, name)
      return jsonResponse(200, { Pins: [cid] })
    }

    return jsonResponse(404, { Message: `unexpected Kubo path ${url.pathname}` })
  }
}

async function makeDemoCids (): Promise<DemoCids> {
  return {
    staticArtifacts: await makeCid('static railgun artifacts'),
    staticPpoi: await makeCid('static ppoi artifacts'),
    verifyingKeyArtifacts: await makeCid('mainnet vkey 2x3 artifacts'),
    proposalDocument: await makeCid('governance proposal 42 document'),
    oversizedProposalDocument: await makeCid('governance proposal 43 oversized document')
  }
}

async function makeCid (seed: string): Promise<string> {
  const bytes = new TextEncoder().encode(seed)
  return CID.createV1(raw.code, await sha256.digest(bytes)).toString()
}

function makeVerifyingKeyLog (event: { nullifiers: bigint, commitments: bigint, artifactsIPFSHash: string }): EthLog {
  return {
    address: MOCK_VERIFIER_ADDRESS,
    topics: [VERIFYING_KEY_SET_TOPIC],
    data: encodeVerifyingKeySetData(event)
  }
}

function encodeVerifyingKeySetData (event: { nullifiers: bigint, commitments: bigint, artifactsIPFSHash: string }): string {
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

function makeProposalLog (id: bigint): EthLog {
  return {
    address: MOCK_VOTING_ADDRESS,
    topics: [VOTING_PROPOSAL_TOPIC, topicWord(id), addressTopic(MOCK_PROPOSER_ADDRESS)],
    data: '0x'
  }
}

function encodeProposalGetterResult (proposalDocument: string): string {
  const documentTail = encodeAbiString(proposalDocument)
  const documentOffset = BigInt(PROPOSAL_GETTER_HEAD_WORDS * ABI_WORD_BYTES)
  return `0x${
    word(1n)
  }${
    addressWord(MOCK_PROPOSER_ADDRESS)
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

function jsonLinesResponse (payloads: unknown[]): Response {
  return new Response(`${payloads.map(payload => JSON.stringify(payload)).join('\n')}\n`, {
    headers: { 'content-type': 'application/json' }
  })
}

function jsonResponse (status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
