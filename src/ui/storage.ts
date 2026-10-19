// Persistent user settings (localStorage, guarded).
export interface Settings {
  theme: 'dark' | 'light' | 'system';
  boardTheme: 'walnut' | 'slate' | 'forest' | 'ivory' | 'ocean' | 'rose';
  sound: boolean;
  showLegal: boolean;
  showCoords: boolean;
  animate: boolean;
  multiPv: number;
  hashMb: number;
  showBestArrow: boolean;
  autoAnalysis: boolean;
  highlightLast: boolean;
  evalBar: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  boardTheme: 'walnut',
  sound: true,
  showLegal: true,
  showCoords: true,
  animate: true,
  multiPv: 3,
  hashMb: 32,
  showBestArrow: true,
  autoAnalysis: true,
  highlightLast: true,
  evalBar: true,
};

const KEY = 'ply.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

export function saveJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
