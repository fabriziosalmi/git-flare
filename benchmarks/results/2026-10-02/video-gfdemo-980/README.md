# The live scenes of the demo video

Terminal recordings (asciicast v2, raw: commands and their output with real timing) of the two live
scenes, recorded on staging with `scripts/video/record.mjs` from `video/sessions/`. Play them with
`asciinema play demo.cast`, or read the text with any JSON-lines reader.

- `demo.cast`: `scripts/demo.mjs` on repository gfdemo-980 (report: `../demo-gfdemo-980.json`), then `gf status`.
- `guard.cast`: a write token minted outside the platform and a push to main (`scripts/video/tamper.mjs`),
  the main guard's alert (`scripts/video/wait-guard.mjs`), `gf admin repo guard … restore`, then `gf status`.

The write token's id appears in the alert; the token itself is never printed and was revoked by the restore.
Recorded before the pre-publication review: `gf status` then printed "main is what the merge queue produced";
it now prints what the guard knows, "no write outside the merge queue seen", since `/status` does not read
main's head (the guard checks it on push events and at every merge round).
