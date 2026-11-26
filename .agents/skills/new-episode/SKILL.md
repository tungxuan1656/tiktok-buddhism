---
name: new-episode
description: >-
  Create a new Buddhist slide episode end-to-end from a prompt or tagged
  Markdown brief (for example /new-episode @brief.md) through ready_for_review.
  Use when the user asks to start a new episode.
---

# Create a New Episode

Execute the full episode production workflow using the repository's guidelines and scripts. Do not skip verification gates or ask the user to approve intermediate steps unless required by editorial policy.

## 1. Read Required Guidelines

If not already read in the current session, read these before drafting or generating images:

- `docs/workflow.md`
- `docs/editorial.md`
- `docs/visual-style.md`
- `characters/README.md`
- `templates/README.md`
- `docs/image-api.md`

Use the template, the current style reference, and the source and character assets relevant to this episode. Do not load stacks of past episodes or inspect CLI internals unless a specific question or failure requires it.

## 2. Lock Down the Brief and Sources

1. Capture the user's original request from the prompt after `/new-episode` or from the tagged file (see [brief-template.md](./references/brief-template.md) for a sample structure).
2. Classify the episode mode as `original`, `adaptation`, or `verbatim` per `docs/editorial.md`.
3. **Check sutra / Buddha quote sources**: open the exact source being quoted, compare the wording, and record the file or URL and edition/locator where available. Search snippets and a matching canonical reference do not verify the wording of this edition. If the exact source or translation cannot be verified, **ask the user before drafting**. Never guess sources or alter wording/punctuation.
4. If keeping verbatim wording readable exceeds the 35-slide maximum (including cover/closing), ask how to split across episodes rather than shrinking text or cutting quotes.

## 3. Allocate Code and Prepare Script

1. Allocate the next episode directory via script (never invent a code or print the episode code onto slides):
   ```bash
   node scripts/episode-tools.mjs new "Episode Title" "Original user request"
   ```
2. Search `characters/` for matching characters (read both JSON metadata and reference images; pick the highest version number with `user_approved`, otherwise `generated`; never use `retired`).
3. Write all slides directly into `episodes/Tn/artifact/episode.json` following `templates/episode.json`; do not repeat the full script in chat. Break lines or slides at natural points for readability before locking, without changing source wording or punctuation:
   - `verbatim`: save `episodes/Tn/source.txt` and align segments accurately.
   - `original` / `adaptation`: state grounding or mark agent-proposed illustration in `evidence`.
   - `text`: include only reader-facing copy (no episode codes, workflow statuses, or meta-notes).
4. If a new character is needed, after writing all 1–35 slides in `draft` status, place a prompt file inside `episodes/Tn/` and generate a text-free character reference per `docs/image-api.md`:
   ```bash
   node scripts/draw-image.mjs --character episodes/Tn ID/v1 episodes/Tn/character-prompt.txt [REF ...]
   ```
   Inspect the compressed JPEG, save `character.json` and the reference image as `generated` in `characters/`, and pin the snapshot under `episodes/Tn/references/`.

## 4. Validate and Lock Script

Run sequentially (no user script approval needed beforehand):

```bash
node scripts/episode-tools.mjs validate episodes/Tn
node scripts/episode-tools.mjs lock episodes/Tn
```

## 5. Draw and Visually Verify Each Slide

1. Run `node scripts/episode-tools.mjs handoff episodes/Tn` to get the next slide/action.
2. Generate the next slide:
   ```bash
   node scripts/draw-image.mjs --slide episodes/Tn N
   ```
   - Never call the image API directly, retry automatically, or switch model/provider. On API errors, stop the episode, preserve recovery files, and report per `docs/image-api.md`.
3. Open the **compressed JPEG** (`episodes/Tn/drafts/.../image.jpg`), zooming in if needed, and verify every line, character, diacritic, and punctuation mark against `slides[N-1].text`. Also check soft rounded sans-serif lettering in dark brown `#4B2F1E`, clean off-white paper background, layout balance, and character consistency per `docs/visual-style.md`.
4. Record the outcome once, immediately before moving to the next slide. Keep per-slide results in the check or reject record, not in `notes.md`:
   - Pass:
     ```bash
     node scripts/export-slide.mjs --checked episodes/Tn drafts/NNN-aK/image.jpg "visual check note for text, layout, and character"
     ```
   - Fail (max 3 visual drafts per identical slide content; never edit `episode.json` to accommodate a model error):
     ```bash
     node scripts/episode-tools.mjs reject episodes/Tn drafts/NNN-aK/image.jpg --note "specific visual defect description"
     ```
5. Give a short progress update every 5–10 newly verified slides, or report promptly if blocked.

## 6. Finalize and Hand Off

1. When `handoff` returns `next: "finalize"`, run:
   ```bash
   node scripts/episode-tools.mjs finalize episodes/Tn
   ```
2. Report the episode directory path (`episodes/Tn`), title, and verified slide count (`ready_for_review`) to the user. If comparable log metrics are already available, use the T36 baseline in `docs/workflow.md`; do not delay handoff to collect metrics.
3. Never call Telegram directly, publish posts, or mark `approved`/`published` without explicit user confirmation.
