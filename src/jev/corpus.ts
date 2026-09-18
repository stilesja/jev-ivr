import { readFileSync } from 'node:fs';
import { FORM_INTENTS, INTENTS, type FormId, type Intent } from '../domain/intents';

export interface DateLabel {
  mode?: string;
  month?: string;
  day?: string;
  weekday?: string;
  weekdayQualifier?: string;
  relativeDay?: string;
  window?: string;
}

export interface CorpusSlots {
  memberId?: { span: string; value: string };
  provider?: string;
  date?: DateLabel;
}

export interface AnswerOverride {
  noul?: number;
  probabilities?: Record<string, number>;
}

export interface CorpusEntry {
  id: string;
  text: string;
  intent: Intent;
  /** the form active when this utterance is spoken; no_form for a first utterance */
  context: 'no_form' | FormId;
  slots?: CorpusSlots;
  /** explicit distributions that replace the generated ones */
  answers?: Record<string, AnswerOverride>;
  tags?: string[];
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function parseCorpus(jsonl: string): CorpusEntry[] {
  const seen = new Set<string>();
  const seenText = new Map<string, string>();
  const out: CorpusEntry[] = [];
  for (const [i, line] of jsonl.split('\n').entries()) {
    if (!line.trim()) continue;
    let entry: CorpusEntry;
    try {
      entry = JSON.parse(line) as CorpusEntry;
    } catch (e) {
      throw new Error(`corpus line ${i + 1}: invalid JSON`, { cause: e });
    }
    if (!entry.id || !entry.text) throw new Error(`corpus line ${i + 1}: id and text are required`);
    if (!(INTENTS as readonly string[]).includes(entry.intent)) throw new Error(`corpus ${entry.id}: unknown intent ${entry.intent}`);
    if (entry.context !== 'no_form' && !(FORM_INTENTS as readonly string[]).includes(entry.context)) {
      throw new Error(`corpus ${entry.id}: unknown context ${entry.context}`);
    }
    if (seen.has(entry.id)) throw new Error(`corpus ${entry.id}: duplicate id`);
    seen.add(entry.id);
    const normalized = normalizeText(entry.text);
    const otherId = seenText.get(normalized);
    if (otherId) throw new Error(`corpus ${entry.id}: text duplicates ${otherId} after normalization`);
    seenText.set(normalized, entry.id);
    out.push(entry);
  }
  return out;
}

export function loadCorpus(path: string): CorpusEntry[] {
  return parseCorpus(readFileSync(path, 'utf8'));
}
