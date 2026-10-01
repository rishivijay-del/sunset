import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'

// ---------- console output ----------
const tty = process.stdout.isTTY
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
export const color = {
  bold: c('1'),
  dim: c('2'),
  red: c('31'),
  green: c('32'),
  yellow: c('33'),
  blue: c('34'),
  magenta: c('35'),
  cyan: c('36'),
}
export const icon = { ok: '✔', warn: '⚠', stop: '✖', sun: '☀', dot: '•', arrow: '→' }

export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows
  const widths = all[0]?.map((_, i) => Math.min(60, Math.max(...all.map((r) => (r[i] ?? '').length)))) ?? []
  const fmt = (r: string[]) => r.map((cell, i) => (cell ?? '').slice(0, 60).padEnd(widths[i])).join('  ')
  const lines = all.map(fmt)
  if (headers) lines.splice(1, 0, widths.map((w) => '─'.repeat(w)).join('  '))
  return lines.join('\n')
}

// ---------- files & state ----------
export function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}
export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
export function writeJson(path: string, value: unknown) {
  ensureDir(dirname(path))
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
export const shortId = () => randomBytes(3).toString('hex')
export const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-').slice(0, 19)
export const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

// ---------- tolerant access into CLI JSON (field names differ across versions) ----------
export function pick(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]
    const lower = Object.keys(obj).find((x) => x.toLowerCase() === k.toLowerCase())
    if (lower && obj[lower] !== undefined && obj[lower] !== null && obj[lower] !== '') return obj[lower]
  }
  return undefined
}

/** Find the array of rows in common CLI JSON envelopes: {result:[...]}, {result:{records:[...]}}, [...]. */
export function rowsOf(data: any): any[] {
  if (Array.isArray(data)) return data
  for (const key of ['result', 'data', 'records', 'items', 'rows', 'value']) {
    const v = data?.[key]
    if (Array.isArray(v)) return v
    if (v && typeof v === 'object') {
      const inner = rowsOf(v)
      if (inner.length) return inner
    }
  }
  return []
}

export function resultOf(data: any): any {
  return data?.result ?? data?.data ?? data
}

// ---------- human approval ----------
export class ApprovalError extends Error {}

/**
 * Ask a yes/no question. In non-interactive runs (AI agents, CI) the caller
 * must pass --yes explicitly, and production actions never accept --yes.
 */
export async function confirm(question: string, opts: { yes?: boolean; production?: boolean } = {}): Promise<boolean> {
  if (opts.yes && !opts.production) return true
  if (!process.stdin.isTTY) {
    if (opts.production) throw new ApprovalError(`${question}\nProduction actions need a human at the terminal (or --confirm "<exact phrase>").`)
    throw new ApprovalError(`${question}\nRe-run with --yes to approve non-production actions non-interactively.`)
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(`${color.yellow('?')} ${question} ${color.dim('[y/N]')} `)).trim().toLowerCase()
  rl.close()
  return answer === 'y' || answer === 'yes'
}

/** Require the human to type an exact phrase (used for production and deletion). */
export async function typedConfirm(phrase: string, provided?: string): Promise<void> {
  if (provided !== undefined) {
    if (provided.trim() !== phrase) throw new ApprovalError(`Confirmation phrase did not match. Expected exactly: ${phrase}`)
    return
  }
  if (!process.stdin.isTTY) throw new ApprovalError(`This step needs typed confirmation. Re-run with --confirm "${phrase}"`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${color.red('!')} Type ${color.bold(phrase)} to continue: `)
  rl.close()
  if (answer.trim() !== phrase) throw new ApprovalError('Confirmation phrase did not match. Nothing was changed.')
}

export async function choose(question: string, options: string[]): Promise<string> {
  if (!process.stdin.isTTY) throw new ApprovalError(`${question} needs an interactive terminal.`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(`${color.yellow('?')} ${question} ${color.dim(`[${options.join('/')}]`)} `)).trim().toLowerCase()
  rl.close()
  return options.find((o) => o.toLowerCase().startsWith(answer)) ?? options[options.length - 1]
}

// ---------- notifications ----------
export async function notifySlack(envVar: string, text: string): Promise<boolean> {
  const url = process.env[envVar]
  if (!url) return false
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    return res.ok
  } catch {
    return false
  }
}

export const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / 86_400_000)
