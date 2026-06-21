# Detection accuracy validation

This folder holds the ground-truth set that the detection engine is scored
against. The project's status guard says no detection method may be called
"resolved" until it reaches **90%+ on real samples validated against certified
manual counts** — this harness is how that bar is measured. Until cases exist
here, every accuracy claim (incl. "84–92%") is anecdotal.

## How scoring works

`scripts/validate-accuracy.mjs` runs the real engine (`src/lib/analysis.js`) on
each micrograph and compares the detected intercept total to your manual count.
A case **passes** when the detected total is within **10%** of the manual count
(= 90% detection). It reports per-case and aggregate results and exits non-zero
if any case fails, so it can gate CI later.

```
npm run validate                 # score every case in manifest.json
npm run validate -- --all-methods   # also show the other methods per case
npm run validate -- --self-test     # check the harness itself on a synthetic grid
node scripts/validate-accuracy.mjs --lines <caseId>   # print the test-line geometry
```

## The manual-counting protocol (do this exactly)

Detection accuracy must be measured along the **same test lines the tool draws**,
otherwise you are comparing different lines and the number is meaningless. The
lines are deterministic — they depend only on image size, orientation, and
`numLines`, not on detection.

1. Save the micrograph as **8-bit PNG** (lossless — JPEG artefacts corrupt
   boundary detection) into `validation/fixtures/`.
2. Add a case to `manifest.json` (copy the `_example`): set `id`, `image`, the
   `params` you want to validate (method, orientation, numLines, sensitivity),
   and a short `description`.
3. Run `node scripts/validate-accuracy.mjs --lines <yourCaseId>`. It prints the
   exact pixel coordinates of every test line, in order.
4. Open the micrograph in an image viewer, overlay each line at those
   coordinates, and **count grain-boundary intercepts by hand** along each line.
   This is your certified manual count.
5. Put those counts in `manualPerLine` (same order as printed). Per-line counts
   are preferred — they localise *where* detection misses. Alternatively set a
   single `manualTotal`.
6. Run `npm run validate`.

## Optional: customer-facing outcome error

If you also know the real scale and an independently measured grain size, set
`scaleMicronsPerPixel` and `manualMliMicrons`. The harness then reports the error
in the final MLI (µm) and ASTM G number — the values the customer actually reads.

## Case fields

| field | required | meaning |
|-------|----------|---------|
| `id` | yes | unique slug, used by `--lines` |
| `image` | yes | path relative to `validation/` (e.g. `fixtures/x.png`) |
| `params` | yes | passed to `analyzeImage` (`method`, `orientation`, `numLines`, `sensitivity`) |
| `manualPerLine` | one of these | per-line manual counts, in `--lines` order |
| `manualTotal` | one of these | total manual count, if not counting per line |
| `description` | no | shown in the report |
| `scaleMicronsPerPixel` | no | enables MLI/ASTM outcome error |
| `manualMliMicrons` | no | independently measured grain size for outcome error |
| `notes` | no | who counted, when, how |

Fixtures are real customer/dissertation micrographs and may be confidential —
check before committing image files. The harness works whether or not the PNGs
are tracked in git; only `manifest.json` and the scripts need to be.
