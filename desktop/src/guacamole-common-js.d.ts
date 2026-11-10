/**
 * Minimal ambient types for the subset of guacamole-common-js (1.5.x) the RDP
 * page uses. The library ships no type declarations; this mirrors novnc.d.ts.
 */
declare module "guacamole-common-js" {
  export interface GuacStatus { code?: number; message?: string }

  export class WebSocketTunnel {
    constructor(tunnelURL: string);
    onerror: ((status: GuacStatus) => void) | null;
    onstatechange: ((state: number) => void) | null;
  }

  export class Display {
    getElement(): HTMLElement;
    getWidth(): number;
    getHeight(): number;
    scale(scale: number): void;
    getScale(): number;
    onresize: ((width: number, height: number) => void) | null;
  }

  export interface MouseState {
    x: number;
    y: number;
  }

  export class Mouse {
    constructor(element: Element);
    /** Event-target style: listener receives an event carrying `.state`. */
    on(type: "mousedown" | "mouseup" | "mousemove" | "mouseout", listener: (e: { state: MouseState }) => void): void;
  }

  export class Keyboard {
    constructor(element: Element | Document);
    onkeydown: ((keysym: number) => void) | null;
    onkeyup: ((keysym: number) => void) | null;
    reset(): void;
  }

  export class Client {
    constructor(tunnel: WebSocketTunnel);
    getDisplay(): Display;
    connect(data: string): void;
    disconnect(): void;
    sendMouseState(state: MouseState, applyDisplayScale?: boolean): void;
    sendKeyEvent(pressed: number, keysym: number): void;
    onstatechange: ((state: number) => void) | null;
    onerror: ((status: GuacStatus) => void) | null;
    onname: ((name: string) => void) | null;
    static State: {
      IDLE: 0; CONNECTING: 1; WAITING: 2; CONNECTED: 3; DISCONNECTING: 4; DISCONNECTED: 5;
    };
  }
}
