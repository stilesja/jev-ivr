import WebSocket from 'ws';

type Msg = Record<string, unknown> & { type: string };

/** A minimal Twilio ConversationRelay stand-in: connects, sends the documented inbound messages, collects outbound ones. */
export class FakeRelay {
  readonly received: Msg[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Array<() => void> = [];

  private constructor(private readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    ws.on('message', (data) => {
      this.received.push(JSON.parse(data.toString()) as Msg);
      const w = this.waiters;
      this.waiters = [];
      for (const fn of w) fn();
    });
  }

  static connect(url: string): Promise<FakeRelay> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(new FakeRelay(ws)));
      ws.once('error', reject);
    });
  }

  send(msg: Msg): void {
    this.ws.send(JSON.stringify(msg));
  }

  setup(callSid: string, sessionId = `VX-${callSid}`, extras: Record<string, unknown> = {}): void {
    this.send({ type: 'setup', sessionId, callSid, from: '+15550000001', to: '+15550000002', customParameters: {}, ...extras });
  }

  prompt(text: string, last = true): void {
    this.send({ type: 'prompt', voicePrompt: text, lang: 'en-US', last });
  }

  dtmf(digits: string): void {
    for (const digit of digits) this.send({ type: 'dtmf', digit });
  }

  interrupt(utterance: string, ms: number): void {
    this.send({ type: 'interrupt', utteranceUntilInterrupt: utterance, durationUntilInterruptMs: ms });
  }

  /** Resolve once a received message satisfies pred (checking already-received ones first). */
  waitFor(pred: (m: Msg) => boolean, timeoutMs = 3000): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const hit = this.received.find(pred);
        if (hit) {
          clearTimeout(timer);
          resolve(hit);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => reject(new Error(`timeout waiting for message; received ${JSON.stringify(this.received)}`)), timeoutMs);
      if (!check()) {
        const again = () => {
          if (!check()) this.waiters.push(again);
        };
        this.waiters.push(again);
      }
    });
  }

  /** Wait until at least n text messages have arrived; returns their tokens. */
  async waitForTexts(n: number, timeoutMs = 3000): Promise<string[]> {
    await this.waitFor(() => this.texts().length >= n, timeoutMs);
    return this.texts();
  }

  texts(): string[] {
    return this.received.filter((m) => m.type === 'text').map((m) => m.token as string);
  }

  close(): void {
    this.ws.close();
  }
}
