import { DEFAULT_LANG, type InboundFrame, type OutboundFrame, type SetupFrame } from './frames';

type Obj = Record<string, unknown>;

/** Max length for any untrusted inbound string field. */
export const MAX_TEXT_LENGTH = 4000;
const MAX_CUSTOM_PARAMS = 50;
const MAX_CUSTOM_PARAM_VALUE_LENGTH = 500;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_TEXT_LENGTH;
}

/** Parse one ConversationRelay message. Returns null for anything not in the documented set. */
export function parseInbound(raw: string): InboundFrame | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || !str(m.type)) return null;
  switch (m.type) {
    case 'setup': {
      if (!str(m.sessionId) || !str(m.callSid)) return null;
      if (m.from !== undefined && !str(m.from)) return null;
      if (m.to !== undefined && !str(m.to)) return null;
      const extras: Partial<
        Pick<SetupFrame, 'accountSid' | 'parentCallSid' | 'forwardedFrom' | 'callType' | 'callerName' | 'direction' | 'callStatus'>
      > = {};
      for (const k of ['accountSid', 'parentCallSid', 'forwardedFrom', 'callType', 'callerName', 'direction', 'callStatus'] as const) {
        if (str(m[k])) extras[k] = m[k];
      }
      const customRaw: Record<string, string> = Object.create(null);
      if (isObj(m.customParameters)) {
        let count = 0;
        for (const [k, v] of Object.entries(m.customParameters)) {
          if (count >= MAX_CUSTOM_PARAMS) break;
          if (typeof v === 'string' && v.length <= MAX_CUSTOM_PARAM_VALUE_LENGTH) {
            customRaw[k] = v;
            count += 1;
          }
        }
      }
      const customParameters: Record<string, string> = { ...customRaw };
      return {
        type: 'setup',
        sessionId: m.sessionId,
        callSid: m.callSid,
        from: str(m.from) ? m.from : '',
        to: str(m.to) ? m.to : '',
        customParameters,
        ...extras,
      };
    }
    case 'prompt': {
      if (!str(m.voicePrompt)) return null;
      if (m.lang !== undefined && !str(m.lang)) return null;
      if (m.last !== undefined && typeof m.last !== 'boolean') return null;
      return {
        type: 'prompt',
        voicePrompt: m.voicePrompt,
        lang: str(m.lang) ? m.lang : DEFAULT_LANG,
        // Defaults to true because TwiML has partialPrompts off: every prompt message is complete.
        last: typeof m.last === 'boolean' ? m.last : true,
      };
    }
    case 'dtmf':
      if (!str(m.digit) || !/^[0-9*#]$/.test(m.digit)) return null;
      return { type: 'dtmf', digit: m.digit };
    case 'interrupt':
      if (!str(m.utteranceUntilInterrupt)) return null;
      if (typeof m.durationUntilInterruptMs !== 'number' || !Number.isFinite(m.durationUntilInterruptMs) || m.durationUntilInterruptMs < 0) {
        return null;
      }
      return { type: 'interrupt', utteranceUntilInterrupt: m.utteranceUntilInterrupt, durationUntilInterruptMs: m.durationUntilInterruptMs };
    case 'error':
      if (m.description !== undefined && !str(m.description)) return null;
      return { type: 'error', description: str(m.description) ? m.description : '' };
    // 'silence' is never sent by Twilio -- it is synthesized by the server's no-input timer
    // (silenceFrame() in frames.ts) -- so it falls through to the default and is rejected here.
    default:
      return null;
  }
}

export function serializeOutbound(frame: OutboundFrame): string {
  switch (frame.type) {
    case 'text':
      return JSON.stringify({
        type: frame.type,
        token: frame.token,
        last: frame.last,
        lang: frame.lang,
        interruptible: frame.interruptible,
        preemptible: frame.preemptible,
      });
    case 'play':
      return JSON.stringify({
        type: frame.type,
        source: frame.source,
        loop: frame.loop,
        preemptible: frame.preemptible,
        interruptible: frame.interruptible,
      });
    case 'sendDigits':
      return JSON.stringify({ type: frame.type, digits: frame.digits });
    case 'language':
      return JSON.stringify({
        type: frame.type,
        ttsLanguage: frame.ttsLanguage,
        transcriptionLanguage: frame.transcriptionLanguage,
      });
    case 'end':
      return JSON.stringify({ type: frame.type, handoffData: frame.handoffData });
    default: {
      const exhaustive: never = frame;
      throw new Error(`unknown outbound frame type: ${JSON.stringify(exhaustive)}`);
    }
  }
}
