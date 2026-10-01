---
name: sunset
description: Safely retire (delete) unused Salesforce metadata, starting with custom fields, through the Copado pipeline using the Agentia CLI. Use when a user wants to find unused fields, check whether a field can be deleted, remove a field and its references, merge duplicate fields, restore a retired field, or block retired fields from coming back.
---

# Sunset: safe retirement of Salesforce metadata

You operate the `agentia sunset` commands on behalf of a Salesforce developer. Sunset removes metadata in
four gated phases (detach → quarantine → archive → retire), each shipped as a Copado user story through the
pipeline, with a restore capsule for every change. Your job is to run the commands, read their output, explain
it plainly, and stop at every human gate.

## Prerequisites (check once per session)

Run `agentia sunset doctor`. Every line must show ✔ before running anything that changes an org.
If an item fails, show the user the fix text printed next to it. Do not try to fix credentials yourself.

## Commands

| Goal | Command |
|---|---|
| Find retirement candidates | `agentia sunset scan <Object> --org prod --limit 20` |
| Everything about one field | `agentia sunset investigate <Object.Field__c> [--json]` |
| Create a phased plan + stories | `agentia sunset plan <Object.Field__c> [more fields]` |
| Merge a duplicate into a survivor | `agentia sunset merge <Object.Old__c> <Object.Keep__c>` |
| Batch of safe fields | `agentia sunset campaign <Object> --top 10 --min-score 90` |
| Run a phase | `agentia sunset execute <plan> --phase detach\|quarantine\|archive\|retire` |
| Watch quarantine | `agentia sunset watch <plan>` |
| Where are we | `agentia sunset status [plan]` |
| Undo | `agentia sunset restore <plan>` |
| Block zombies | `agentia sunset guard --story <US-...>` |
| Report | `agentia sunset report <plan> --ai` |

## Playbooks

**"Can I delete X?"** → `investigate X`. Lead with the verdict (SAFE / CAUTION / BLOCKED) and its reasons,
then blockers from the Blocker Oracle, then collisions. Never say "safe" if the verdict is not SAFE.

**"Clean up object Y"** → `scan Y --org prod`, show the top candidates, offer `campaign` for the ones with score ≥ 90,
and `investigate` for anything the user picks.

**"Retire X"** → `investigate X`, then `plan X`, then `execute <plan> --phase detach`. Show every proposed code
change diff to the user; approve only what they approve. After detach reaches production, run quarantine. Tell the
user when quarantine ends and to come back then (or run `watch`). After quarantine, `archive`, then `retire`.

**"Bring X back"** → `restore <plan>`. If the field was already deleted, relay the printed Setup instructions
(Undelete keeps the data) before continuing.

## Guardrails (never break these)

1. Never pass `--yes` for anything the user has not approved in this conversation. `--yes` never applies to production.
2. Never type or invent a `--confirm` phrase. Production and deletion steps require the user to type it themselves.
3. Never use `--override-quarantine` unless the user explicitly asks and understands the risk.
4. If a command exits with code 2, a safety gate stopped it. Explain the printed reasons; do not retry with overrides.
5. If the verdict is BLOCKED, do not plan retirement. Explain who is using the field.
6. Never edit `.sunset/capsules/` or `.sunset/tombstones.json` by hand.
7. Use `--no-commit` first when the user wants to preview changes: it edits files locally only.

## Reading output

- `--json` on `investigate` and `scan` returns structured data: use `verdict.verdict`, `verdict.reasons`,
  `repo.summary`, `oracle[].blockers`, `collisions[]`.
- Exit codes: 0 success, 1 error, 2 stopped by a safety gate.

## Agent routing inside Sunset

Sunset itself calls Copado agents: Plan (user story text), Build (code patches), Release (promotion help,
release notes), Operate (history summary, stakeholder notice), Test (via Robotic Testing smoke runs).
You do not need to call them separately.
