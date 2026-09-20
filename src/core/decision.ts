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
  target: 'intent' | 'confirm' | SlotId | null;
  /** spoken options, for disambiguation and menus */
  options: string[];
  /** this prompt played the DTMF intent menu, so the next digit picks an option */
  menu?: boolean;
}

export interface CompleteDecision {
  kind: 'complete';
  form: FormId;
  promptId: string;
  vars: Record<string, string>;
  /** implicit-confirm and bridge phrases spoken before the completion */
  acks: Ack[];
  /** forms closed by a completion prompt on this call */
  completed: FormId[];
}

export interface HandoffDecision {
  kind: 'handoff';
  reason: string;
  promptId: string;
  acks: Ack[];
  completed: FormId[];
  /** intents the caller added that the call never started */
  queued: FormId[];
  /** what the call collected, as the caller heard it: filled slots only, display values */
  slots: Record<string, string>;
}

export type Decision =
  | { kind: 'ignore' }
  | { kind: 'hold' }
  | PromptDecision
  | CompleteDecision
  | HandoffDecision
  | { kind: 'replay'; text: string };
