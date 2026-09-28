import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './api';

export interface SigMsg {
  from: string;
  to: string; // peer id or '*'
  type: string;
  data?: unknown;
}

/** A room's signalling channel (Supabase Realtime broadcast). */
export class Signal {
  private channel: RealtimeChannel | null = null;
  private handlers: ((m: SigMsg) => void)[] = [];
  readonly peerId: string;
  readonly room: string;

  constructor(room: string, peerId: string) {
    this.room = room;
    this.peerId = peerId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ch = supabase.channel(`bl-room-${this.room}`, { config: { broadcast: { self: false, ack: false } } });
      ch.on('broadcast', { event: 'sig' }, ({ payload }) => {
        const m = payload as SigMsg;
        if (m.to !== '*' && m.to !== this.peerId) return;
        for (const h of this.handlers) h(m);
      });
      const timer = setTimeout(() => reject(new Error('Could not reach the matchmaking server')), 12000);
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          reject(new Error('Matchmaking connection failed (' + status + ')'));
        }
      });
      this.channel = ch;
    });
  }

  on(h: (m: SigMsg) => void) {
    this.handlers.push(h);
    return () => {
      this.handlers = this.handlers.filter((x) => x !== h);
    };
  }

  send(to: string, type: string, data?: unknown) {
    if (!this.channel) return;
    const payload: SigMsg = { from: this.peerId, to, type, data };
    void this.channel.send({ type: 'broadcast', event: 'sig', payload });
  }

  close() {
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
    this.handlers = [];
  }
}

export interface RoomInfo {
  code: string;
  host: string;
  mode: string;
  players: number;
  max: number;
  status: 'lobby' | 'playing';
  ts: number;
}

/** Public room directory using Realtime presence (entries vanish when the host leaves). */
export class Lobby {
  private channel: RealtimeChannel | null = null;
  rooms: RoomInfo[] = [];
  onChange: ((rooms: RoomInfo[]) => void) | null = null;
  private tracked: RoomInfo | null = null;
  private key: string;

  constructor(key: string) {
    this.key = key;
  }

  connect(): Promise<void> {
    if (this.channel) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ch = supabase.channel('bl-lobby', { config: { presence: { key: this.key } } });
      ch.on('presence', { event: 'sync' }, () => {
        const state = ch.presenceState<RoomInfo>();
        const list: RoomInfo[] = [];
        for (const k of Object.keys(state)) for (const p of state[k]) if (p.code) list.push(p);
        list.sort((a, b) => b.ts - a.ts);
        this.rooms = list;
        this.onChange?.(list);
      });
      const timer = setTimeout(() => reject(new Error('Could not reach the matchmaking server')), 12000);
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timer);
          if (this.tracked) void ch.track(this.tracked);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timer);
          reject(new Error('Matchmaking connection failed'));
        }
      });
      this.channel = ch;
    });
  }

  async advertise(info: RoomInfo | null) {
    this.tracked = info;
    if (!this.channel) return;
    if (info) await this.channel.track(info);
    else await this.channel.untrack();
  }

  close() {
    if (this.channel) void supabase.removeChannel(this.channel);
    this.channel = null;
  }
}
