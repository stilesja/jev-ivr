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
  /** TTS provider/voice for the segments that are not recorded clips; set both or neither. */
  ttsProvider?: string;
  voice?: string;
}

/**
 * The ConversationRelay connect document. Attributes follow the spec's §5 and handoff §10.
 *
 * `partialPrompts="true"` is on for the no-input wait, not for scoring: the adapter still runs a
 * turn only on a final prompt, but a partial tells it the caller has started speaking, so the
 * wait is cancelled at the first syllable rather than after the whole utterance is transcribed.
 */
export function connectRelayTwiml(o: ConnectOptions): string {
  const attrs = [
    `url="wss://${escapeXml(o.publicHost)}/conversation?token=${escapeXml(o.token)}"`,
    'transcriptionProvider="Deepgram"',
    'speechModel="flux"',
    'partialPrompts="true"',
    'dtmfDetection="true"',
    // On speakerphone, room noise was interrupting prompt playback and leaving the caller in
    // silence until the no-input timer fired: low needs confident, longer speech to interrupt, and backchannels ("uh-huh") never do.
    'interruptible="any"',
    'interruptSensitivity="low"',
    'ignoreBackchannel="true"',
    'reportInputDuringAgentSpeech="any"',
    'deepgramSmartFormat="false"',
    `hints="${escapeXml(o.hints)}"`,
  ];
  if (o.ttsProvider && o.voice) {
    attrs.push(`ttsProvider="${escapeXml(o.ttsProvider)}"`, `voice="${escapeXml(o.voice)}"`);
  }
  return response(`<Connect action="https://${escapeXml(o.publicHost)}/cr-action"><ConversationRelay ${attrs.join(' ')}/></Connect>`);
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
