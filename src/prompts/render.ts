import manifest from './manifest.json';
import type { Decision } from '../core/decision';
import { endFrame, textFrame, type OutboundFrame } from '../channel/frames';

export type PromptId = keyof typeof manifest;

export interface PromptEntry {
  text: string;
  interruptible: boolean;
  /** audio asset url; null until the Twilio sub-project records assets */
  audio?: string | null;
}

export const PROMPTS: Record<string, PromptEntry> = manifest;

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`prompt variable missing: ${name}`);
    return v;
  });
}

export function promptEntry(id: string): PromptEntry {
  const entry = PROMPTS[id];
  if (!entry) throw new Error(`unknown prompt id: ${id}`);
  return entry;
}

export function promptText(id: string, vars: Record<string, string>): string {
  return renderTemplate(promptEntry(id).text, vars);
}

export function handoffPromptId(reason: string): string {
  return `handoff_${reason.replace(/-/g, '_')}`;
}

export function decisionToFrames(decision: Decision): OutboundFrame[] {
  switch (decision.kind) {
    case 'ignore':
    case 'hold':
      return [];
    case 'replay':
      return [textFrame(decision.text, true)];
    case 'prompt': {
      const frames: OutboundFrame[] = decision.acks.map((a) => textFrame(promptText(a.promptId, a.vars), false));
      frames.push(textFrame(promptText(decision.promptId, decision.vars), promptEntry(decision.promptId).interruptible));
      return frames;
    }
    case 'complete':
      return [textFrame(promptText(decision.promptId, decision.vars), false), endFrame('completed')];
    case 'handoff':
      return [textFrame(promptText(decision.promptId, {}), false), endFrame(decision.reason)];
  }
}

/** The spoken text of a decision, for lastPromptText and the CLI. */
export function decisionText(decision: Decision): string {
  return decisionToFrames(decision)
    .filter((f): f is Extract<OutboundFrame, { type: 'text' }> => f.type === 'text')
    .map((f) => f.token)
    .join(' ');
}
