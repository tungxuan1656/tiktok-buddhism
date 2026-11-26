---
name: continue-episode
description: >-
  Resume an in-progress or blocked Buddhist slide episode in episodes/Tn via
  handoff, handle API attempt recovery, review pending drafts, draw remaining
  slides, and finalize. Use when continuing an incomplete episode (e.g.,
  /continue-episode).
---

# Continue an Existing Episode

Resume production from the saved state in `episodes/Tn` following `docs/workflow.md` and `docs/image-api.md`.

## 1. Read Relevant Guidelines

If not already read in the current session, read before handling images or scripts:

- `docs/workflow.md`
- `docs/image-api.md`
- `docs/visual-style.md`
- `docs/editorial.md` (if the episode is still in `draft`)

## 2. Run Handoff First

Identify the episode code `Tn` (if omitted, inspect `episodes/T*` statuses to locate the unfinished episode; ask if multiple episodes are incomplete).

Run `handoff` before reading old history or drawing slides:

```bash
node scripts/episode-tools.mjs handoff episodes/Tn
```

Do not redraw slides already marked `action: "keep"`.

## 3. Follow the `next` Action from Handoff

- **`busy`**: retry handoff after a short wait; this is not an API failure.
- **`inspect_attempt`**: stop and preserve the lookahead files. Report the mismatch; follow `docs/image-api.md` before sending or reconciling any request.
- **`resolve_attempt`**: inspect `blocked` and recover per `docs/image-api.md`:
  - `raw_recoverable: true`: normalize locally (no API call), then open and verify the compressed JPEG as usual:
    ```bash
    node scripts/draw-image.mjs --normalize episodes/Tn ATTEMPT
    ```
  - `raw_recoverable: null`: inspect `raw_issue` and fix ImageMagick/decoder errors before reconciling or redrawing.
  - `code: IMG_NOT_SENT`: the process stopped before POST. Use `--reconcile` with a note that it was never sent; no API-side lookup is needed.
  - Otherwise, `raw_recoverable: false`: keep `response.bin`; only after verifying the API-side outcome and fixing the root cause, run:
    ```bash
    node scripts/draw-image.mjs --reconcile episodes/Tn ATTEMPT --note "verified reconciliation outcome"
    ```
- **`prepare_script`**: complete `episodes/Tn/artifact/episode.json` and `references/` (reusing valid `character_drafts` if present), then run `validate` and `lock`.
- **`draw` / `repair`**: run `node scripts/draw-image.mjs --slide episodes/Tn N`, then visually verify the compressed JPEG and run `--checked` or `reject`.
- **`review`**: if handoff offers `lookahead: M`, start that one background draw per `docs/workflow.md`. Open `page.file`, verify text, diacritics, layout, and character consistency, then run `export-slide.mjs --checked` or `episode-tools.mjs reject`.
- **`wait_for_image`**: wait for the request listed in `in_progress` to finish, then rerun handoff; do not launch another request or reconcile the active one while waiting. If handoff also exposes `blocked`, report the API failure and stop review until recovery.
- **`attempt_limit`**: stop and report to the user that the 3-draft visual limit has been reached for that slide; do not bypass the limit or alter `episode.json` to match faulty output.
- **`finalize`**: run `node scripts/episode-tools.mjs finalize episodes/Tn` and hand off the directory path and slide count.
- **`done` / `inspect_artifact`**: report the current status or artifact issue.
