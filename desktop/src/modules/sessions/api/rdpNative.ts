/**
 * Native RDP launch (desktop app only).
 *
 * Hands a generated `.rdp` file to the OS's own Remote Desktop client via the
 * Tauri `rdp_launch` command. In the browser build this is unavailable.
 */
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/shared/lib/tauri";

export interface RdpLaunchInput {
  host: string;
  port: number;
  username?: string | null;
  domain?: string | null;
  name?: string | null;
}

export const rdpNativeAvailable = isTauri;

/** Launch the OS-native RDP client for the given host. Returns the .rdp path. */
export function launchNativeRdp(input: RdpLaunchInput): Promise<string> {
  if (!isTauri) {
    return Promise.reject(new Error("The native RDP client is only available in the Awamer desktop app."));
  }
  return invoke<string>("rdp_launch", {
    args: {
      host: input.host,
      port: input.port,
      username: input.username ?? null,
      domain: input.domain ?? null,
      name: input.name ?? null,
    },
  });
}
