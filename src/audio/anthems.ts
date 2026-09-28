import bundled from './anthemList.json';
import { publicUrl } from '../net/api';

export interface Anthem {
  id: string;
  name: string;
  url: string;
  custom: boolean;
}

const base = import.meta.env.BASE_URL ?? './';

let list: Anthem[] = [
  { id: 'none', name: 'None', url: '', custom: false },
  ...(bundled as { id: string; name: string; file: string }[]).map((a) => ({ id: a.id, name: a.name, url: base + a.file, custom: false })),
];

/** Add anthems uploaded by the admin (from rl_public_content). */
export function setCustomAnthems(rows: { id: string; title: string; artist: string; path: string }[]) {
  list = list.filter((a) => !a.custom);
  for (const r of rows) list.push({ id: 'db:' + r.id, name: r.artist ? `${r.title} – ${r.artist}` : r.title, url: publicUrl(r.path), custom: true });
}

export function anthems(): Anthem[] {
  return list;
}

export function anthemById(id: string | undefined): Anthem | null {
  if (!id || id === 'none') return null;
  return list.find((a) => a.id === id) ?? null;
}
