type KuboClientOptions = {
  apiURL: string
  fetchFn?: FetchLike
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

type PinLsResponse = {
  Keys?: Record<string, { Type?: string, Name?: string }>
}

type DagStatResponse = {
  TotalSize?: unknown
  DagStats?: Array<{ Size?: unknown }>
  Size?: unknown
}

class DagSizeLimitExceededError extends Error {
  cid: string
  maxSizeBytes: number
  actualSizeBytes: bigint

  constructor (cid: string, maxSizeBytes: number, actualSizeBytes: bigint) {
    super(`DAG for ${cid} exceeds size cap: ${actualSizeBytes.toString()} > ${maxSizeBytes.toString()} bytes`)
    this.name = 'DagSizeLimitExceededError'
    this.cid = cid
    this.maxSizeBytes = maxSizeBytes
    this.actualSizeBytes = actualSizeBytes
  }
}

/**
 * Thin client over the Kubo HTTP RPC pin API. No secrets: the API URL is
 * assumed to be a local/trusted admin endpoint.
 */
class KuboClient {
  #apiURL: string
  #fetch: FetchLike

  constructor (options: KuboClientOptions) {
    this.#apiURL = options.apiURL.replace(/\/$/, '')
    this.#fetch = options.fetchFn ?? fetch
  }

  /**
   * List the CIDs currently pinned on the node.
   * @returns The set of pinned CIDs, as strings.
   */
  async listPins (): Promise<Set<string>> {
    const response = await this.#fetch(`${this.#apiURL}/api/v0/pin/ls?type=recursive&names=true`, {
      method: 'POST'
    })
    if (!response.ok) {
      throw new Error(`Kubo pin/ls failed: ${response.status} ${await response.text()}`)
    }
    const payload = await response.json() as PinLsResponse
    return new Set(Object.keys(payload.Keys ?? {}))
  }

  /**
   * Pin a CID under a human-readable name, aborting the fetch after
   * `timeoutMs`. Kubo cancels the underlying content fetch when the HTTP
   * request is aborted.
   * @param cid - CID to pin, as a string.
   * @param name - Deterministic pin name.
   * @param timeoutMs - Per-pin fetch timeout in milliseconds.
   * @param maxDagSizeBytes - Optional recursive DAG byte cap checked before pinning.
   */
  async addPin (cid: string, name: string, timeoutMs: number, maxDagSizeBytes?: number): Promise<void> {
    if (maxDagSizeBytes !== undefined) await this.#assertDagWithinSizeLimit(cid, maxDagSizeBytes, timeoutMs)
    const url = `${this.#apiURL}/api/v0/pin/add?arg=${encodeURIComponent(cid)}&name=${encodeURIComponent(name)}&recursive=true`
    const response = await this.#fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) {
      throw new Error(`Kubo pin/add failed for ${cid}: ${response.status} ${await response.text()}`)
    }
  }

  async #assertDagWithinSizeLimit (cid: string, maxSizeBytes: number, timeoutMs: number): Promise<void> {
    if (!Number.isSafeInteger(maxSizeBytes) || maxSizeBytes <= 0) {
      throw new Error(`Invalid DAG size cap for ${cid}: ${maxSizeBytes.toString()}`)
    }
    const maxSize = BigInt(maxSizeBytes)
    const url = `${this.#apiURL}/api/v0/dag/stat?arg=${encodeURIComponent(cid)}&progress=true`
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    try {
      const response = await this.#fetch(url, {
        method: 'POST',
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(`Kubo dag/stat failed for ${cid}: ${response.status} ${await response.text()}`)
      }

      let lastObservedSize: bigint | undefined
      await readJsonLines(response, payload => {
        const size = readDagStatSizeBytes(payload)
        if (size === undefined) return
        lastObservedSize = size
        if (size > maxSize) {
          controller.abort()
          throw new DagSizeLimitExceededError(cid, maxSizeBytes, size)
        }
      })

      if (lastObservedSize === undefined) throw new Error(`Kubo dag/stat returned no size for ${cid}`)
    } catch (error) {
      if (error instanceof DagSizeLimitExceededError) throw error
      if (timedOut) throw new Error(`Kubo dag/stat timed out for ${cid} after ${timeoutMs.toString()}ms`)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

async function readJsonLines (response: Response, onPayload: (payload: unknown) => void): Promise<void> {
  const body = response.body
  if (body === null) {
    onPayload(await response.json())
    return
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    buffer = consumeJsonLines(buffer, onPayload)
  }
  buffer += decoder.decode()
  const remainder = buffer.trim()
  if (remainder !== '') onPayload(JSON.parse(remainder) as unknown)
}

function consumeJsonLines (buffer: string, onPayload: (payload: unknown) => void): string {
  let nextNewline = buffer.indexOf('\n')
  while (nextNewline !== -1) {
    const line = buffer.slice(0, nextNewline).trim()
    if (line !== '') onPayload(JSON.parse(line) as unknown)
    buffer = buffer.slice(nextNewline + 1)
    nextNewline = buffer.indexOf('\n')
  }
  return buffer
}

function readDagStatSizeBytes (payload: unknown): bigint | undefined {
  if (!isRecord(payload)) return undefined
  const response = payload as DagStatResponse
  const totalSize = parseUnsignedInteger(response.TotalSize)
  if (totalSize !== undefined) return totalSize

  if (Array.isArray(response.DagStats)) {
    let sum = 0n
    let foundSize = false
    for (const dagStat of response.DagStats) {
      const size = parseUnsignedInteger(dagStat.Size)
      if (size === undefined) continue
      sum += size
      foundSize = true
    }
    if (foundSize) return sum
  }

  return parseUnsignedInteger(response.Size)
}

function parseUnsignedInteger (value: unknown): bigint | undefined {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return undefined
    return BigInt(value)
  }
  if (typeof value === 'bigint') {
    if (value < 0n) return undefined
    return value
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value)
  return undefined
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export { DagSizeLimitExceededError, KuboClient }
export type { FetchLike, KuboClientOptions }
