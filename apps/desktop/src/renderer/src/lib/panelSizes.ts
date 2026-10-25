import { useCallback, useEffect, useState } from 'react';

/** Panel sizes are a per-viewer convenience: kept in localStorage when it works, defaults otherwise. */
export const SIZE_LIMITS = {
  chatW: { min: 300, max: 900, def: 400 },
  bottomH: { min: 96, max: 720, def: 190 },
} as const;

const KEY = 'aurum.panels.v1';
interface Saved { chatW: number; bottomH: number; rightHidden: boolean }
const DEFAULTS: Saved = { chatW: SIZE_LIMITS.chatW.def, bottomH: SIZE_LIMITS.bottomH.def, rightHidden: false };

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));

function read(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Saved>;
    return {
      chatW: clamp(Number(raw.chatW ?? DEFAULTS.chatW), SIZE_LIMITS.chatW.min, SIZE_LIMITS.chatW.max),
      bottomH: clamp(Number(raw.bottomH ?? DEFAULTS.bottomH), SIZE_LIMITS.bottomH.min, SIZE_LIMITS.bottomH.max),
      rightHidden: raw.rightHidden === true,
    };
  } catch { return DEFAULTS; }
}

export function usePanelSizes() {
  const [s, setS] = useState<Saved>(read);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window or blocked storage: sizes just are not remembered */ } }, [s]);
  const setChatW = useCallback((w: number) => setS((p) => ({ ...p, chatW: clamp(w, SIZE_LIMITS.chatW.min, SIZE_LIMITS.chatW.max) })), []);
  const setBottomH = useCallback((h: number) => setS((p) => ({ ...p, bottomH: clamp(h, SIZE_LIMITS.bottomH.min, SIZE_LIMITS.bottomH.max) })), []);
  const setRightHidden = useCallback((hidden: boolean) => setS((p) => ({ ...p, rightHidden: hidden })), []);
  return { ...s, setChatW, setBottomH, setRightHidden };
}
