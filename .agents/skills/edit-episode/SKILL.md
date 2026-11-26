---
name: edit-episode
description: >-
  Reopen a locked or finalized Buddhist slide episode to revise the script or
  replace faulty slide images per user feedback, preserving unchanged verified
  pages, then re-lock and finalize via handoff. Use when editing an existing
  episode (e.g., /edit-episode).
---

# Edit an Existing Episode

Apply only the user-requested changes inside the same `episodes/Tn` directory while preserving already-verified pages whose content and references remain unchanged.

## 1. Read Relevant Guidelines

If not already read in the current session, read before editing:

- `docs/workflow.md`
- `docs/editorial.md`
- `docs/visual-style.md`
- `docs/image-api.md`

## 2. Check Current Episode State

Inspect the current state first:

```bash
node scripts/episode-tools.mjs handoff episodes/Tn
```

If the episode is blocked by `resolve_attempt`, resolve the blocked attempt per `docs/image-api.md` before reopening or locking.

## 3. Apply the Requested Edit

### Case A: Replace Faulty Slide Images Only (Script Unchanged)

1. If the episode is `ready_for_review` or `published`, reopen and re-lock it so it can be updated in `locked` state:
   ```bash
   node scripts/episode-tools.mjs reopen episodes/Tn
   node scripts/episode-tools.mjs lock episodes/Tn
   ```
2. Reject the specific target slide image (`artifact/images/NNN.jpg` or the current draft):
   ```bash
   node scripts/episode-tools.mjs reject episodes/Tn <relative-image-path> --note "specific visual defect description"
   ```
   Do not modify `episode.json` text to work around model rendering errors.

### Case B: Revise Script Text, Sources, or Scenes

1. If the episode is not in `draft` state, reopen it:
   ```bash
   node scripts/episode-tools.mjs reopen episodes/Tn
   ```
2. Edit `episodes/Tn/artifact/episode.json` (and `source.txt` if `verbatim`) directly per `docs/editorial.md`. If the edit changes the copyable content, update `request` directly with the wording the user authorized; ask first if the correction was not authorized. Never derive it from slides or create a second script revision or copy.
3. Validate and re-lock:
   ```bash
   node scripts/episode-tools.mjs validate episodes/Tn
   node scripts/episode-tools.mjs lock episodes/Tn
   ```
   Pages with unchanged content and pinned references retain their existing verification receipts automatically.

## 4. Redraw Missing Pages and Finalize

1. Run `node scripts/episode-tools.mjs handoff episodes/Tn` and process each pending page until `handoff` returns `finalize`.
2. Run `node scripts/episode-tools.mjs finalize episodes/Tn` and report the updated deliverable to the user.
3. Never run `publish` unless the user explicitly confirms the episode has been published.
