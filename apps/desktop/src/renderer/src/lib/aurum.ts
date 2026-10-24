import type { AurumApi } from '../../../shared';

declare global {
  interface Window {
    aurum?: AurumApi;
  }
}

/** The preload bridge. It is absent when the page is opened outside Electron, and we say so rather than fake data. */
export const getApi = (): AurumApi | undefined => window.aurum;
