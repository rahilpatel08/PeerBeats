import type { Socket } from 'socket.io-client';

// Kept low so a listener's ping isn't stuck behind seconds of queued audio on a slow link.
const DIRECT_BUFFER = 256 * 1024;
// Pieces sent to the relay and not yet confirmed by it. A slow uplink fills this and waits.
const RELAY_WINDOW = 96 * 1024;
const RELAY_ACK_TIMEOUT_MS = 10000;

export type Payload = string | ArrayBuffer;

/**
 * One path between a listener and a contributor. Either a direct WebRTC channel, or the relay
 * through the tracker for phones whose networks don't let them reach each other. Both carry
 * exactly the same messages, so the code above never needs to know which it has.
 */
export interface Wire {
  readonly kind: 'direct' | 'relay';
  readonly isOpen: boolean;
  onMessage: (data: Payload) => void;
  onClose: () => void;
  send(data: Payload): void;
  /** Resolves when more can be queued without piling up. */
  ready(): Promise<void>;
  close(): void;
}

export class DirectWire implements Wire {
  readonly kind = 'direct';
  onMessage: (data: Payload) => void = () => {};
  onClose: () => void = () => {};
  private waiting: (() => void)[] = [];

  constructor(private channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = DIRECT_BUFFER / 2;
    channel.onmessage = (e) => this.onMessage(e.data);
    channel.onbufferedamountlow = () => this.release();
    channel.onclose = () => {
      this.release();
      this.onClose();
    };
  }

  get isOpen() {
    return this.channel.readyState === 'open';
  }

  private release() {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  send(data: Payload) {
    // Typed separately because the channel has one overload for each.
    if (!this.isOpen) return;
    if (typeof data === 'string') this.channel.send(data);
    else this.channel.send(data);
  }

  ready() {
    if (!this.isOpen || this.channel.bufferedAmount <= DIRECT_BUFFER) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  close() {
    this.channel.close();
  }
}

export class RelayWire implements Wire {
  readonly kind = 'relay';
  isOpen = false;
  onMessage: (data: Payload) => void = () => {};
  onClose: () => void = () => {};
  private closed = false;
  private unconfirmed = 0;
  private waiting: (() => void)[] = [];

  /** `peer` is the other end as the tracker knows it, and `side` is which end this one is. */
  constructor(private socket: Socket, readonly peer: string, private side: 'listener' | 'contributor') {}

  /** The other end agreed, so messages can flow. */
  open() {
    if (!this.closed) this.isOpen = true;
  }

  /** A message the tracker forwarded from the other end. */
  receive(data: Payload) {
    if (this.isOpen) this.onMessage(data);
  }

  private release() {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  send(data: Payload) {
    if (!this.isOpen) return;
    const size = typeof data === 'string' ? 0 : data.byteLength;
    this.unconfirmed += size;
    this.socket.timeout(RELAY_ACK_TIMEOUT_MS).emit('relay:data', { to: this.peer, kind: this.side, data }, (err: Error | null, ok?: boolean) => {
      this.unconfirmed -= size;
      // The tracker no longer knows the other end, or it has stopped answering.
      if (err || !ok) this.close(false);
      else if (this.unconfirmed <= RELAY_WINDOW / 2) this.release();
    });
  }

  ready() {
    if (!this.isOpen || this.unconfirmed <= RELAY_WINDOW) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  /** `tell` is false when the other end, or the tracker, is what closed it. */
  close(tell = true) {
    if (this.closed) return;
    this.closed = true;
    this.isOpen = false;
    if (tell) this.socket.emit('relay:close', { to: this.peer, kind: this.side });
    this.release();
    this.onClose();
  }
}
