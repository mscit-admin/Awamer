declare module "@novnc/novnc" {
  interface RFBOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    repeaterID?: string;
    wsProtocols?: string[];
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendCredentials(creds: { username?: string; password?: string; target?: string }): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code: string, down?: boolean): void;
    focus(): void;
    blur(): void;
    machineShutdown(): void;
  }
}
