import { DEFAULT_CAMERA, type CameraSettings } from '../render/view';
import type { Volumes } from '../audio/audio';
import { DEFAULT_LOADOUT, type Loadout } from './types';
import { sanitizeLoadout } from '../net/host';

export interface Settings {
  quality: number; // 0 low, 1 medium, 2 high
  showFps: boolean;
  ballCam: boolean;
  camera: CameraSettings;
  volumes: Volumes;
  nameplates: boolean;
}

const KEY = 'bl.settings';
const LOADOUT_KEY = 'bl.loadout';

function defaultQuality() {
  const mobile = /Android|iPhone|iPad/.test(navigator.userAgent);
  return mobile ? 0 : (navigator.hardwareConcurrency ?? 4) >= 8 ? 2 : 1;
}

export function loadSettings(): Settings {
  const base: Settings = {
    quality: defaultQuality(),
    showFps: false,
    ballCam: true,
    camera: { ...DEFAULT_CAMERA },
    volumes: { master: 0.8, music: 0.55, sfx: 0.8, anthem: 0.9 },
    nameplates: true,
  };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      return { ...base, ...raw, camera: { ...base.camera, ...(raw.camera ?? {}) }, volumes: { ...base.volumes, ...(raw.volumes ?? {}) } };
    }
  } catch {
    /* ignore */
  }
  return base;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function loadLoadout(): Loadout {
  try {
    const raw = JSON.parse(localStorage.getItem(LOADOUT_KEY) ?? 'null');
    if (raw) return sanitizeLoadout(raw);
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_LOADOUT };
}

export function saveLoadoutLocal(l: Loadout) {
  try {
    localStorage.setItem(LOADOUT_KEY, JSON.stringify(l));
  } catch {
    /* ignore */
  }
}
