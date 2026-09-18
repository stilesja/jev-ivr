// Tier 3b (handoff §9). Interface only in this sub-project; the stub
// always reports unavailable so the retry policy reaches DTMF collection.

export interface ExtractionRequest {
  slotType: string;
  spanText: string;
  fullTranscript: string;
  expectedMask: string;
  attempt: number;
}

export interface ExtractionResult {
  value: string;
  confidence: number;
  needsConfirmation: boolean;
}

export interface LlmNormalizer {
  normalize(req: ExtractionRequest): Promise<ExtractionResult | 'unavailable'>;
}

export const unavailableNormalizer: LlmNormalizer = {
  async normalize() {
    return 'unavailable';
  },
};
