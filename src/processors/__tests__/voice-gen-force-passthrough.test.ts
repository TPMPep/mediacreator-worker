// =============================================================================
// CONTRACT REGRESSION TEST — voice-gen `force` pass-through (2026-06-24).
// -----------------------------------------------------------------------------
// Locks the fix for the silent-idempotent-skip bug: the run-level `force` flag
// MUST survive every hop of the voice-gen fan-out so generateOneSegment can
// bypass its already-ready idempotency guard when the operator explicitly asked
// to re-render (performance direction applied, voice changed, manual regen).
//
// The bug: runVoiceGeneration used `force` to SELECT segments for the run but
// dropped it before the per-segment job, and voice-gen.ts neither read nor
// forwarded it — so generateOneSegment never saw it, hit its idempotency guard,
// and retained the OLD (undirected) take. "I applied whisper and nothing changed."
//
// This test asserts the worker processor (the last hop before generateOneSegment)
// reads `force` off job.data and forwards it into the generateOneSegment payload.
// If a future refactor drops it again, this fails the build. SOC 2 CC8.1.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Base44 invoke layer so we can capture the EXACT payload the
// processor sends to generateOneSegment without any network/JWT machinery.
const invokeSpy = vi.fn(async () => ({ success: true }));
vi.mock('../../base44-client.js', () => ({
  invokeBase44Function: (...args: unknown[]) => invokeSpy(...args),
  logEvent: vi.fn(async () => {}),
}));

import { processVoiceGen } from '../voice-gen.js';

function makeJob(dataOverrides: Record<string, unknown>) {
  return {
    data: {
      schema_version: 1,
      project_id: 'proj_1',
      segment_id: 'trans_1',
      target_language: 'es-419',
      voice_id: 'voice_1',
      user_email: 'op@example.com',
      request_id: 'req_1',
      auth_token: 'jwt.scoped.token',
      ...dataOverrides,
    },
    attemptsMade: 0,
  } as never;
}

describe('voice-gen processor — force pass-through', () => {
  beforeEach(() => invokeSpy.mockClear());

  it('forwards force=true into the generateOneSegment payload', async () => {
    await processVoiceGen(makeJob({ force: true }));
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const { payload } = invokeSpy.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(payload.force).toBe(true);
  });

  it('defaults force to false when the producer did not set it (fresh dub)', async () => {
    await processVoiceGen(makeJob({})); // no force key — legacy/initial generation
    const { payload } = invokeSpy.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(payload.force).toBe(false);
  });

  it('coerces a falsy force to a strict boolean false (never undefined)', async () => {
    await processVoiceGen(makeJob({ force: undefined }));
    const { payload } = invokeSpy.mock.calls[0][0] as { payload: Record<string, unknown> };
    // Strict false — generateOneSegment must receive an explicit boolean so its
    // `_body.force === true` guard is unambiguous, never an absent key.
    expect(payload.force).toBe(false);
  });
});
