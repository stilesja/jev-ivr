const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function response(body: string): string {
  return `${XML_HEAD}<Response>${body}</Response>`;
}

export interface ConnectOptions {
  publicHost: string;
  token: string;
  hints: string;
}

/** The ConversationRelay connect document. Attributes follow the spec's §5 and handoff §10, finals only. */
export function connectRelayTwiml(o: ConnectOptions): string {
  const attrs = [
    `url="wss://${escapeXml(o.publicHost)}/conversation?token=${escapeXml(o.token)}"`,
    'transcriptionProvider="Deepgram"',
    'speechModel="flux"',
    'partialPrompts="false"',
    'dtmfDetection="true"',
    'interruptible="any"',
    'interruptSensitivity="medium"',
    'reportInputDuringAgentSpeech="any"',
    'deepgramSmartFormat="false"',
    `hints="${escapeXml(o.hints)}"`,
  ].join(' ');
  return response(`<Connect action="https://${escapeXml(o.publicHost)}/cr-action"><ConversationRelay ${attrs}/></Connect>`);
}

export function dialTwiml(number: string): string {
  return response(`<Dial>${escapeXml(number)}</Dial>`);
}

export function hangupTwiml(): string {
  return response('<Hangup/>');
}

export function apologizeAndDialTwiml(number: string): string {
  return response(`<Say>Sorry, we lost the connection. Let me get someone to help you.</Say><Dial>${escapeXml(number)}</Dial>`);
}
