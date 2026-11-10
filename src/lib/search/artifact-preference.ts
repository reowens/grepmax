/** Explicit artifact requests may waive a prior; they never filter candidates. */
export interface ArtifactPreference {
  tests: boolean;
  documentation: boolean;
  history: boolean;
}

export function artifactPreference(query: string): ArtifactPreference {
  return {
    // A bare verb such as "test the connection" is not a request for test code.
    tests:
      /\b(?:tests|specs|fixtures)\b|\b(?:unit|integration|regression|smoke|snapshot|acceptance)\s+(?:tests?|checks?)\b|\b(?:which|what)\s+test\b|\btest\s+(?:files?|cases?|suites?)\b/i.test(
        query,
      ),
    // "document" can describe an input handled by production code. Require an
    // explicit documentation noun rather than treating PDF/document work as docs.
    // "manual" and "guide" also occur in ordinary code questions (manual memory
    // management, guide rails). Require a noun position for those ambiguous words.
    documentation:
      /\b(?:documentation|docs?|readme)\b|\b(?:guides?|manuals?)(?=\s*(?:[?.!,;:]|$))|\b(?:guides?|manuals?)\s+(?:for|on|about|that|which|describes?|explains?|covers?|should)\b/i.test(
        query,
      ),
    // Not bare "history", "archive" or "old": "conversation history" is common
    // in code questions and "archive" is a verb in product code.
    history:
      /\b(?:archived|superseded|deprecated|retired)\b|\b(?:old|older|previous|earlier|original|former|prior)\s+(?:plans?|designs?|versions?|docs?|documents?|approach(?:es)?|decisions?|rulings?|specs?)\b|\bhistory\s+of\b/i.test(
        query,
      ),
  };
}
