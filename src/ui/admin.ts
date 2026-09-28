import { api, parseSongName, publicUrl, type Account, type PlaylistRow, type SongRow } from '../net/api';
import { btn, clear, fmtDuration, h, timeAgo, toast } from './dom';

type Tab = 'requests' | 'players' | 'music' | 'anthems';

/** In-game admin panel: access requests, player management and the menu music library. */
export class AdminPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabsEl: HTMLElement;
  private tab: Tab = 'requests';
  private accounts: Account[] = [];
  private songs: SongRow[] = [];
  private playlists: PlaylistRow[] = [];
  private active: string | null = null;
  private selected: string | null = null;
  private draft: { id: string | null; name: string; mode: PlaylistRow['mode']; songs: string[] } | null = null;
  private preview: HTMLAudioElement | null = null;
  private refreshTimer: number | null = null;
  private myId: string;
  onMusicChanged: (() => void) | null = null;

  constructor(myId: string, onBack: () => void) {
    this.myId = myId;
    this.tabsEl = h('div', { class: 'tabs' });
    this.body = h('div', { class: 'card panel', style: 'max-width:1250px' });
    this.el = h('div', { id: 'admin', class: 'screen sub vignette' },
      h('div', { class: 'sub-head' }, btn('◀ Back', () => { this.close(); onBack(); }, 'ghost sm back'), h('h2', null, 'ADMIN PANEL'), h('span', { class: 'badge admin' }, 'ADMIN')),
      this.tabsEl,
      this.body,
    );
  }

  async open() {
    this.renderTabs();
    this.body.appendChild(h('div', { class: 'spinner' }));
    await this.reload();
    this.refreshTimer = window.setInterval(() => {
      if (this.tab === 'requests' || this.tab === 'players') void this.reloadAccounts().then(() => this.render());
    }, 10000);
  }

  close() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.preview?.pause();
  }

  private async reloadAccounts() {
    try {
      this.accounts = await api.admin.list();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  private async reloadMusic() {
    try {
      const m = await api.admin.music();
      this.songs = m.songs;
      this.playlists = m.playlists;
      this.active = m.active;
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  private async reload() {
    await Promise.all([this.reloadAccounts(), this.reloadMusic()]);
    this.renderTabs();
    this.render();
  }

  private renderTabs() {
    clear(this.tabsEl);
    const pending = this.accounts.filter((a) => a.status === 'pending').length;
    const tabs: [Tab, string, number][] = [
      ['requests', 'Access requests', pending],
      ['players', 'Players', 0],
      ['music', 'Menu music', 0],
      ['anthems', 'Custom anthems', 0],
    ];
    for (const [id, label, count] of tabs) {
      this.tabsEl.appendChild(
        h('div', { class: 'tab' + (this.tab === id ? ' active' : ''), onClick: () => { this.tab = id; this.renderTabs(); this.render(); } },
          h('span', null, label, count ? h('span', { class: 'count' }, count) : null)),
      );
    }
  }

  private render() {
    clear(this.body);
    if (this.tab === 'requests') this.renderRequests();
    else if (this.tab === 'players') this.renderPlayers();
    else if (this.tab === 'music') this.renderMusic();
    else this.renderAnthems();
  }

  private async act(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  // ── requests ───────────────────────────────────────────────────────────
  private renderRequests() {
    const pending = this.accounts.filter((a) => a.status === 'pending');
    this.body.appendChild(h('p', { class: 'small', style: 'margin-top:0' }, 'New players choose a name on their device and wait here until you approve them. Each device is its own account.'));
    if (!pending.length) {
      this.body.appendChild(h('div', { class: 'empty-state' }, 'No pending requests right now. 🎉'));
      return;
    }
    const rows = pending.map((a) =>
      h('tr', null,
        h('td', { style: 'font-size:20px' }, a.name),
        h('td', { class: 'small' }, a.device ?? '—'),
        h('td', { class: 'small' }, timeAgo(a.created_at)),
        h('td', { style: 'text-align:right' },
          h('div', { class: 'row', style: 'justify-content:flex-end' },
            btn('Approve', () => this.act(async () => { await api.admin.setStatus(a.id, 'approved'); await this.reloadAccounts(); this.renderTabs(); this.render(); }, `${a.name} approved`), 'green sm'),
            btn('Deny', () => this.act(async () => { await api.admin.setStatus(a.id, 'denied'); await this.reloadAccounts(); this.renderTabs(); this.render(); }, `${a.name} denied`), 'red sm'),
          )),
      ),
    );
    this.body.appendChild(h('div', { class: 'scroll' }, h('table', { class: 'table' }, h('tr', null, h('th', null, 'Name'), h('th', null, 'Device'), h('th', null, 'Requested'), h('th', null, '')), ...rows)));
  }

  // ── players ────────────────────────────────────────────────────────────
  private renderPlayers() {
    const refresh = async () => {
      await this.reloadAccounts();
      this.renderTabs();
      this.render();
    };
    const rows = this.accounts.map((a) => {
      const me = a.id === this.myId;
      const actions: HTMLElement[] = [];
      if (a.status !== 'approved') actions.push(btn('Approve', () => this.act(async () => { await api.admin.setStatus(a.id, 'approved'); await refresh(); }), 'green sm'));
      if (!me && a.status === 'approved') actions.push(btn('Revoke', () => this.act(async () => { await api.admin.setStatus(a.id, 'denied'); await refresh(); }), 'sm ghost'));
      if (!me && a.status !== 'banned') actions.push(btn('Ban', () => this.act(async () => { await api.admin.setStatus(a.id, 'banned'); await refresh(); }), 'red sm'));
      if (!me && a.status === 'approved') actions.push(btn(a.is_admin ? 'Remove admin' : 'Make admin', () => this.act(async () => { await api.admin.setAdmin(a.id, !a.is_admin); await refresh(); }), 'sm ghost'));
      actions.push(btn('Rename', () => {
        const n = prompt('New name for ' + a.name, a.name);
        if (n) void this.act(async () => { await api.admin.rename(a.id, n); await refresh(); }, 'Renamed');
      }, 'sm ghost'));
      if (!me) actions.push(btn('Delete', () => {
        if (confirm(`Delete ${a.name}'s account? Their device will have to request access again.`)) void this.act(async () => { await api.admin.remove(a.id); await refresh(); }, 'Deleted');
      }, 'red sm'));
      const st = a.stats ?? {};
      return h('tr', null,
        h('td', { style: 'font-size:19px' }, a.name, me ? h('span', { class: 'small' }, ' (you)') : null),
        h('td', null, h('span', { class: 'badge ' + a.status }, a.status), a.is_admin ? h('span', { class: 'badge admin', style: 'margin-left:6px' }, 'admin') : null),
        h('td', { class: 'small' }, a.device ?? '—'),
        h('td', { class: 'small' }, `${st.games ?? 0} games · ${st.goals ?? 0} goals`),
        h('td', { class: 'small' }, timeAgo(a.last_seen)),
        h('td', null, h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px' }, ...actions)),
      );
    });
    this.body.appendChild(h('div', { class: 'scroll' }, h('table', { class: 'table' }, h('tr', null, h('th', null, 'Name'), h('th', null, 'Status'), h('th', null, 'Device'), h('th', null, 'Stats'), h('th', null, 'Last seen'), h('th', null, '')), ...rows)));
  }

  // ── music ──────────────────────────────────────────────────────────────
  private uploader(kind: 'menu' | 'anthem') {
    const list = h('div', { class: 'upload-list' });
    const input = h('input', { type: 'file', accept: 'audio/*', multiple: true, style: 'display:none' }) as HTMLInputElement;
    const zone = h('div', { class: 'dropzone ui-interactive' },
      h('div', { style: 'font-size:20px;color:#fff' }, kind === 'menu' ? '⬆ Upload songs' : '⬆ Upload anthems'),
      h('div', null, 'Drop audio files here or click to choose (mp3, ogg, wav, m4a · max 50 MB each). "Artist - Title.mp3" names are split automatically.'),
    );
    const handle = async (files: FileList | File[]) => {
      const arr = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|ogg|wav|m4a|aac|flac|webm)$/i.test(f.name));
      for (const f of arr) {
        const { title, artist } = parseSongName(f.name);
        const line = h('div', null, `${f.name} – `, h('span', { class: 'small' }, 'waiting'));
        list.appendChild(line);
        const status = line.lastChild as HTMLElement;
        try {
          await api.admin.uploadSong(f, kind, title, artist, (s) => (status.textContent = s));
          status.textContent = '✓ done';
          status.style.color = 'var(--good)';
        } catch (e) {
          status.textContent = '✗ ' + (e as Error).message;
          status.style.color = 'var(--bad)';
        }
      }
      await this.reloadMusic();
      this.onMusicChanged?.();
      this.render();
    };
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => input.files && void handle(input.files));
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      if (e.dataTransfer?.files) void handle(e.dataTransfer.files);
    });
    return h('div', null, zone, input, list);
  }

  private playPreview(song: SongRow) {
    if (!this.preview) this.preview = new Audio();
    if (this.preview.dataset.id === song.id && !this.preview.paused) {
      this.preview.pause();
      return;
    }
    this.preview.src = publicUrl(song.path);
    this.preview.dataset.id = song.id;
    this.preview.volume = 0.8;
    void this.preview.play().catch(() => toast('Could not play preview', true));
  }

  private songRow(s: SongRow, extra: HTMLElement[] = []) {
    return h('tr', null,
      h('td', null, h('button', { class: 'icon-btn', title: 'Preview', onClick: () => this.playPreview(s) }, '▶')),
      h('td', { style: 'font-size:18px' }, s.title),
      h('td', { class: 'small' }, s.artist || '—'),
      h('td', { class: 'small' }, fmtDuration(s.duration)),
      h('td', null, h('div', { class: 'row', style: 'justify-content:flex-end;gap:6px' }, ...extra,
        h('button', { class: 'icon-btn', title: 'Edit', onClick: () => {
          const title = prompt('Title', s.title);
          if (title === null) return;
          const artist = prompt('Artist', s.artist) ?? s.artist;
          void this.act(async () => { await api.admin.updateSong(s.id, title, artist); await this.reloadMusic(); this.onMusicChanged?.(); this.render(); });
        } }, '✎'),
        h('button', { class: 'icon-btn danger', title: 'Delete', onClick: () => {
          if (!confirm(`Delete "${s.title}"? It will be removed from every playlist.`)) return;
          void this.act(async () => { await api.admin.deleteSong(s.id); await this.reloadMusic(); this.onMusicChanged?.(); this.render(); }, 'Deleted');
        } }, '🗑'))),
    );
  }

  private renderMusic() {
    const menuSongs = this.songs.filter((s) => s.kind === 'menu');
    if (!this.draft && this.selected) {
      const p = this.playlists.find((x) => x.id === this.selected);
      if (p) this.draft = { id: p.id, name: p.name, mode: p.mode, songs: [...p.songs] };
    }
    // left: library
    const lib = h('div', null,
      h('h3', { style: 'margin:0 0 8px;font-family:var(--display)' }, 'Song library'),
      this.uploader('menu'),
      menuSongs.length
        ? h('div', { class: 'scroll', style: 'max-height:40vh;margin-top:10px' }, h('table', { class: 'table' }, ...menuSongs.map((s) =>
            this.songRow(s, this.draft ? [h('button', { class: 'icon-btn', title: 'Add to playlist', onClick: () => { this.draft!.songs.push(s.id); this.render(); } }, '+ Add')] : []))))
        : h('div', { class: 'empty-state' }, 'No songs uploaded yet.'),
    );
    // right: playlists
    const liveName = this.playlists.find((p) => p.id === this.active)?.name;
    const plList = h('div', { class: 'pl-list' },
      ...this.playlists.map((p) =>
        h('div', { class: 'pl-item' + (p.id === this.selected ? ' on' : ''), onClick: () => { this.selected = p.id; this.draft = null; this.render(); } },
          h('span', null, p.name, h('span', { class: 'small' }, `  ·  ${p.songs.length} songs · ${modeName(p.mode)}`)),
          p.id === this.active ? h('span', { class: 'badge live' }, 'LIVE') : null)),
    );
    const right = h('div', null,
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' },
        h('h3', { style: 'margin:0;font-family:var(--display)' }, 'Playlists'),
        btn('+ New playlist', () => { this.selected = null; this.draft = { id: null, name: 'New playlist', mode: 'order', songs: [] }; this.render(); }, 'sm')),
      h('p', { class: 'small', style: 'margin:0 0 8px' }, liveName ? `Playing for everyone in the main menu: ${liveName}` : 'No live playlist – everyone hears the built-in theme.'),
      this.playlists.length ? plList : h('div', { class: 'empty-state' }, 'Create a playlist, add songs, then press "Go live".'),
      this.draft ? this.renderDraft() : null,
    );
    this.body.appendChild(h('div', { class: 'split' }, lib, right));
  }

  private renderDraft() {
    const d = this.draft!;
    const name = h('input', { class: 'field', style: 'font-size:18px;text-align:left;padding:8px 10px', value: d.name, maxlength: '60' }) as HTMLInputElement;
    name.addEventListener('input', () => (d.name = name.value));
    const mode = h('select', { class: 'field', style: 'font-size:17px;padding:8px' }) as HTMLSelectElement;
    for (const m of ['order', 'shuffle', 'radio'] as const) mode.appendChild(h('option', { value: m, selected: d.mode === m }, modeName(m)));
    mode.addEventListener('change', () => (d.mode = mode.value as PlaylistRow['mode']));
    const songs = d.songs.map((id, i) => {
      const s = this.songs.find((x) => x.id === id);
      return h('div', { class: 'pl-song' },
        h('span', { class: 'small' }, String(i + 1)),
        h('span', { class: 'n' }, s ? `${s.title}${s.artist ? ' – ' + s.artist : ''}` : '(deleted)'),
        h('button', { class: 'icon-btn', onClick: () => { if (i > 0) [d.songs[i - 1], d.songs[i]] = [d.songs[i], d.songs[i - 1]]; this.render(); } }, '▲'),
        h('button', { class: 'icon-btn', onClick: () => { if (i < d.songs.length - 1) [d.songs[i + 1], d.songs[i]] = [d.songs[i], d.songs[i + 1]]; this.render(); } }, '▼'),
        h('button', { class: 'icon-btn danger', onClick: () => { d.songs.splice(i, 1); this.render(); } }, '✕'),
      );
    });
    const save = async (goLive: boolean) => {
      await this.act(async () => {
        const id = await api.admin.savePlaylist(d.id, d.name, d.mode, d.songs);
        d.id = id;
        this.selected = id;
        if (goLive) await api.admin.setActive(id);
        await this.reloadMusic();
        this.draft = null;
        this.onMusicChanged?.();
        this.render();
      }, goLive ? 'Playlist is now live for everyone' : 'Playlist saved');
    };
    return h('div', { class: 'card', style: 'padding:14px;margin-top:14px;background:rgba(0,0,0,0.25)' },
      h('div', { class: 'opts', style: 'grid-template-columns:90px 1fr;margin:0 0 10px' }, h('label', null, 'Name'), name, h('label', null, 'Order'), mode),
      h('p', { class: 'small', style: 'margin:0 0 8px' }, 'Radio sync: everyone hears the same song at the same moment.'),
      songs.length ? h('div', { style: 'max-height:30vh;overflow:auto' }, ...songs) : h('div', { class: 'small', style: 'padding:10px' }, 'Use "+ Add" in the library to add songs.'),
      h('div', { class: 'row', style: 'justify-content:flex-start;margin-top:12px' },
        btn('Save', () => void save(false), 'sm'),
        btn(d.id === this.active && d.id ? 'Save & keep live' : 'Save & go live', () => void save(true), 'green sm'),
        d.id === this.active && d.id ? btn('Stop live', () => this.act(async () => { await api.admin.setActive(null); await this.reloadMusic(); this.onMusicChanged?.(); this.render(); }, 'Live playlist stopped'), 'sm ghost') : null,
        d.id ? btn('Delete', () => {
          if (!confirm('Delete this playlist? (songs stay in the library)')) return;
          void this.act(async () => { await api.admin.deletePlaylist(d.id!); this.draft = null; this.selected = null; await this.reloadMusic(); this.onMusicChanged?.(); this.render(); });
        }, 'red sm') : null,
      ),
    );
  }

  private renderAnthems() {
    const list = this.songs.filter((s) => s.kind === 'anthem');
    this.body.append(
      h('p', { class: 'small', style: 'margin-top:0' }, 'Goal anthems play when a player scores. The bundled Echo Fanfare anthems are always available; anything uploaded here shows up in every player\'s Garage → Anthem list. Keep them short (8–15 s).'),
      this.uploader('anthem'),
      list.length ? h('div', { class: 'scroll', style: 'margin-top:10px' }, h('table', { class: 'table' }, ...list.map((s) => this.songRow(s)))) : h('div', { class: 'empty-state' }, 'No custom anthems yet.'),
    );
  }
}

function modeName(m: string) {
  return m === 'shuffle' ? 'Shuffle' : m === 'radio' ? 'Radio sync' : 'In order';
}
