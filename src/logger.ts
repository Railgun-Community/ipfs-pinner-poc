type LogLevel = 'info' | 'warn' | 'error'

/**
 * Emit a single structured line to stdout/stderr with an ISO timestamp.
 * @param level - Severity. 'error' goes to stderr, everything else to stdout.
 * @param message - Human-readable message.
 * @param fields - Optional key/value context appended as `key=value` pairs.
 */
function log (level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), message]
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      parts.push(`${key}=${formatValue(value)}`)
    }
  }
  const line = parts.join(' ')
  if (level === 'error') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

/**
 * Render a field value compactly, quoting strings that contain spaces.
 * @param value - Value to render.
 */
function formatValue (value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value.includes(' ') ? `"${value}"` : value
  return String(value)
}

const logger = {
  info: (message: string, fields?: Record<string, unknown>) => log('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log('error', message, fields)
}

export { logger }
export type { LogLevel }
