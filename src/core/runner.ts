/**
 * Runs external commands (agentia, sf, git) safely.
 *
 * - Arguments are passed as an array (no shell), so values can't inject commands.
 * - stdout is returned even when the command exits non-zero, because both
 *   `sf` and `agentia` print useful JSON on failure.
 * - Anything that looks like a token is redacted before it reaches logs.
 * - Tests replace the executor with a fake via setExecutor().
 */
import { spawnSync } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export type Executor = (bin: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number }) => RunResult

const realExecutor: Executor = (bin, args, opts) => {
  const r = spawnSync(bin, args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 10 * 60_000,
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
  })
  if (r.error) return { code: 127, stdout: '', stderr: r.error.message }
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

let executor: Executor = realExecutor
export const setExecutor = (e: Executor) => (executor = e)
export const resetExecutor = () => (executor = realExecutor)

let verbose = false
export const setVerbose = (v: boolean) => (verbose = v)

const SECRET_PATTERNS = [
  /(sessionId|accessToken|access_token|refresh_token|api[-_]?key|x-authorization|pak)(["'\s:=]+)([^"'\s,}]+)/gi,
  /00D[a-zA-Z0-9]{12,15}![a-zA-Z0-9._-]{20,}/g, // Salesforce session IDs
  /Bearer\s+[A-Za-z0-9._-]{12,}/g,
]
export function redact(text: string): string {
  let out = text
  out = out.replace(SECRET_PATTERNS[0], (_m, k, sep) => `${k}${sep}***`)
  out = out.replace(SECRET_PATTERNS[1], '***session***')
  out = out.replace(SECRET_PATTERNS[2], 'Bearer ***')
  return out
}

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly result: RunResult,
    public readonly command: string,
  ) {
    super(message)
  }
}

export function run(bin: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number; allowFail?: boolean } = {}): RunResult {
  const printable = `${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a.length > 80 ? a.slice(0, 77) + '...' : a) : a)).join(' ')}`
  if (verbose) process.stderr.write(`\x1b[2m$ ${redact(printable)}\x1b[0m\n`)
  const res = executor(bin, args, opts)
  if (res.code !== 0 && !opts.allowFail) {
    const detail = redact((res.stderr || res.stdout || '').trim()).slice(0, 2000)
    throw new CommandError(`Command failed (${res.code}): ${redact(printable)}\n${detail}`, res, printable)
  }
  return res
}

/** Parse JSON from command output, tolerating banners/warnings before the JSON. */
export function parseJson<T = any>(text: string): T {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.search(/[{[]/)
    if (start >= 0) {
      const candidate = trimmed.slice(start)
      try {
        return JSON.parse(candidate)
      } catch {
        /* fall through */
      }
    }
    throw new Error(`Expected JSON output but got: ${redact(trimmed.slice(0, 300))}`)
  }
}

export function runJson<T = any>(bin: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number; allowFail?: boolean } = {}): { data: T; result: RunResult } {
  const result = run(bin, args, { ...opts, allowFail: true })
  let data: T
  try {
    data = parseJson<T>(result.stdout || result.stderr)
  } catch (err) {
    if (result.code !== 0 && !opts.allowFail) {
      throw new CommandError(`Command failed (${result.code}): ${bin} ${args[0] ?? ''} ${args[1] ?? ''}\n${redact(result.stderr || result.stdout).slice(0, 2000)}`, result, bin)
    }
    throw err
  }
  if (result.code !== 0 && !opts.allowFail) {
    throw new CommandError(`Command failed (${result.code}): ${bin} ${args.slice(0, 4).join(' ')}\n${redact(JSON.stringify(data)).slice(0, 2000)}`, result, bin)
  }
  return { data, result }
}

/** Is a binary available on PATH? */
export function which(bin: string): boolean {
  const r = executor(process.platform === 'win32' ? 'where' : 'which', [bin], {})
  return r.code === 0
}
