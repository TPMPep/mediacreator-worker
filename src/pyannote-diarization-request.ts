// Undefined/null means independent detection. Never serialize null, zero,
// provider counts, or estimated ranges as an exact speaker-count constraint.
export function buildPyannoteDiarizationRequest(sourceUrl: string, expectedSpeakers: unknown) {
  if (expectedSpeakers != null && (!Number.isInteger(expectedSpeakers) || typeof expectedSpeakers !== 'number' || expectedSpeakers < 1 || expectedSpeakers > 32)) {
    throw new Error('invalid_operator_speaker_count: expected speaker count must be an integer from 1 to 32 or absent for independent detection');
  }
  return {
    url: sourceUrl, model: 'precision-2', turnLevelConfidence: true,
    confidence: true, exclusive: false, transcription: false,
    ...(expectedSpeakers != null ? { numSpeakers: expectedSpeakers as number } : {}),
  };
}
