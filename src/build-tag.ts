// =============================================================================
// build-tag — the worker's source-tree fingerprint, in its own module.
// -----------------------------------------------------------------------------
// WHY THIS IS A SEPARATE FILE. The tag used to live inline in index.ts (the
// process entry point that boots every Worker). A processor that wants to STAMP
// its build tag onto the evidence it writes cannot import it from there: index
// imports the processors, so the reverse import is circular and would drag the
// whole boot sequence into any module that just wants a string.
//
// Stamping the tag on persisted evidence is the fix for a real, observed class
// of silent failure: the mirrored source and the deployed image can diverge, and
// when they do the RUN still succeeds while quietly omitting whatever the newer
// code would have sent. The tag in /health only proves what index.ts said; the
// tag on the evidence row proves which code actually produced that row.
//
// THE TAG MUST CHANGE ON EVERY DEPLOY — this is not a formality.
// Run 6a828358aadccfd208542700 shipped two different code states under ONE
// identical tag. Run 6a82abde4cf09e40919bba77 then repeated it exactly: /health
// served this tag, the mirrored processor contained the clearance aggregation,
// and the delivered evidence arrays were STILL empty while the per-word flags
// were set — the signature of the older processor. Because the tag had not
// moved, /health could not distinguish "the new code is running" from "the old
// image was reused", so the only remaining way to tell was to spend a run and
// audit the output. A tag that does not move on every deploy makes deployment
// unfalsifiable, which is the one thing it exists to prove.
//
// RULE: bump the trailing revision on EVERY push, even when the change is a
// re-copy of an unchanged file. Verify /health shows the new revision BEFORE
// spending a refinement run.
// =============================================================================

export const BUILD_TAG = '2026-08-19a-r1-policy-v8-symmetric-seam-clamp';
