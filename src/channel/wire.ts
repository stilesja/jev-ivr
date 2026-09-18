import { DEFAULT_LANG, type InboundFrame, type OutboundFrame } from './frames';

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): v is string {
  return typeof v === 'string';
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
      const extras: Partial<Extract<InboundFrame, { type: 'setup' }>> = {};
      for (const k of ['accountSid', 'parentCallSid', 'forwardedFrom', 'callType', 'callerName', 'direction', 'callStatus'] as const) {
        if (str(m[k])) extras[k] = m[k] as string;
      }
      const custom: Record<string, string> = {};
      if (isObj(m.customParameters)) for (const [k, v] of Object.entries(m.customParameters)) if (str(v)) custom[k] = v;
      return {
        type: 'setup',
        sessionId: m.sessionId,
        callSid: m.callSid,
        from: str(m.from) ? m.from : '',
        to: str(m.to) ? m.to : '',
        customParameters: custom,
        ...extras,
      };
    }
    case 'prompt':
      if (!str(m.voicePrompt)) return null;
      return {
        type: 'prompt',
        voicePrompt: m.voicePrompt,
        lang: str(m.lang) ? m.lang : DEFAULT_LANG,
        last: typeof m.last === 'boolean' ? m.last : true,
      };
    case 'dtmf':
      if (!str(m.digit) || m.digit.length !== 1) return null;
      return { type: 'dtmf', digit: m.digit };
    case 'interrupt':
      if (!str(m.utteranceUntilInterrupt) || typeof m.durationUntilInterruptMs !== 'number') return null;
      return { type: 'interrupt', utteranceUntilInterrupt: m.utteranceUntilInterrupt, durationUntilInterruptMs: m.durationUntilInterruptMs };
    case 'error':
      return { type: 'error', description: str(m.description) ? m.description : '' };
    default:
      return null;
  }
}

export function serializeOutbound(frame: OutboundFrame): string {
  return JSON.stringify(frame);
}
