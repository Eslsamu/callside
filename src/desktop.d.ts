export {};
declare global {
  interface Window {
    callsideDesktop?: {
      platform: string;
      onAnswer: (callback: () => void) => () => void;
      setAlwaysOnTop: (enabled: boolean) => Promise<void>;
      getShortcutStatus: () => Promise<{ accelerator: string; registered: boolean }[]>;
      loadTemplate: () => Promise<import('../shared/types').Settings | null>;
      saveTemplate: (settings: import('../shared/types').Settings) => Promise<void>;
      removeTemplate: () => Promise<void>;
    };
  }
}
