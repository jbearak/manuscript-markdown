// Mock vscode module for testing
export const window = {
  createStatusBarItem: () => ({
    text: '',
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
};

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
};

export interface TextDocument {
  languageId: string;
}

export interface StatusBarItem {
  text: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface Disposable {
  dispose(): void;
}
