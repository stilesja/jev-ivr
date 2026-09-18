import { PROVIDERS } from '../domain/slots/provider';

const INTENT_WORDS = [
  'reschedule', 'cancel', 'appointment', 'confirm', 'billing', 'member ID', 'agent', 'representative',
  'schedule', 'book', 'next week', 'this week', 'tomorrow',
];
const NUMBER_WORDS = ['zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'double'];

/** Comma-separated vocabulary for the ConversationRelay `hints` attribute. */
export function buildHints(): string {
  const providers = PROVIDERS.map((p) => `Dr. ${p.name}`);
  return [...providers, ...INTENT_WORDS, ...NUMBER_WORDS].join(', ');
}
