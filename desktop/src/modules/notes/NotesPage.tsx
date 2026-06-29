/** Notes — personal notes manager. */
import { StickyNote } from "lucide-react";
import { NotesView } from "./NotesView";

export function NotesPage() {
  return (
    <div className="max-w-3xl mx-auto py-6 px-4 h-full flex flex-col animate-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="size-10 rounded-md bg-bg-elevated border border-border grid place-items-center">
          <StickyNote className="size-5 text-accent" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Notes</h1>
          <p className="text-sm text-fg-muted mt-0.5">Your personal notes. Notes taken from a terminal are tagged with the host.</p>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <NotesView />
      </div>
    </div>
  );
}
