import { randomBytes } from 'node:crypto';

interface Entry {
  token: string;
  expiresAt: number;
}

/** One live token per call SID, carried in the ConversationRelay URL and checked at setup. */
export class CallTokens {
  private readonly byCall = new Map<string, Entry>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  mint(callSid: string): string {
    const token = randomBytes(16).toString('hex');
    this.byCall.set(callSid, { token, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  verify(token: string, callSid: string): boolean {
    const e = this.byCall.get(callSid);
    if (!e) return false;
    if (this.now() > e.expiresAt) {
      this.byCall.delete(callSid);
      return false;
    }
    return e.token === token;
  }

  revoke(callSid: string): void {
    this.byCall.delete(callSid);
  }
}
