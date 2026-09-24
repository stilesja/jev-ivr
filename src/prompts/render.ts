import manifest from './manifest.json';
import type { Decision } from '../core/decision';
import { endFrame, textFrame, type OutboundFrame, type PlayFrame } from '../channel/frames';
import { isPauseOnly, joinSpoken, segmentTemplate, stripLeadingPause, VAR } from './segments';
import { vocabularyClipId } from './clips';

export type PromptId = keyof typeof manifest;

export interface PromptEntry {
  text: string;
  interruptible: boolean;
}

export interface RenderContext {
  /** clip id → filename, from discoverClips */
  clips: Map<string, string>;
  /** absolute URL prefix the filename is appended to */
  audioBase: string;
}

export const PROMPTS: Record<string, PromptEntry> = manifest;

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(VAR, (_, name: string) => {
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

function playFrame(source: string, interruptible: boolean): PlayFrame {
  return { type: 'play', source, loop: 1, preemptible: false, interruptible };
}

/** One prompt as frames: clips where they exist, TTS text otherwise, adjacent text merged. */
export function promptFrames(promptId: string, vars: Record<string, string>, interruptible: boolean, ctx?: RenderContext | null): OutboundFrame[] {
  if (!ctx) return [textFrame(promptText(promptId, vars), interruptible)];
  const frames: OutboundFrame[] = [];
  let pieces: string[] = [];
  const flush = (): void => {
    if (pieces.length === 0) return;
    let text = joinSpoken(pieces);
    if (frames.at(-1)?.type === 'play') text = stripLeadingPause(text);
    if (text) frames.push(textFrame(text, interruptible));
    pieces = [];
  };
  const play = (file: string): void => {
    flush();
    frames.push(playFrame(ctx.audioBase + file, interruptible));
  };
  for (const s of segmentTemplate(promptId, promptEntry(promptId).text)) {
    if (s.kind === 'fixed') {
      const file = isPauseOnly(s.text) ? undefined : ctx.clips.get(s.id);
      if (file) play(file);
      else pieces.push(s.text);
      continue;
    }
    const value = vars[s.name];
    if (value === undefined) throw new Error(`prompt variable missing: ${s.name}`);
    const id = vocabularyClipId(s.name, value);
    const file = id ? ctx.clips.get(id) : undefined;
    if (file) play(file);
    else pieces.push(value);
  }
  flush();
  return frames;
}

export function decisionToFrames(decision: Decision, ctx?: RenderContext | null): OutboundFrame[] {
  switch (decision.kind) {
    case 'ignore':
    case 'hold':
      return [];
    case 'replay':
      return [textFrame(decision.text, true)];
    case 'prompt': {
      const frames: OutboundFrame[] = decision.acks.flatMap((a) => promptFrames(a.promptId, a.vars, promptEntry(a.promptId).interruptible, ctx));
      frames.push(...promptFrames(decision.promptId, decision.vars, promptEntry(decision.promptId).interruptible, ctx));
      return frames;
    }
    case 'complete':
      return [
        ...decision.acks.flatMap((a) => promptFrames(a.promptId, a.vars, promptEntry(a.promptId).interruptible, ctx)),
        ...promptFrames(decision.promptId, decision.vars, false, ctx),
        ...promptFrames('goodbye', {}, false, ctx),
        endFrame('completed', decision.completed),
      ];
    case 'handoff':
      return [
        ...decision.acks.flatMap((a) => promptFrames(a.promptId, a.vars, promptEntry(a.promptId).interruptible, ctx)),
        ...promptFrames(decision.promptId, {}, false, ctx),
        endFrame(decision.reason, decision.completed, decision.queued, decision.slots),
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
