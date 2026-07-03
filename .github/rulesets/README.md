# Branch rulesets

Source-of-truth for `main`'s protection, kept as code (TAV-70). GitHub does not
auto-apply rulesets committed to a repo — apply the JSON here after any change.

## `main-merge-gate.json`

Enforces the merge gate that stops "two PRs each green in isolation, broken once
both land":

- **Pull request required** before merging (0 approvals — solo-maintainer repo;
  the gate is CI, not review).
- **Required status check:** `typecheck · lint · test` (the `check` job in
  [`ci.yml`](../workflows/ci.yml)).
- **Merge queue** (`MERGE` method, `ALLGREEN`): each entry is rebased on the
  queue head and CI re-runs on the merged result before it lands — so a stale
  PR can't break `main`. The queue owns "up to date", which is why
  `strict_required_status_checks_policy` is `false` (GitHub treats the two as
  mutually exclusive).
- Blocks force-push and deletion of `main`.

### Dependency: CI must trigger on `merge_group`

`ci.yml` includes a `merge_group:` trigger. Without it the required check never
runs on a queued batch and **the queue waits forever** — do not remove it.

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
and that "Merge when ready" adds it to the queue.
