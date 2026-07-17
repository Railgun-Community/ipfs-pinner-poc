#!/usr/bin/env node
import { KuboClient } from '../src/kubo.js'
import { logger } from '../src/logger.js'
import { diffPinsets, mergeSources } from '../src/reconcile.js'
import { StaticListSource } from '../src/static-list.js'
import type { PinSource } from '../src/types.js'
import { VerifyingKeySource } from '../src/verifying-key-source.js'
import { VotingProposalSource } from '../src/voting-proposal-source.js'

/*
Environment:
- KUBO_API_URL: Kubo RPC API base URL (e.g. http://127.0.0.1:5001). Required.
- RPC_URL_MAINNET: optional Ethereum mainnet RPC URL; unset/empty skips mainnet verifying-key and voting proposal pins.
- RPC_URL_SEPOLIA: optional Ethereum Sepolia RPC URL; unset/empty skips Sepolia verifying-key pins.
- PIN_FETCH_TIMEOUT_MS: optional positive integer, defaults to 120000.
- RECONCILE_INTERVAL_MS: optional positive integer, defaults to 600000.
*/

const DEFAULT_PIN_FETCH_TIMEOUT_MS = 120_000
const DEFAULT_RECONCILE_INTERVAL_MS = 600_000

const requireEnv = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`Missing required env ${name}`)
  return value
}

const parsePositiveSafeInteger = (name: string, value: string | undefined, fallback?: number): number => {
  if (value === undefined || value.trim() === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing required env ${name}`)
  }
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid ${name}: ${value}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}: ${value}`)
  return parsed
}

/**
 * Sleep for `ms`, resolving early if `signal` aborts.
 * @param ms - Milliseconds to sleep.
 * @param signal - Abort signal that cuts the sleep short.
 */
const abortableSleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Run one collect -> diff -> pin cycle and log a summary line.
 * @param sources - Pin sources to collect from.
 * @param kubo - Kubo client to diff against and pin through.
 * @param pinFetchTimeoutMs - Per-pin fetch timeout in milliseconds.
 */
const runCycle = async (
  sources: PinSource[],
  kubo: KuboClient,
  pinFetchTimeoutMs: number
): Promise<void> => {
  const collected = await Promise.all(sources.map(async source => source.collect()))
  const desired = mergeSources(collected)

  const actual = await kubo.listPins()
  const missing = diffPinsets(desired, actual)

  let pinned = 0
  let failed = 0
  for (const entry of missing) {
    try {
      await kubo.addPin(entry.cid.toString(), entry.name, pinFetchTimeoutMs)
      pinned++
    } catch (error) {
      failed++
      logger.error('pin failed, will retry next cycle', {
        cid: entry.cid.toString(),
        name: entry.name,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  logger.info('reconcile cycle complete', {
    collected: desired.length,
    pinned,
    failed
  })
}

const main = async (): Promise<void> => {
  const apiURL = requireEnv('KUBO_API_URL')
  const pinFetchTimeoutMs = parsePositiveSafeInteger(
    'PIN_FETCH_TIMEOUT_MS', process.env['PIN_FETCH_TIMEOUT_MS'], DEFAULT_PIN_FETCH_TIMEOUT_MS
  )
  const intervalMs = parsePositiveSafeInteger(
    'RECONCILE_INTERVAL_MS', process.env['RECONCILE_INTERVAL_MS'], DEFAULT_RECONCILE_INTERVAL_MS
  )

  const kubo = new KuboClient({ apiURL })
  // Sources are hard-coded by design: static artifacts, verifying keys, and mainnet voting proposals.
  const sources: PinSource[] = [
    new StaticListSource(),
    // Mainnet verifying-key block follows wallet-sdk; reloaded/snapshot still lists 14737691n.
    new VerifyingKeySource({
      chainId: 1,
      rpcURL: process.env['RPC_URL_MAINNET'],
      contractAddress: '0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9',
      deploymentBlock: 14693013n
    }),
    new VerifyingKeySource({
      chainId: 11155111,
      rpcURL: process.env['RPC_URL_SEPOLIA'],
      contractAddress: '0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea',
      deploymentBlock: 5784866n
    }),
    new VotingProposalSource({
      chainId: 1,
      rpcURL: process.env['RPC_URL_MAINNET'],
      contractAddress: '0xc480F68A3dcC3EdD82134FAB45C14A0FcF1dA3CC',
      deploymentBlock: 15505853n
    })
  ]

  logger.info('ipfs-pinner starting', { apiURL, pinFetchTimeoutMs, intervalMs, sourceCount: sources.length })

  const controller = new AbortController()
  const shutdown = (): void => {
    logger.info('shutdown signal received')
    controller.abort()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  while (!controller.signal.aborted) {
    try {
      await runCycle(sources, kubo, pinFetchTimeoutMs)
    } catch (error) {
      logger.error('reconcile cycle failed', { error: error instanceof Error ? error.message : String(error) })
    }
    if (controller.signal.aborted) break
    await abortableSleep(intervalMs, controller.signal)
  }

  logger.info('ipfs-pinner stopped')
}

main().catch(error => {
  logger.error('fatal', { error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
})
