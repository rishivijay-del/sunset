/** Minimal line diff (LCS) for showing proposed edits before the developer approves them. */
export interface DiffLine {
  op: ' ' | '+' | '-'
  text: string
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  const n = a.length
  const m = b.length
  if (n * m > 4_000_000) {
    // Too large for LCS: show a coarse replace.
    return [...a.map((t) => ({ op: '-' as const, text: t })), ...b.map((t) => ({ op: '+' as const, text: t }))]
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: a[i++] })
    else out.push({ op: '+', text: b[j++] })
  }
  while (i < n) out.push({ op: '-', text: a[i++] })
  while (j < m) out.push({ op: '+', text: b[j++] })
  return out
}

/** Render with 2 lines of context around changes. */
export function renderDiff(before: string, after: string, context = 2, colorize = process.stdout.isTTY): string {
  const lines = diffLines(before, after)
  const keep = new Set<number>()
  lines.forEach((l, idx) => {
    if (l.op !== ' ') for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep.add(k)
  })
  const out: string[] = []
  let last = -1
  for (const idx of [...keep].sort((x, y) => x - y)) {
    if (last >= 0 && idx > last + 1) out.push(colorize ? '\x1b[2m   ...\x1b[0m' : '   ...')
    const l = lines[idx]
    const text = `${l.op} ${l.text}`
    out.push(colorize ? (l.op === '+' ? `\x1b[32m${text}\x1b[0m` : l.op === '-' ? `\x1b[31m${text}\x1b[0m` : `\x1b[2m${text}\x1b[0m`) : text)
    last = idx
  }
  return out.join('\n')
}

export const changedLineCount = (before: string, after: string) => diffLines(before, after).filter((l) => l.op !== ' ').length
