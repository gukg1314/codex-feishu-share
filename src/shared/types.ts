export type LarkShareRecipient = {
  kind: "user" | "chat";
  id: string;
  name: string;
  detail?: string;
  avatarUrl?: string;
};

export type LarkContactOption = {
  openId: string;
  name: string;
  department?: string;
};

export type ShareMessage = { id: string; text: string };

export type AppState = {
  version: string;
  appId: string;
  configured: boolean;
  auth: {
    status: string;
    userName?: string;
    url?: string;
    error?: string;
    missingScopes?: string[];
  };
  hook: { installed: boolean; codexHome: string; capturedAt?: string };
  listener: { status: string; error?: string };
  desktop: { hideDock: boolean; openAtLogin: boolean; loginStatus: string; loginAvailable: boolean };
};

export type ElectronApi = {
  searchLarkContacts(query: string): Promise<LarkContactOption[]>;
  searchLarkShareChats(query: string): Promise<LarkShareRecipient[]>;
  sendLarkShareMessage(input: { recipient: LarkShareRecipient; text: string }): Promise<{ messageId: string }>;
  getSettings(): Promise<AppState>;
  saveConfig(input: { appId: string; appSecret: string }): Promise<AppState>;
  login(): Promise<AppState>;
  logout(): Promise<AppState>;
  installHook(input: { codexHome: string }): Promise<AppState>;
  setHideDock(value: boolean): Promise<AppState>;
  setOpenAtLogin(value: boolean): Promise<AppState>;
  openLoginSettings(): void;
  openSettings(): void;
  closeShare(): void;
  reportRendered(input: { shareId: string }): void;
  resizeShare(input: { height: number }): void;
  onShare(callback: (share: ShareMessage | null) => void): () => void;
  onState(callback: (state: AppState) => void): () => void;
};

declare global {
  interface Window { electron: ElectronApi }
}
