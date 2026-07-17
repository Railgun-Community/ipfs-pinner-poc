import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { FetchLike } from '../src/kubo.js'
import { DagSizeLimitExceededError, KuboClient } from '../src/kubo.js'

const CID = 'QmUsmnK4PFc7zDp2cmC4wBZxYLjNyRgWfs5GNcJJ2uLcpU'

type RecordedCall = {
  input: string
  init: RequestInit | undefined
}

test('addPin checks dag/stat before pin/add when a size cap is provided', async () => {
  const calls: RecordedCall[] = []
  const client = new KuboClient({
    apiURL: 'http://kubo.local',
    fetchFn: makeFetch(calls, {
      dagStat: jsonLinesResponse([
        { DagStats: [{ Size: '400' }] },
        { TotalSize: 900 }
      ]),
      pinAdd: jsonResponse({ Pins: [CID] })
    })
  })

  await client.addPin(CID, 'railgun/1/gov-proposal/1', 1_000, 1_000)

  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.input, `http://kubo.local/api/v0/dag/stat?arg=${CID}&progress=true`)
  assert.equal(calls[0]?.init?.method, 'POST')
  assert.equal(
    calls[1]?.input,
    `http://kubo.local/api/v0/pin/add?arg=${CID}&name=railgun%2F1%2Fgov-proposal%2F1&recursive=true`
  )
})

test('addPin rejects and aborts before pin/add when dag/stat crosses the size cap', async () => {
  const calls: RecordedCall[] = []
  const client = new KuboClient({
    apiURL: 'http://kubo.local',
    fetchFn: makeFetch(calls, {
      dagStat: jsonLinesResponse([
        { TotalSize: 999 },
        { TotalSize: 1_001 }
      ]),
      pinAdd: jsonResponse({ Pins: [CID] })
    })
  })

  await assert.rejects(
    async () => client.addPin(CID, 'railgun/1/gov-proposal/1', 1_000, 1_000),
    (error: unknown) => {
      assert.ok(error instanceof DagSizeLimitExceededError)
      assert.equal(error.cid, CID)
      assert.equal(error.maxSizeBytes, 1_000)
      assert.equal(error.actualSizeBytes, 1_001n)
      return true
    }
  )

  assert.equal(calls.length, 1)
  assert.equal((calls[0]?.init?.signal as AbortSignal | undefined)?.aborted, true)
})

test('addPin skips dag/stat when no size cap is provided', async () => {
  const calls: RecordedCall[] = []
  const client = new KuboClient({
    apiURL: 'http://kubo.local/',
    fetchFn: makeFetch(calls, {
      dagStat: jsonLinesResponse([{ TotalSize: 1_001 }]),
      pinAdd: jsonResponse({ Pins: [CID] })
    })
  })

  await client.addPin(CID, 'railgun/static/artifacts', 1_000)

  assert.equal(calls.length, 1)
  assert.equal(
    calls[0]?.input,
    `http://kubo.local/api/v0/pin/add?arg=${CID}&name=railgun%2Fstatic%2Fartifacts&recursive=true`
  )
})

function makeFetch (
  calls: RecordedCall[],
  responses: { dagStat: Response, pinAdd: Response }
): FetchLike {
  return async (input, init) => {
    calls.push({ input, init })
    if (input.includes('/api/v0/dag/stat')) return responses.dagStat
    if (input.includes('/api/v0/pin/add')) return responses.pinAdd
    throw new Error(`unexpected Kubo URL: ${input}`)
  }
}

function jsonLinesResponse (payloads: unknown[]): Response {
  return new Response(`${payloads.map(payload => JSON.stringify(payload)).join('\n')}\n`, {
    headers: { 'content-type': 'application/json' }
  })
}

function jsonResponse (payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' }
  })
}
