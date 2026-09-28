export {};
declare global {
  interface Window {
    callsideDesktop?: {
      platform: string;
      onAnswer: (callback: () => void) => () => void;
      setAlwaysOnTop: (enabled: boolean) => Promise<void>;
      getShortcutStatus: () => Promise<{ accelerator: string; registered: boolean }[]>;
    };
  }
}
