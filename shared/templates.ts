import type { Settings } from './types.js';
export interface SavedTemplate {
  id: string;
  name: string;
  settings: Settings;
}
export interface TemplateLibrary {
  version: 2;
  presetVersion?: number;
  activeId: string;
  templates: SavedTemplate[];
}
