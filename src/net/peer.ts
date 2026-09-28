import { ICE_SERVERS } from '../config';
import type { Signal } from './signal';

function toB64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function fromB64(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/**
 * One peer-to-peer link (host ↔ client) with an unreliable channel for
 * snapshots/inputs and a reliable one for events. If WebRTC can't connect
 * (strict NATs), traffic is relayed through the Supabase signalling channel.
 */
export class PeerLink {
  readonly remote: string;
  private pc: RTCPeerConnection;
  private u: RTCDataChannel | null = null;
  private r: RTCDataChannel | null = null;
  private signal: Signal;
  private off: () => void;
  private relay = false;
  private relayLastU = 0;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private closed = false;
  onUnreliable: ((buf: ArrayBuffer) => void) | null = null;
  onReliable: ((msg: any) => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;
  open = false;

  constructor(signal: Signal, remote: string, initiator: boolean) {
    this.signal = signal;
    this.remote = remote;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) signal.send(remote, 'ice', e.candidate.toJSON());
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if ((s === 'failed' || s === 'disconnected') && !this.relay && !this.open) this.startRelay();
      if (s === 'closed' || (s === 'failed' && this.open && !this.relay)) this.handleClose();
    };
    this.pc.ondatachannel = (e) => this.setupChannel(e.channel);
    this.off = signal.on((m) => {
      if (m.from !== remote) return;
      void this.onSignal(m.type, m.data);
    });
    if (initiator) {
      this.setupChannel(this.pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }));
      this.setupChannel(this.pc.createDataChannel('r', { ordered: true }));
      void this.pc
        .createOffer()
        .then((o) => this.pc.setLocalDescription(o))
        .then(() => signal.send(remote, 'offer', this.pc.localDescription?.toJSON()));
    }
    // fall back to relay if a direct link isn't up in time
    setTimeout(() => {
      if (!this.open && !this.closed) this.startRelay();
    }, 9000);
  }

  private startRelay() {
    if (this.relay || this.closed) return;
    this.relay = true;
    this.signal.send(this.remote, 'relay-on');
    this.markOpen();
  }

  private markOpen() {
    if (this.open) return;
    this.open = true;
    this.onOpen?.();
  }

  private setupChannel(ch: RTCDataChannel) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'u') this.u = ch;
    else this.r = ch;
    ch.onmessage = (e) => {
      if (ch.label === 'u') {
        if (e.data instanceof ArrayBuffer) this.onUnreliable?.(e.data);
      } else {
        try {
          this.onReliable?.(JSON.parse(e.data as string));
        } catch {
          /* ignore */
        }
      }
    };
    ch.onopen = () => {
      if (this.u?.readyState === 'open' && this.r?.readyState === 'open') this.markOpen();
    };
    ch.onclose = () => {
      if (!this.relay) this.handleClose();
    };
  }

  private async onSignal(type: string, data: any) {
    try {
      switch (type) {
        case 'offer':
          await this.pc.setRemoteDescription(data);
          await this.flushCandidates();
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          this.signal.send(this.remote, 'answer', this.pc.localDescription?.toJSON());
          break;
        case 'answer':
          await this.pc.setRemoteDescription(data);
          await this.flushCandidates();
          break;
        case 'ice':
          if (this.pc.remoteDescription) await this.pc.addIceCandidate(data);
          else this.pendingCandidates.push(data);
          break;
        case 'relay-on':
          if (!this.relay) {
            this.relay = true;
            this.markOpen();
          }
          break;
        case 'ru':
          if (this.relay) this.onUnreliable?.(fromB64(data as string));
          break;
        case 'rr':
          if (this.relay) this.onReliable?.(data);
          break;
        case 'bye':
          this.handleClose();
          break;
      }
    } catch (err) {
      console.warn('peer signal error', err);
    }
  }

  private async flushCandidates() {
    for (const c of this.pendingCandidates) {
      try {
        await this.pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    }
    this.pendingCandidates = [];
  }

  get isRelay() {
    return this.relay;
  }

  sendU(buf: ArrayBuffer, relayMinInterval = 60) {
    if (this.closed) return;
    if (this.relay) {
      const now = performance.now();
      if (now - this.relayLastU < relayMinInterval) return;
      this.relayLastU = now;
      this.signal.send(this.remote, 'ru', toB64(buf));
      return;
    }
    if (this.u?.readyState === 'open' && this.u.bufferedAmount < 64 * 1024) this.u.send(buf);
  }

  sendR(msg: unknown) {
    if (this.closed) return;
    if (this.relay) {
      this.signal.send(this.remote, 'rr', msg);
      return;
    }
    if (this.r?.readyState === 'open') this.r.send(JSON.stringify(msg));
  }

  private handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.off();
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.onClose?.();
  }

  close() {
    if (this.closed) return;
    this.signal.send(this.remote, 'bye');
    this.handleClose();
  }
}
