/**
 * Code patcher for blockers (Apex, Flows, formulas, validation rules, LWC...).
 * The Build agent proposes a full updated file; Sunset shows a diff and the
 * developer approves, skips (becomes a manual task), or aborts. Every approved
 * patch is later proven by a check-only validation before it is committed.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agentia } from '../adapters/agentia.js'
import type { Reference } from '../core/referenceFinder.js'
import { changedLineCount, renderDiff } from '../util/diff.js'
import { choose, color } from '../util/index.js'

export interface PatchOutcome {
  file: string
  status: 'applied' | 'skipped' | 'unchanged' | 'failed'
  note?: string
}

const START = '<<<SUNSET_FILE'
const END = 'SUNSET_FILE>>>'

export function buildPatchPrompt(ref: Reference, content: string, qualified: string, replacement?: string): string {
  const goal = replacement
    ? `Replace every use of the field ${qualified} with ${replacement} (same meaning, same type). Change nothing else.`
    : `Remove every use of the field ${qualified} so it can be deleted, while keeping all other behaviour identical. ` +
      `If logic depended on the field, remove only that branch or assignment and keep the rest. Do not add new features, comments about Sunset, or unrelated refactors.`
  return [
    `You are editing Salesforce metadata file ${ref.file} (${ref.kind}).`,
    goal,
    `Return the COMPLETE updated file between a line containing exactly ${START} and a line containing exactly ${END}.`,
    `After ${END}, add one short sentence explaining the change.`,
    '',
    `${START}`,
    content,
    `${END}`,
  ].join('\n')
}

export function extractPatchedFile(answer: string): { content?: string; explanation: string } {
  const s = answer.indexOf(START)
  const e = answer.lastIndexOf(END)
  if (s < 0 || e < 0 || e <= s) return { explanation: answer.trim().slice(0, 300) }
  const content = answer
    .slice(s + START.length, e)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '')
  return { content: content.endsWith('\n') ? content : content + '\n', explanation: answer.slice(e + END.length).trim().slice(0, 300) }
}

/** Deterministic rename used by merge plans (no AI needed). */
export function renameFieldInText(text: string, _object: string, from: string, to: string): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`\\b${esc(from)}\\b`, 'gi'), to)
}

export async function proposeAndApply(
  agentia: Agentia,
  root: string,
  refs: Reference[],
  qualified: string,
  opts: { yes?: boolean; replacement?: string; deterministicRename?: { object: string; from: string; to: string } },
): Promise<PatchOutcome[]> {
  const out: PatchOutcome[] = []
  for (const ref of refs) {
    const path = join(root, ref.file)
    const before = readFileSync(path, 'utf8')
    let after: string | undefined
    let explanation = ''

    if (opts.deterministicRename) {
      after = renameFieldInText(before, opts.deterministicRename.object, opts.deterministicRename.from, opts.deterministicRename.to)
      explanation = `Renamed ${opts.deterministicRename.from} → ${opts.deterministicRename.to}.`
    } else {
      try {
        const answer = agentia.ask('build', buildPatchPrompt(ref, before, qualified, opts.replacement), 8 * 60_000)
        const parsed = extractPatchedFile(answer)
        after = parsed.content
        explanation = parsed.explanation
      } catch (err) {
        out.push({ file: ref.file, status: 'failed', note: `Build agent error: ${(err as Error).message.split('\n')[0]}` })
        continue
      }
    }

    if (!after) {
      out.push({ file: ref.file, status: 'failed', note: 'Build agent did not return a file.' })
      continue
    }
    if (after === before || changedLineCount(before, after) === 0) {
      out.push({ file: ref.file, status: 'unchanged', note: 'No change proposed.' })
      continue
    }
    if (new RegExp(`\\b${qualified.split('.')[1]}\\b`, 'i').test(after) && !opts.replacement && !opts.deterministicRename) {
      explanation += ' (Warning: the field name still appears in the proposed file.)'
    }

    console.log(`\n${color.bold(ref.kind)} ${color.cyan(ref.file)}`)
    console.log(renderDiff(before, after))
    if (explanation) console.log(color.dim(`Agent: ${explanation}`))

    let decision = 'approve'
    if (!opts.yes) decision = await choose('Apply this change?', ['approve', 'skip', 'abort'])
    if (decision === 'abort') throw new Error('Aborted by developer. Files already approved remain changed locally.')
    if (decision === 'skip') {
      out.push({ file: ref.file, status: 'skipped', note: 'Skipped by developer: change manually.' })
      continue
    }
    writeFileSync(path, after)
    out.push({ file: ref.file, status: 'applied', note: explanation })
  }
  return out
}
