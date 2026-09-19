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
      return [
        ...decision.acks.map((a) => textFrame(promptText(a.promptId, a.vars), false)),
        textFrame(promptText(decision.promptId, decision.vars), false),
        textFrame(promptText('goodbye', {}), false),
        endFrame('completed', decision.completed),
      ];
    case 'handoff':
      return [
        ...decision.acks.map((a) => textFrame(promptText(a.promptId, a.vars), false)),
        textFrame(promptText(decision.promptId, {}), false),
        endFrame(decision.reason, decision.completed, decision.queued),
      ];
  }
}

/**
 * What the caller hears, built straight from the manifest. Deriving this from
 * rendered frames would couple session state to the channel's framing, so the
 * text a later turn reasons about is defined here instead.
 */
export function spokenText(decision: Decision): string {
  switch (decision.kind) {
    case 'ignore':
    case 'hold':
      return '';
    case 'replay':
      return decision.text;
    case 'prompt':
      return [...decision.acks.map((a) => promptText(a.promptId, a.vars)), promptText(decision.promptId, decision.vars)].join(' ');
    case 'complete':
      return [...decision.acks.map((a) => promptText(a.promptId, a.vars)), promptText(decision.promptId, decision.vars), promptText('goodbye', {})].join(' ');
    case 'handoff':
      return [...decision.acks.map((a) => promptText(a.promptId, a.vars)), promptText(decision.promptId, {})].join(' ');
  }
}

/** The spoken text of a decision, for the CLI. */
export function decisionText(decision: Decision): string {
  return spokenText(decision);
}
