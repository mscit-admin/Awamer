/**
 * App idle-lock state. After `idleTimeoutMin` minutes of no activity the app
 * locks (a full-screen overlay asking for the password) WITHOUT tearing down
 * the session — open terminals stay connected behind the lock. Unlock verifies
 * the current user's password.
 *
 * Persisted so the app stays locked across a reload. 0 = disabled.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface LockState {
  locked: boolean;
  idleTimeoutMin: number;
  lock: () => void;
  unlock: () => void;
  setIdleTimeout: (min: number) => void;
}

export const useLockStore = create<LockState>()(
  persist(
    (set) => ({
      locked: false,
      idleTimeoutMin: 0,
      lock: () => set({ locked: true }),
      unlock: () => set({ locked: false }),
      setIdleTimeout: (min) => set({ idleTimeoutMin: Math.max(0, Math.min(480, Math.round(min) || 0)) }),
    }),
    { name: "netsphere.lock", storage: createJSONStorage(() => localStorage) },
  ),
);
