export {};
declare global {
  interface Window {
    callsideDesktop?: {
      platform: string;
      getTestDiagnostics?: () => Promise<Record<string, unknown>>;
      loadTestState?: () => Promise<Record<string, unknown> | null>;
      saveTestState?: (state: Record<string, unknown>) => Promise<void>;
      relaunchTest?: () => Promise<void>;
      saveTestReport?: (report: Record<string, unknown>) => Promise<{ saved: boolean }>;
      updates: (action: 'status' | 'check' | 'install') => Promise<{
        phase: string;
        version: string;
        message: string;
        percent?: number;
        nextVersion?: string;
      }>;
      setSessionActive: (active: boolean) => Promise<void>;
      onAnswer: (callback: () => void) => () => void;
      setAlwaysOnTop: (enabled: boolean) => Promise<void>;
      getShortcutStatus: () => Promise<{ accelerator: string; registered: boolean }[]>;
      loadTemplate: () => Promise<import('../shared/types').Settings | null>;
      saveTemplate: (settings: import('../shared/types').Settings) => Promise<void>;
      removeTemplate: () => Promise<void>;
    };
  }
}
