import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CircleAlert, CircleCheck, MapPin, type LucideIcon } from "lucide-react";
import { DataSet } from "vis-data/peer";
import { Timeline } from "vis-timeline/peer";
import "vis-timeline/styles/vis-timeline-graph2d.min.css";

import { Card, CardContent } from "@/components/ui/card";

interface TimelineMark {
  label: string;
  time: number;
}

interface SpanSegment {
  label: string;
  fromLabel: string;
  toLabel: string;
  start: number;
  end: number;
  duration: number;
  index: number;
}

interface ParentSpanSegment {
  id: string;
  parent: string;
  start: number;
  end: number;
  duration: number;
  childSpanIndexes: number[];
  blockIndex: number;
}

interface InteractiveTimelineProps {
  startTime: string;
  marks: TimelineMark[];
  segments: SpanSegment[];
  parentSegments: ParentSpanSegment[];
  totalTime: number;
  activeSegmentIndex: number | null;
  activeParentName: string | null;
  onSegmentHover?: (segmentIndex: number | null) => void;
  onParentHover?: (parentName: string | null) => void;
}

interface TooltipContent {
  kind: "mark" | "segment";
  title: string;
  subtitle: string;
  fromLabel?: string;
  toLabel?: string;
  severity?: "low" | "medium" | "high";
}

interface TooltipState extends TooltipContent {
  x: number;
  y: number;
}

const HOVER_DELAY_MS = 40;
const TOOLTIP_WIDTH_PX = 420;
const TOOLTIP_HEIGHT_PX = 180;
const WINDOW_PADDING_PERCENT = 0.1;

function formatSeconds(seconds: number): string {
  if (seconds < 1) {
    return `${Math.round(seconds * 1000)} ms`;
  }

  return `${seconds.toFixed(3)} s`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseHierarchyLabel(label: string): { parent: string; child: string | null } {
  const separatorIndex = label.indexOf(":");
  if (separatorIndex < 0) {
    return { parent: label.trim(), child: null };
  }

  const parent = label.slice(0, separatorIndex).trim();
  const child = label.slice(separatorIndex + 1).trim();

  if (!parent || !child) {
    return { parent: label.trim(), child: null };
  }

  return { parent, child };
}

function getSpanSeverity(percentOfTotal: number): "low" | "medium" | "high" {
  if (percentOfTotal >= 30) {
    return "high";
  }
  if (percentOfTotal >= 12) {
    return "medium";
  }
  return "low";
}

function getSpanColor(percentOfTotal: number, maxPercent: number): { background: string; border: string } {
  const normalizedMax = Math.max(maxPercent, 0.01);
  const ratio = clamp(Math.log1p(percentOfTotal) / Math.log1p(normalizedMax), 0, 1);
  const hue = 120 - ratio * 120;
  const lightness = 74 - ratio * 22;

  return {
    background: `hsla(${hue}, 68%, ${Math.max(lightness, 36)}%, 0.34)`,
    border: `hsla(${hue}, 70%, ${Math.max(lightness - 18, 28)}%, 0.62)`
  };
}

function getSpanLabel(durationSeconds: number, percentOfTotal: number): string {
  if (percentOfTotal < 4) {
    return formatPercent(percentOfTotal);
  }

  return `${formatSeconds(durationSeconds)} | ${formatPercent(percentOfTotal)}`;
}

function getParentColor(parent: string): { background: string; border: string } {
  let hash = 0;
  for (let i = 0; i < parent.length; i += 1) {
    hash = (hash << 5) - hash + parent.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    background: `hsla(${hue}, 52%, 68%, 0.3)`,
    border: `hsla(${hue}, 52%, 48%, 0.55)`
  };
}

function getSeverityIcon(severity: "low" | "medium" | "high"): { icon: LucideIcon; className: string } {
  if (severity === "high") {
    return { icon: AlertTriangle, className: "text-red-600" };
  }
  if (severity === "medium") {
    return { icon: CircleAlert, className: "text-amber-600" };
  }
  return { icon: CircleCheck, className: "text-emerald-600" };
}

export function InteractiveTimeline({
  startTime,
  marks,
  segments,
  parentSegments,
  totalTime,
  activeSegmentIndex,
  activeParentName,
  onSegmentHover,
  onParentHover
}: InteractiveTimelineProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const timelineRef = useRef<Timeline | null>(null);
  const timelineItemsRef = useRef<DataSet<Record<string, unknown>> | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const startTimestamp = useMemo(() => {
    const parsed = new Date(startTime);
    return Number.isNaN(parsed.valueOf()) ? Date.now() : parsed.getTime();
  }, [startTime]);

  const tooltipContent = useMemo(() => {
    const map = new Map<string, TooltipContent>();

    for (const parentSpan of parentSegments) {
      map.set(`parent-${parentSpan.id}`, {
        kind: "segment",
        title: `Parent: ${parentSpan.parent}`,
        subtitle: `${formatSeconds(parentSpan.start)} to ${formatSeconds(parentSpan.end)} | ${formatSeconds(parentSpan.duration)}`
      });
    }

    for (const segment of segments) {
      const percentOfTotal = totalTime > 0 ? (segment.duration / totalTime) * 100 : 0;
      const severity = getSpanSeverity(percentOfTotal);
      const fromHierarchy = parseHierarchyLabel(segment.fromLabel);
      const toHierarchy = parseHierarchyLabel(segment.toLabel);
      const fromLeafLabel = fromHierarchy.child ?? fromHierarchy.parent;
      const toLeafLabel = toHierarchy.child ?? toHierarchy.parent;

      map.set(`segment-${segment.index}`, {
        kind: "segment",
        title: `${fromLeafLabel} ${toLeafLabel}`,
        subtitle: `${formatSeconds(segment.start)} to ${formatSeconds(segment.end)} | ${formatSeconds(segment.duration)} (${formatPercent(percentOfTotal)})`,
        fromLabel: fromLeafLabel,
        toLabel: toLeafLabel,
        severity
      });
    }

    for (const [index, mark] of marks.entries()) {
      map.set(`mark-${index}`, {
        kind: "mark",
        title: mark.label,
        subtitle: `At ${formatSeconds(mark.time)}`
      });
    }

    return map;
  }, [marks, parentSegments, segments, totalTime]);

  const windowBounds = useMemo(() => {
    const minMarkSec = marks.length > 0 ? Math.min(...marks.map((mark) => mark.time)) : 0;
    const maxMarkSec = marks.length > 0 ? Math.max(...marks.map((mark) => mark.time)) : totalTime;
    const minSegmentSec = segments.length > 0 ? Math.min(...segments.map((segment) => segment.start)) : minMarkSec;
    const maxSegmentSec = segments.length > 0 ? Math.max(...segments.map((segment) => segment.end)) : maxMarkSec;

    const minSec = Math.min(minMarkSec, minSegmentSec);
    const maxSec = Math.max(maxMarkSec, maxSegmentSec);
    const minMs = minSec * 1000;
    const maxMs = maxSec * 1000;
    const rangeMs = Math.max(maxMs - minMs, 300);
    const paddingMs = Math.max(rangeMs * WINDOW_PADDING_PERCENT, 120);

    return {
      start: startTimestamp + minMs - paddingMs,
      end: startTimestamp + maxMs + paddingMs,
      rangeMs
    };
  }, [marks, segments, startTimestamp, totalTime]);

  const maxSegmentPercent = useMemo(() => {
    if (segments.length === 0 || totalTime <= 0) {
      return 0;
    }

    return segments.reduce((maxPercent, segment) => {
      const percent = (segment.duration / totalTime) * 100;
      return percent > maxPercent ? percent : maxPercent;
    }, 0);
  }, [segments, totalTime]);

  const segmentBaseClassMap = useMemo(() => {
    const classMap = new Map<number, string>();

    for (const segment of segments) {
      const percentOfTotal = totalTime > 0 ? (segment.duration / totalTime) * 100 : 0;
      classMap.set(segment.index, `segment-item segment-${getSpanSeverity(percentOfTotal)}`);
    }

    return classMap;
  }, [segments, totalTime]);

  const parentBaseClassMap = useMemo(() => {
    const classMap = new Map<string, string>();
    for (const segment of parentSegments) {
      classMap.set(segment.id, "parent-segment-item");
    }
    return classMap;
  }, [parentSegments]);

  function getTooltipPosition(event: Event): { x: number; y: number } | null {
    if (!(event instanceof MouseEvent)) {
      return null;
    }

    const shell = shellRef.current;
    if (!shell) {
      return null;
    }

    const rect = shell.getBoundingClientRect();
    const rawX = event.clientX - rect.left + 12;
    const rawY = event.clientY - rect.top + 12;

    const x = clamp(rawX, 8, Math.max(8, rect.width - TOOLTIP_WIDTH_PX - 8));
    const y = clamp(rawY, 8, Math.max(8, rect.height - TOOLTIP_HEIGHT_PX - 8));

    return { x, y };
  }

  function clearHoverTimer() {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const groups = new DataSet([
      { id: "parents", content: "Parent Spans", order: 1 },
      { id: "segments", content: "Child Spans", order: 2 },
      { id: "marks", content: "Marks", order: 3 }
    ]);

    const items = new DataSet([
      ...parentSegments.map((parentSpan) => {
        const parentStartMs = startTimestamp + Math.max(parentSpan.start * 1000, 0);
        const parentEndMs = Math.max(startTimestamp + parentSpan.end * 1000, parentStartMs + 1);
        const parentColor = getParentColor(parentSpan.parent);
        const parentContent = `
          <div class="parent-span-card">
            <div class="parent-span-title">${escapeHtml(parentSpan.parent)}</div>
            <div class="parent-span-meta">${escapeHtml(formatSeconds(parentSpan.duration))}</div>
          </div>
        `;

        return {
          id: `parent-${parentSpan.id}`,
          group: "parents",
          content: parentContent,
          start: new Date(parentStartMs),
          end: new Date(parentEndMs),
          type: "range" as const,
          className: `${parentBaseClassMap.get(parentSpan.id) ?? "parent-segment-item"}${
            activeParentName === parentSpan.parent ? " parent-segment-active" : ""
          }`,
          style: `background:${parentColor.background};border-color:${parentColor.border};`
        };
      }),
      ...segments.map((segment) => {
        const segmentStartMs = startTimestamp + Math.max(segment.start * 1000, 0);
        const segmentEndMs = Math.max(startTimestamp + segment.end * 1000, segmentStartMs + 1);
        const percentOfTotal = totalTime > 0 ? (segment.duration / totalTime) * 100 : 0;
        const spanColor = getSpanColor(percentOfTotal, maxSegmentPercent);
        const taskHierarchy = parseHierarchyLabel(segment.toLabel);
        const metaLabel = getSpanLabel(segment.duration, percentOfTotal);
        const taskChild = taskHierarchy.child;
        const spanContent = `
          <div class="span-card">
            ${taskChild ? `<div class="span-child">${escapeHtml(taskChild)}</div>` : ""}
            <div class="span-meta">${escapeHtml(metaLabel)}</div>
          </div>
        `;

        return {
          id: `segment-${segment.index}`,
          group: "segments",
          content: spanContent,
          start: new Date(segmentStartMs),
          end: new Date(segmentEndMs),
          type: "range" as const,
          className: `${segmentBaseClassMap.get(segment.index) ?? "segment-item"}${
            activeSegmentIndex === segment.index ? " segment-active" : ""
          }`,
          style: `background:${spanColor.background};border-color:${spanColor.border};`
        };
      }),
      ...marks.map((mark, index) => ({
        id: `mark-${index}`,
        group: "marks",
        content: "",
        start: new Date(startTimestamp + Math.max(mark.time * 1000, 0)),
        type: "point" as const,
        className: "mark-item"
      }))
    ]);

    const timeline = new Timeline(container, items, groups, {
      stack: false,
      zoomable: true,
      moveable: true,
      horizontalScroll: true,
      verticalScroll: true,
      showCurrentTime: false,
      selectable: true,
      showTooltips: false,
      groupOrder: "order",
      zoomMin: 1,
      zoomMax: Math.max(windowBounds.rangeMs * 12, 8000),
      orientation: {
        axis: "top",
        item: "bottom"
      },
      margin: {
        item: {
          horizontal: 6,
          vertical: 14
        },
        axis: 8
      },
      minHeight: 320,
      maxHeight: 420
    } as never);
    timelineRef.current = timeline;
    timelineItemsRef.current = items;

    timeline.setWindow(new Date(windowBounds.start), new Date(windowBounds.end), { animation: false });

    timeline.on("itemover", (props: { item: string | number; event: Event }) => {
      const id = String(props.item);
      const content = tooltipContent.get(id);
      const position = getTooltipPosition(props.event);
      if (id.startsWith("segment-")) {
        const segmentId = Number(id.slice("segment-".length));
        if (!Number.isNaN(segmentId)) {
          onSegmentHover?.(segmentId);
        }
        onParentHover?.(null);
      } else if (id.startsWith("parent-")) {
        const parentId = id.slice("parent-".length);
        const parent = parentSegments.find((segment) => segment.id === parentId)?.parent ?? null;
        onParentHover?.(parent);
        onSegmentHover?.(null);
      } else {
        onSegmentHover?.(null);
        onParentHover?.(null);
      }

      if (!content || !position) {
        return;
      }

      clearHoverTimer();
      hoverTimerRef.current = window.setTimeout(() => {
        setTooltip({ ...content, ...position });
      }, HOVER_DELAY_MS);
    });

    timeline.on("itemout", () => {
      clearHoverTimer();
      setTooltip(null);
      onSegmentHover?.(null);
      onParentHover?.(null);
    });

    timeline.on("mouseMove", (props: { event: Event }) => {
      const position = getTooltipPosition(props.event);
      if (!position) {
        return;
      }

      setTooltip((current) => (current ? { ...current, ...position } : current));
    });

    timeline.on("rangechanged", () => {
      setTooltip(null);
    });

    return () => {
      clearHoverTimer();
      onSegmentHover?.(null);
      onParentHover?.(null);
      timelineRef.current = null;
      timelineItemsRef.current = null;
      timeline.destroy();
    };
  }, [
    activeParentName,
    marks,
    maxSegmentPercent,
    onParentHover,
    onSegmentHover,
    parentBaseClassMap,
    parentSegments,
    segmentBaseClassMap,
    segments,
    startTimestamp,
    tooltipContent,
    totalTime,
    windowBounds.end,
    windowBounds.rangeMs,
    windowBounds.start
  ]);

  useEffect(() => {
    const items = timelineItemsRef.current;
    if (!items) {
      return;
    }

    items.update(
      [
        ...parentSegments.map((segment) => ({
          id: `parent-${segment.id}`,
          className: `${parentBaseClassMap.get(segment.id) ?? "parent-segment-item"}${
            activeParentName === segment.parent ? " parent-segment-active" : ""
          }`
        })),
        ...segments.map((segment) => ({
          id: `segment-${segment.index}`,
          className: `${segmentBaseClassMap.get(segment.index) ?? "segment-item"}${
            activeSegmentIndex === segment.index ? " segment-active" : ""
          }`
        }))
      ] as never
    );
  }, [activeParentName, activeSegmentIndex, parentBaseClassMap, parentSegments, segmentBaseClassMap, segments]);

  const tooltipIconMeta = useMemo(() => {
    if (!tooltip) {
      return null;
    }
    if (tooltip.kind === "mark") {
      return { Icon: MapPin, className: "text-sky-700" };
    }

    const { icon: Icon, className } = getSeverityIcon(tooltip.severity ?? "low");
    return { Icon, className };
  }, [tooltip]);

  return (
    <div
      ref={shellRef}
      className="timeline-shell timeline-shell-enter relative rounded-2xl border border-white/45 bg-white/35 p-3 shadow-[0_20px_50px_-34px_rgba(15,23,42,0.5)] backdrop-blur-xl"
    >
      <div ref={containerRef} className="overflow-hidden rounded-lg" />

      {tooltip && tooltipIconMeta ? (
        <Card
          className="tooltip-pop pointer-events-none absolute z-20 w-[420px] rounded-[1.4rem] border border-white/90 bg-[linear-gradient(145deg,rgba(255,255,255,0.9)_0%,rgba(255,255,255,0.66)_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.92),inset_0_-1px_0_rgba(226,232,240,0.48),0_16px_34px_-22px_rgba(15,23,42,0.38)] backdrop-blur-[22px]"
          style={{ left: `${tooltip.x}px`, top: `${tooltip.y}px` }}
        >
          <CardContent className="space-y-1 p-3">
            <div className="flex items-center gap-2">
              <tooltipIconMeta.Icon className={`h-4 w-4 ${tooltipIconMeta.className}`} />
              {tooltip.fromLabel && tooltip.toLabel ? (
                <p className="flex min-w-0 flex-1 items-start gap-1.5 text-[0.98rem] font-semibold text-slate-900">
                  <span className="break-words">{tooltip.fromLabel}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 self-center text-slate-500" />
                  <span className="break-words">{tooltip.toLabel}</span>
                </p>
              ) : (
                <p className="break-words text-[0.98rem] font-semibold text-slate-900">{tooltip.title}</p>
              )}
            </div>
            <p className="text-sm text-slate-600">{tooltip.subtitle}</p>
          </CardContent>
        </Card>
      ) : null}

      <p className="mt-2 text-sm text-slate-500">Drag horizontally to pan. Use mouse wheel to zoom in and out.</p>
    </div>
  );
}
