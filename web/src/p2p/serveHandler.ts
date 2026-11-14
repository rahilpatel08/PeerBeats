import type { Socket } from 'socket.io-client';
import { getChunk } from './chunkStore';
import { getRtcConfig } from './rtcConfig';
import { DirectWire, RelayWire, type Payload, type Wire } from './wire';

const PIECE_BYTES = 16 * 1024;
const MAX_LISTENERS = 8;

interface ServeOptions {
  onServed: (bytes: number) => void;
  onConnections: (count: number) => void;
  onBadCopy: (chunkId: string) => void;
}

/**
 * One listener connected to this contributor, directly, through the relay, or for a moment both.
 * Answers requests one at a time, in order, on whichever path each request arrived.
 */
class ListenerLink {
  /** The direct connection, with its channel once the listener has opened one. */
  private direct: { pc: RTCPeerConnection; wire: DirectWire | null } | null = null;
  private relay: RelayWire | null = null;
  private wires = new Set<Wire>();
  private queue: { chunkId: string; wire: Wire }[] = [];
  private busy = false;
  private iceQueue: RTCIceCandidateInit[] = [];
  closed = false;

  constructor(
    private listenerSocketId: string,
    private socket: Socket,
    private options: ServeOptions,
    private onClose: () => void,
  ) {}

  private adopt(wire: Wire) {
    this.wires.add(wire);
    wire.onMessage = (data) => this.handleMessage(data, wire);
    wire.onClose = () => {
      this.wires.delete(wire);
      this.queue = this.queue.filter((item) => item.wire !== wire);
      if (wire === this.relay) this.relay = null;
      if (wire === this.direct?.wire) {
        // Its channel has closed, so the direct connection is over.
        this.direct.pc.close();
        this.direct = null;
      }
      this.closeIfUnreachable();
    };
  }

  /** Nothing open and nothing still connecting means this listener is gone. */
  private closeIfUnreachable() {
    const connecting = this.direct && !this.direct.wire && ['new', 'connecting', 'connected'].includes(this.direct.pc.connectionState);
    if (this.wires.size === 0 && !connecting) this.close();
  }

  /** Starts a direct connection from the listener's offer. A newer offer replaces an older one. */
  async answer(sdp: string, config: RTCConfiguration): Promise<string> {
    const previous = this.direct;
    const pc = new RTCPeerConnection(config);
    const direct: { pc: RTCPeerConnection; wire: DirectWire | null } = { pc, wire: null };
    this.direct = direct;
    this.iceQueue = [];
    previous?.pc.close();
    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.emit('signal:ice', { to: this.listenerSocketId, kind: 'contributor', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (this.direct !== direct || (pc.connectionState !== 'failed' && pc.connectionState !== 'closed')) return;
      if (direct.wire) {
        direct.wire.close();
        return;
      }
      this.direct = null;
      this.closeIfUnreachable();
    };
    pc.ondatachannel = (e) => {
      direct.wire = new DirectWire(e.channel);
      this.adopt(direct.wire);
    };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    for (const candidate of this.iceQueue.splice(0)) await pc.addIceCandidate(candidate);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer.sdp ?? '';
  }

  async addIce(candidate: RTCIceCandidateInit) {
    if (this.direct?.pc.remoteDescription) await this.direct.pc.addIceCandidate(candidate);
    else this.iceQueue.push(candidate);
  }

  /** The listener can't reach this phone directly, so it asked the tracker to pass messages on. */
  openRelay() {
    this.relay?.close(false);
    const relay = new RelayWire(this.socket, this.listenerSocketId, 'contributor');
    this.relay = relay;
    this.adopt(relay);
    relay.open();
    this.socket.emit('relay:accept', { to: this.listenerSocketId });
  }

  relayReceive(data: Payload) {
    this.relay?.receive(data);
  }

  relayClosed() {
    this.relay?.close(false);
  }

  private handleMessage(data: Payload, wire: Wire) {
    if (typeof data !== 'string') return;
    let message: { type?: string; chunkId?: string };
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.type === 'ping') {
      wire.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    const chunkId = message.chunkId;
    if (typeof chunkId !== 'string') return;
    if (message.type === 'get') {
      this.queue.push({ chunkId, wire });
      this.serveNext();
    } else if (message.type === 'cancel') {
      this.queue = this.queue.filter((item) => item.chunkId !== chunkId);
    } else if (message.type === 'bad') {
      this.options.onBadCopy(chunkId);
    }
  }

  private async serveNext() {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    try {
      await this.send(next.chunkId, next.wire);
    } catch {
      // The listener's own timeout moves it to its next source.
    }
    this.busy = false;
    this.serveNext();
  }

  private async send(chunkId: string, wire: Wire) {
    if (!wire.isOpen) return;
    const stored = await getChunk(chunkId);
    if (!stored) {
      wire.send(JSON.stringify({ type: 'miss', chunkId }));
      return;
    }
    wire.send(JSON.stringify({ type: 'chunk', chunkId, size: stored.bytes.byteLength }));
    for (let offset = 0; offset < stored.bytes.byteLength; offset += PIECE_BYTES) {
      await wire.ready();
      if (!wire.isOpen) return;
      wire.send(stored.bytes.slice(offset, offset + PIECE_BYTES));
    }
    this.options.onServed(stored.bytes.byteLength);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    for (const wire of [...this.wires]) wire.close();
    this.direct?.pc.close();
    this.onClose();
  }
}

/** Accepts connections from listeners, direct or relayed, and serves segments from local storage. */
export class ServeHandler {
  private links = new Map<string, ListenerLink>();

  /** The link for this listener. Null when it would be one listener too many. */
  private linkFor(from: string): ListenerLink | null {
    const existing = this.links.get(from);
    if (existing) return existing;
    if (this.links.size >= MAX_LISTENERS) return null;
    const link: ListenerLink = new ListenerLink(from, this.socket, this.options, () => {
      if (this.links.get(from) === link) this.links.delete(from);
      this.options.onConnections(this.links.size);
    });
    this.links.set(from, link);
    this.options.onConnections(this.links.size);
    return link;
  }

  private handleOffer = async ({ from, sdp }: { from: string; sdp: string }) => {
    const config = await getRtcConfig().catch(() => null);
    const link = config && this.linkFor(from);
    if (!link) return;
    try {
      this.socket.emit('signal:answer', { to: from, sdp: await link.answer(sdp, config) });
    } catch {
      // The relay may still carry this listener. If it doesn't, the link closes itself.
    }
  };

  private handleIce = ({ from, kind, candidate }: { from: string; kind: string; candidate: RTCIceCandidateInit }) => {
    if (kind === 'listener') this.links.get(from)?.addIce(candidate).catch(() => {});
  };

  private handleRelayOpen = ({ from }: { from: string }) => {
    const link = this.linkFor(from);
    if (link) link.openRelay();
    else this.socket.emit('relay:close', { to: from, kind: 'contributor' });
  };

  private handleRelayData = ({ from, data }: { from: string; data: Payload }) => {
    this.links.get(from)?.relayReceive(data);
  };

  private handleRelayClose = ({ from }: { from: string }) => {
    this.links.get(from)?.relayClosed();
  };

  /** The tracker forgets every relay when this phone's connection to it drops. */
  private handleDisconnect = () => {
    for (const link of [...this.links.values()]) link.relayClosed();
  };

  constructor(private socket: Socket, private options: ServeOptions) {
    socket.on('signal:offer', this.handleOffer);
    socket.on('signal:ice', this.handleIce);
    socket.on('relay:open', this.handleRelayOpen);
    socket.on('relay:data', this.handleRelayData);
    socket.on('relay:close', this.handleRelayClose);
    socket.on('disconnect', this.handleDisconnect);
  }

  stop() {
    this.socket.off('signal:offer', this.handleOffer);
    this.socket.off('signal:ice', this.handleIce);
    this.socket.off('relay:open', this.handleRelayOpen);
    this.socket.off('relay:data', this.handleRelayData);
    this.socket.off('relay:close', this.handleRelayClose);
    this.socket.off('disconnect', this.handleDisconnect);
    for (const link of [...this.links.values()]) link.close();
  }
}
