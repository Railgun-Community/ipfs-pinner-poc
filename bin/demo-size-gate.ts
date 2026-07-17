#!/usr/bin/env node
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'

import { DagSizeLimitExceededError, KuboClient } from '../src/kubo.js'

const MAX_DAG_SIZE_BYTES = 1_000_000
const FETCH_TIMEOUT_MS = 5_000
const UNDER_BUDGET_CID = 'QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU'
const OVER_BUDGET_CID = 'QmZrP9zaZw2LwErT2yA6VpMWm65UdToQiKj4DtStVsUJHr'

type MockKuboState = {
  pinAdds: string[]
  statAborts: string[]
}

/**
 * Run a deterministic demonstration of the proposal DAG size gate using the
 * real Kubo client against a tiny local mock of Kubo's RPC surface.
 */
const main = async (): Promise<void> => {
  const state: MockKuboState = { pinAdds: [], statAborts: [] }
  const server = createServer((request, response) => handleMockKuboRequest(request, response, state))
  await listen(server)

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock Kubo server did not bind to a TCP port')

  const apiURL = `http://127.0.0.1:${address.port.toString()}`
  const kubo = new KuboClient({ apiURL })

  console.log(`Mock Kubo RPC: ${apiURL}`)
  console.log(`Proposal DAG cap: ${MAX_DAG_SIZE_BYTES.toString()} bytes\n`)

  try {
    await runUnderBudgetCase(kubo, state)
    await runOverBudgetCase(kubo, state)
  } finally {
    await close(server)
  }
}

async function runUnderBudgetCase (kubo: KuboClient, state: MockKuboState): Promise<void> {
  const before = state.pinAdds.length
  await kubo.addPin(UNDER_BUDGET_CID, 'railgun/1/gov-proposal/under-budget', FETCH_TIMEOUT_MS, MAX_DAG_SIZE_BYTES)
  const pinAdds = state.pinAdds.length - before

  console.log('UNDER BUDGET')
  console.log('dag/stat streamed: 400000 -> 900000 bytes')
  console.log(`pin/add calls: ${pinAdds.toString()}`)
  console.log(pinAdds === 1 ? 'PASS: under-budget proposal was pinned\n' : 'FAIL: expected exactly one pin/add call\n')
}

async function runOverBudgetCase (kubo: KuboClient, state: MockKuboState): Promise<void> {
  const before = state.pinAdds.length
  let rejected = false

  try {
    await kubo.addPin(OVER_BUDGET_CID, 'railgun/1/gov-proposal/over-budget', FETCH_TIMEOUT_MS, MAX_DAG_SIZE_BYTES)
  } catch (error) {
    if (!(error instanceof DagSizeLimitExceededError)) throw error
    rejected = true
    console.log('OVER BUDGET')
    console.log(`dag/stat streamed: 500000 -> ${error.actualSizeBytes.toString()} bytes`)
    console.log(`rejection: ${error.message}`)
  }

  const pinAdds = state.pinAdds.length - before
  await sleep(50)
  const aborted = state.statAborts.includes(OVER_BUDGET_CID)
  console.log(`pin/add calls: ${pinAdds.toString()}`)
  console.log(`dag/stat stream aborted: ${aborted ? 'yes' : 'no'}`)
  console.log(rejected && pinAdds === 0 ? 'PASS: over-budget proposal was rejected before pin/add' : 'FAIL: expected rejection before pin/add')
}

function handleMockKuboRequest (request: IncomingMessage, response: ServerResponse, state: MockKuboState): void {
  if (request.url === undefined) {
    response.writeHead(400)
    response.end()
    return
  }

  const url = new URL(request.url, 'http://mock-kubo.local')
  if (request.method !== 'POST') {
    writeJson(response, 405, { Message: 'method not allowed' })
    return
  }

  if (url.pathname === '/api/v0/dag/stat') {
    handleDagStat(url, response, state)
    return
  }

  if (url.pathname === '/api/v0/pin/add') {
    const cid = url.searchParams.get('arg') ?? ''
    state.pinAdds.push(cid)
    writeJson(response, 200, { Pins: [cid] })
    return
  }

  writeJson(response, 404, { Message: `unexpected path ${url.pathname}` })
}

function handleDagStat (url: URL, response: ServerResponse, state: MockKuboState): void {
  const cid = url.searchParams.get('arg') ?? ''
  const payloads = cid === OVER_BUDGET_CID
    ? [{ TotalSize: 500_000 }, { TotalSize: 1_000_001 }, { TotalSize: 1_500_000 }]
    : [{ TotalSize: 400_000 }, { TotalSize: 900_000 }]

  response.writeHead(200, { 'content-type': 'application/json' })
  streamJsonLines(response, payloads, () => {
    state.statAborts.push(cid)
  })
}

function streamJsonLines (response: ServerResponse, payloads: unknown[], onAbort: () => void): void {
  let index = 0
  let finished = false

  const writeNext = (): void => {
    if (index >= payloads.length) {
      finished = true
      response.end()
      return
    }
    response.write(`${JSON.stringify(payloads[index])}\n`)
    index++
    setTimeout(writeNext, 25)
  }

  response.on('close', () => {
    if (!finished) onAbort()
  })
  writeNext()
}

function writeJson (response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

async function sleep (ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })
}

async function listen (server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

async function close (server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error !== undefined) reject(error)
      else resolve()
    })
  })
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
