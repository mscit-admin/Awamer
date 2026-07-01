/**
 * Split layout for a terminal tab.
 *
 * Renders every pane of the tab's split tree as a full <WebTerminalPane> (so
 * each pane keeps its own History / Notes / Paste / Fullscreen toolbar) inside
 * an absolutely-positioned frame. Panes are rendered as a FLAT list keyed by
 * paneId, so splitting / resizing / maximizing never unmounts a pane — the SSH
 * sessions survive. Each pane has its own split / maximize / new-tab / close
 * controls, and draggable dividers resize neighbouring panes.
 */
import { useEffect, useMemo, useRef } from "react";

import { useTerminalTabs, type TerminalTab } from "../store/terminalTabsStore";
import { useSplit, collectPanes, type SplitNode, type Pane } from "../store/splitStore";
import { WebTerminalPane } from "./WebTerminalPane";

interface Rect { x: number; y: number; w: number; h: number } // percentages
interface DividerSpec { id: string; dir: "row" | "col"; bx: number; by: number; rect: Rect }

/** Walk the tree → each leaf's rect (%) + the divider bars. */
function computeLayout(node: SplitNode, rect: Rect, rects: Map<string, Rect>, dividers: DividerSpec[]) {
  if (node.type === "leaf") { rects.set(node.pane.paneId, rect); return; }
  if (node.dir === "row") {
    const wa = (rect.w * node.size) / 100;
    computeLayout(node.a, { x: rect.x, y: rect.y, w: wa, h: rect.h }, rects, dividers);
    computeLayout(node.b, { x: rect.x + wa, y: rect.y, w: rect.w - wa, h: rect.h }, rects, dividers);
    dividers.push({ id: node.id, dir: "row", bx: rect.x + wa, by: rect.y, rect });
  } else {
    const ha = (rect.h * node.size) / 100;
    computeLayout(node.a, { x: rect.x, y: rect.y, w: rect.w, h: ha }, rects, dividers);
    computeLayout(node.b, { x: rect.x, y: rect.y + ha, w: rect.w, h: rect.h - ha }, rects, dividers);
    dividers.push({ id: node.id, dir: "col", bx: rect.x, by: rect.y + ha, rect });
  }
}

export function SplitLayout({ tab }: { tab: TerminalTab }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const layout = useSplit((s) => s.layouts[tab.tabId]);
  const focused = useSplit((s) => s.focused[tab.tabId]);
  const maximized = useSplit((s) => s.maximized[tab.tabId]);
  const ensure = useSplit((s) => s.ensure);
  const split = useSplit((s) => s.split);
  const closePaneStore = useSplit((s) => s.closePane);
  const setSize = useSplit((s) => s.setSize);
  const setFocus = useSplit((s) => s.setFocus);
  const toggleMax = useSplit((s) => s.toggleMax);
  const openTab = useTerminalTabs((s) => s.openTab);
  const closeTab = useTerminalTabs((s) => s.closeTab);

  // Make sure the tab has a layout (single primary pane = the tab itself).
  useEffect(() => {
    ensure(tab.tabId, { paneId: tab.tabId, hostId: tab.hostId, label: tab.label });
  }, [ensure, tab.tabId, tab.hostId, tab.label]);

  const root: SplitNode = layout ?? { type: "leaf", pane: { paneId: tab.tabId, hostId: tab.hostId, label: tab.label } };
  const panes = useMemo(() => collectPanes(root), [root]);
  const { rects, dividers } = useMemo(() => {
    const r = new Map<string, Rect>();
    const d: DividerSpec[] = [];
    computeLayout(root, { x: 0, y: 0, w: 100, h: 100 }, r, d);
    return { rects: r, dividers: d };
  }, [root]);

  // Build the tab object each pane's WebTerminalPane receives. The primary pane
  // reuses the real tab (so the tab's status dot tracks it); extra panes get a
  // synthetic tab with their own id/host.
  const tabFor = (pane: Pane): TerminalTab =>
    pane.paneId === tab.tabId ? tab : { ...tab, tabId: pane.paneId, hostId: pane.hostId, label: pane.label };

  function onDividerDrag(e: React.MouseEvent, d: DividerSpec) {
    e.preventDefault();
    const rootEl = rootRef.current;
    if (!rootEl) return;
    const move = (ev: MouseEvent) => {
      const box = rootEl.getBoundingClientRect();
      if (d.dir === "row") {
        const startPx = box.left + (d.rect.x / 100) * box.width;
        const lenPx = (d.rect.w / 100) * box.width;
        setSize(tab.tabId, d.id, ((ev.clientX - startPx) / lenPx) * 100);
      } else {
        const startPx = box.top + (d.rect.y / 100) * box.height;
        const lenPx = (d.rect.h / 100) * box.height;
        setSize(tab.tabId, d.id, ((ev.clientY - startPx) / lenPx) * 100);
      }
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); document.body.style.userSelect = ""; window.dispatchEvent(new Event("resize")); };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function closePane(pane: Pane) {
    const stillOpen = closePaneStore(tab.tabId, pane.paneId);
    if (!stillOpen) closeTab(tab.tabId);
    setTimeout(() => window.dispatchEvent(new Event("resize")), 40);
  }

  const single = panes.length === 1;

  return (
    <div ref={rootRef} className="relative h-full w-full bg-[#0b0e14]">
      {panes.map((pane) => {
        const r = rects.get(pane.paneId) ?? { x: 0, y: 0, w: 100, h: 100 };
        const isMax = maximized === pane.paneId;
        const hidden = maximized != null && !isMax;
        const style: React.CSSProperties = isMax
          ? { position: "absolute", inset: 0, zIndex: 40 }
          : { position: "absolute", left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` };
        return (
          <div
            key={pane.paneId}
            style={{ ...style, display: hidden ? "none" : undefined }}
            onMouseDownCapture={() => setFocus(tab.tabId, pane.paneId)}
            className={"overflow-hidden " + (!single && !isMax ? "ring-1 " + (focused === pane.paneId ? "ring-accent/50" : "ring-white/10") : "")}
          >
            <WebTerminalPane
              tab={tabFor(pane)}
              paneActions={{
                isSplit: !single,
                isMaximized: isMax,
                onSplitH: () => split(tab.tabId, pane.paneId, "row"),
                onSplitV: () => split(tab.tabId, pane.paneId, "col"),
                onMaximize: () => { toggleMax(tab.tabId, pane.paneId); setTimeout(() => window.dispatchEvent(new Event("resize")), 40); },
                onNewTab: () => openTab(pane.hostId, pane.label),
                onClose: () => closePane(pane),
              }}
            />
          </div>
        );
      })}

      {/* Draggable dividers (hidden while a pane is maximized). */}
      {maximized == null && dividers.map((d) => (
        <div
          key={d.id}
          onMouseDown={(e) => onDividerDrag(e, d)}
          className={"absolute z-30 " + (d.dir === "row" ? "cursor-col-resize" : "cursor-row-resize")}
          style={d.dir === "row"
            ? { left: `${d.bx}%`, top: `${d.rect.y}%`, height: `${d.rect.h}%`, width: 8, transform: "translateX(-4px)" }
            : { top: `${d.by}%`, left: `${d.rect.x}%`, width: `${d.rect.w}%`, height: 8, transform: "translateY(-4px)" }}
        >
          <div className={"bg-white/10 hover:bg-accent/50 transition-colors " + (d.dir === "row" ? "h-full w-px mx-auto" : "w-full h-px my-auto")} />
        </div>
      ))}
    </div>
  );
}
