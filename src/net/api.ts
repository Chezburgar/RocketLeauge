import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { MUSIC_BUCKET, SUPABASE_ANON_KEY, SUPABASE_URL } from '../config';
import { deviceLabel, getDeviceKey } from './device';

export type AccountStatus = 'pending' | 'approved' | 'denied' | 'banned';

export interface Account {
  id: string;
  name: string;
  status: AccountStatus;
  is_admin: boolean;
  device: string | null;
  created_at: string;
  approved_at: string | null;
  last_seen: string | null;
  loadout: Record<string, unknown>;
  stats: Record<string, number>;
}

export interface SongRow {
  id: string;
  title: string;
  artist: string;
  kind: 'menu' | 'anthem';
  path: string;
  duration: number | null;
  created_at?: string;
}

export interface PlaylistRow {
  id: string;
  name: string;
  mode: 'order' | 'shuffle' | 'radio';
  songs: string[];
}

export interface PublicContent {
  menu: {
    playlist: { id: string; name: string; mode: 'order' | 'shuffle' | 'radio' };
    epoch: string;
    songs: { id: string; title: string; artist: string; path: string; duration: number | null }[];
  } | null;
  anthems: { id: string; title: string; artist: string; path: string }[];
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  realtime: { params: { eventsPerSecond: 60 } },
});

export const publicUrl = (path: string) => `${SUPABASE_URL}/storage/v1/object/public/${MUSIC_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(cleanError(error.message));
  return data as T;
}

function cleanError(msg: string) {
  return msg.replace(/^.*?ERROR:\s*/i, '').replace(/\s*\(SQLSTATE.*$/, '');
}

async function key() {
  return getDeviceKey();
}

// ── player ────────────────────────────────────────────────────────────────
export const api = {
  async login(): Promise<Account | null> {
    return rpc<Account | null>('rl_login', { p_secret: await key() });
  },
  async register(name: string): Promise<Account> {
    return rpc<Account>('rl_register', { p_secret: await key(), p_name: name, p_device: deviceLabel() });
  },
  async rerequest(name: string): Promise<Account> {
    return rpc<Account>('rl_rerequest', { p_secret: await key(), p_name: name });
  },
  async saveLoadout(loadout: object) {
    await rpc('rl_save_loadout', { p_secret: await key(), p_loadout: loadout });
  },
  async addStats(stats: Record<string, number>) {
    return rpc<Record<string, number>>('rl_add_stats', { p_secret: await key(), p_stats: stats });
  },
  async ticket(): Promise<string> {
    return rpc<string>('rl_ticket', { p_secret: await key() });
  },
  async verifyTicket(ticket: string): Promise<{ id: string; name: string; is_admin: boolean; loadout: Record<string, unknown> } | null> {
    return rpc('rl_verify_ticket', { p_ticket: ticket });
  },
  async publicContent(): Promise<PublicContent> {
    return rpc<PublicContent>('rl_public_content');
  },

  // ── admin: players ──────────────────────────────────────────────────────
  admin: {
    async list(): Promise<Account[]> {
      return rpc<Account[]>('rl_admin_list', { p_secret: await key() });
    },
    async setStatus(id: string, status: AccountStatus): Promise<Account> {
      return rpc<Account>('rl_admin_set_status', { p_secret: await key(), p_id: id, p_status: status });
    },
    async setAdmin(id: string, isAdmin: boolean): Promise<Account> {
      return rpc<Account>('rl_admin_set_admin', { p_secret: await key(), p_id: id, p_is_admin: isAdmin });
    },
    async rename(id: string, name: string): Promise<Account> {
      return rpc<Account>('rl_admin_rename', { p_secret: await key(), p_id: id, p_name: name });
    },
    async remove(id: string) {
      await rpc('rl_admin_delete', { p_secret: await key(), p_id: id });
    },

    // ── admin: music ──────────────────────────────────────────────────────
    async music(): Promise<{ songs: SongRow[]; playlists: PlaylistRow[]; active: string | null }> {
      return rpc('rl_admin_music', { p_secret: await key() });
    },
    async uploadSong(file: File, kind: 'menu' | 'anthem', title: string, artist: string, onProgress?: (s: string) => void): Promise<string> {
      onProgress?.('Preparing…');
      const duration = await probeDuration(file);
      const { data, error } = await supabase.functions.invoke('rl-music-storage', {
        body: { secret: await key(), action: 'sign', filename: file.name, kind },
      });
      if (error || !data?.path) throw new Error(data?.error ?? error?.message ?? 'Could not start upload');
      onProgress?.('Uploading…');
      const up = await supabase.storage.from(MUSIC_BUCKET).uploadToSignedUrl(data.path, data.token, file, {
        contentType: file.type || guessType(file.name),
      });
      if (up.error) throw new Error(up.error.message);
      onProgress?.('Saving…');
      return rpc<string>('rl_admin_add_song', {
        p_secret: await key(),
        p_title: title,
        p_artist: artist,
        p_path: data.path,
        p_duration: duration,
        p_kind: kind,
      });
    },
    async updateSong(id: string, title: string, artist: string) {
      await rpc('rl_admin_update_song', { p_secret: await key(), p_id: id, p_title: title, p_artist: artist });
    },
    async deleteSong(id: string) {
      const path = await rpc<string | null>('rl_admin_delete_song', { p_secret: await key(), p_id: id });
      if (path) {
        await supabase.functions.invoke('rl-music-storage', { body: { secret: await key(), action: 'delete', path } });
      }
    },
    async savePlaylist(id: string | null, name: string, mode: string, songIds: string[]): Promise<string> {
      return rpc<string>('rl_admin_save_playlist', { p_secret: await key(), p_id: id, p_name: name, p_mode: mode, p_song_ids: songIds });
    },
    async deletePlaylist(id: string) {
      await rpc('rl_admin_delete_playlist', { p_secret: await key(), p_id: id });
    },
    async setActive(id: string | null) {
      await rpc('rl_admin_set_active', { p_secret: await key(), p_id: id });
    },
  },
};

function guessType(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  return (
    { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', flac: 'audio/flac' } as Record<string, string>
  )[ext ?? ''] ?? 'audio/mpeg';
}

function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = 'metadata';
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 10) / 10 : null);
    a.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    a.src = url;
  });
}

/** Parse "Artist - Title.mp3" style file names. */
export function parseSongName(filename: string): { title: string; artist: string } {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  const m = base.match(/^(.+?)\s+[-–]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: base, artist: '' };
}
