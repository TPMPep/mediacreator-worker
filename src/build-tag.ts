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
// =============================================================================

export const BUILD_TAG = '2026-08-16-speaker-island-seam-continuity-v32-segstate-policy3';
