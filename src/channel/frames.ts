// Twilio ConversationRelay message protocol. This IS the internal protocol.
// Field names match the Twilio docs exactly; do not rename.

export interface SetupFrame {
  type: 'setup';
  sessionId: string;
  callSid: string;
  from: string;
  to: string;
  customParameters: Record<string, string>;
  // Optional fields Twilio also sends; passed through and logged, never read by the core.
  accountSid?: string;
  parentCallSid?: string;
  forwardedFrom?: string;
  callType?: string;
  callerName?: string;
  direction?: string;
  callStatus?: string;
}

export interface PromptFrame {
  type: 'prompt';
  voicePrompt: string;
  lang: string;
  last: boolean;
}

export interface DtmfFrame {
  type: 'dtmf';
  digit: string;
}

export interface InterruptFrame {
  type: 'interrupt';
  utteranceUntilInterrupt: string;
  durationUntilInterruptMs: number;
}

export interface ErrorFrame {
  type: 'error';
  description: string;
}

export type InboundFrame = SetupFrame | PromptFrame | DtmfFrame | InterruptFrame | ErrorFrame;

export interface TextFrame {
  type: 'text';
  token: string;
  last: boolean;
  lang: string;
  interruptible: boolean;
  preemptible: boolean;
}

export interface PlayFrame {
  type: 'play';
  source: string;
  loop: number;
  preemptible: boolean;
  interruptible: boolean;
}

export interface SendDigitsFrame {
  type: 'sendDigits';
  digits: string;
}

export interface LanguageFrame {
  type: 'language';
  ttsLanguage: string;
  transcriptionLanguage: string;
}

export interface EndFrame {
  type: 'end';
  handoffData: string;
}

export type OutboundFrame = TextFrame | PlayFrame | SendDigitsFrame | LanguageFrame | EndFrame;

export const DEFAULT_LANG = 'en-US';

export function promptFrame(text: string, last = true): PromptFrame {
  return { type: 'prompt', voicePrompt: text, lang: DEFAULT_LANG, last };
}

export function dtmfFrames(digits: string): DtmfFrame[] {
  return [...digits].map((digit) => ({ type: 'dtmf', digit }));
}

export function setupFrame(sessionId: string): SetupFrame {
  return {
    type: 'setup',
    sessionId,
    callSid: `CA-${sessionId}`,
    from: '+15550000001',
    to: '+15550000002',
    customParameters: {},
  };
}

export function textFrame(token: string, interruptible: boolean): TextFrame {
  return { type: 'text', token, last: true, lang: DEFAULT_LANG, interruptible, preemptible: false };
}

export function endFrame(reasonCode: string, completed: readonly string[] = [], queued: readonly string[] = []): EndFrame {
  return {
    type: 'end',
    handoffData: JSON.stringify({
      reasonCode,
      ...(completed.length ? { completed } : {}),
      ...(queued.length ? { queued } : {}),
    }),
  };
}
