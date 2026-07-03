# Branch rulesets

Source-of-truth for `main`'s protection, kept as code (TAV-70). GitHub does not
auto-apply rulesets committed to a repo — apply the JSON here after any change.

## `main-merge-gate.json`

Enforces the merge gate that stops "two PRs each green in isolation, broken once
both land":

- **Pull request required** before merging (0 approvals — solo-maintainer repo;
  the gate is CI, not review).
- **Required status check, strict:** `typecheck · lint · test` (the `check` job
  in [`ci.yml`](../workflows/ci.yml)) must pass **and** the branch must be up to
  date with `main` before merging (`strict_required_status_checks_policy: true`).
  Requiring up-to-date is what closes the stale-PR gap: a green-but-behind PR
  must update — and re-run CI against current `main` — before it can land.
- Blocks force-push and deletion of `main`.

## Merge queue (optional, not in this ruleset)

A merge queue is the more ergonomic alternative to strict up-to-date — it rebases
each entry on the queue head and re-runs CI automatically, so contributors don't
hand-rebase. It is **not** in `main-merge-gate.json` because the REST rulesets API
and the ruleset JSON-import path both reject the `merge_queue` rule for this repo;
it can only be turned on in the web UI: **Settings → Rules → Rulesets →
main-merge-gate → Require merge queue**.

If you enable it, also drop `strict_required_status_checks_policy` back to `false`
(the queue owns "up to date", and GitHub treats the two as mutually exclusive).
`ci.yml` already carries the `merge_group:` trigger the queue needs — without it a
queued batch waits forever for a check that never dispatches, so keep it.

## Applying

Web UI: **Settings → Rules → Rulesets → New ruleset → Import**, select this file.

Or via `gh` (needs `repo` admin scope):

```sh
# Create (first time):
gh api -X POST repos/ipedrazas/ppmagent/rulesets --input .github/rulesets/main-merge-gate.json

# Update an existing ruleset (find its id with the list command):
gh api repos/ipedrazas/ppmagent/rulesets --jq '.[] | "\(.id)\t\(.name)"'
gh api -X PUT repos/ipedrazas/ppmagent/rulesets/<id> --input .github/rulesets/main-merge-gate.json
```

After applying, confirm on a throwaway PR that the check is listed as **Required**
and that a branch behind `main` shows **"This branch is out-of-date"** and cannot
merge until updated.
