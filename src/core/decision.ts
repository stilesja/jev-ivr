import type { SlotId } from '../domain/forms';
import type { FormId } from '../domain/intents';
import type { Ack } from './fia';

export interface PromptDecision {
  kind: 'prompt';
  promptId: string;
  vars: Record<string, string>;
  /** implicit-confirm phrases spoken before the prompt */
  acks: Ack[];
  /** what the prompt asks for; drives DTMF and attempt accounting */
  target: 'intent' | SlotId | null;
  /** spoken options, for disambiguation and menus */
  options: string[];
}

export type Decision =
  | { kind: 'ignore' }
  | { kind: 'hold' }
  | PromptDecision
  | { kind: 'complete'; form: FormId; promptId: string; vars: Record<string, string> }
  | { kind: 'handoff'; reason: string; promptId: string }
  | { kind: 'replay'; text: string };
