/** Slide-over notes panel for the terminal — scoped to the current host. */
import { X, StickyNote } from "lucide-react";
import { NotesView } from "./NotesView";

export function NotesPanel({ hostId, hostLabel, onClose }: { hostId: string; hostLabel: string; onClose: () => void }) {
  return (
    <div className="absolute inset-y-0 right-0 z-20 w-full max-w-md bg-bg border-l border-border shadow-2xl flex flex-col animate-fade-in">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><StickyNote className="size-4 text-accent" /> Notes</h2>
          <p className="text-2xs text-fg-muted truncate">{hostLabel}</p>
        </div>
        <button onClick={onClose} className="btn-ghost p-1.5" aria-label="Close"><X className="size-4" /></button>
      </div>
      <div className="flex-1 min-h-0 p-3">
        <NotesView hostId={hostId} hostLabel={hostLabel} compact />
      </div>
    </div>
  );
}
