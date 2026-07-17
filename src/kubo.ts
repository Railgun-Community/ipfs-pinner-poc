type KuboClientOptions = {
  apiURL: string
}

type PinLsResponse = {
  Keys?: Record<string, { Type?: string, Name?: string }>
}

/**
 * Thin client over the Kubo HTTP RPC pin API. No secrets: the API URL is
 * assumed to be a local/trusted admin endpoint.
 */
class KuboClient {
  #apiURL: string

  constructor (options: KuboClientOptions) {
    this.#apiURL = options.apiURL.replace(/\/$/, '')
  }

  /**
   * List the CIDs currently pinned on the node.
   * @returns The set of pinned CIDs, as strings.
   */
  async listPins (): Promise<Set<string>> {
    const response = await fetch(`${this.#apiURL}/api/v0/pin/ls?type=recursive&names=true`, {
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
   */
  async addPin (cid: string, name: string, timeoutMs: number): Promise<void> {
    const url = `${this.#apiURL}/api/v0/pin/add?arg=${encodeURIComponent(cid)}&name=${encodeURIComponent(name)}&recursive=true`
    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) {
      throw new Error(`Kubo pin/add failed for ${cid}: ${response.status} ${await response.text()}`)
    }
  }
}

export { KuboClient }
export type { KuboClientOptions }
