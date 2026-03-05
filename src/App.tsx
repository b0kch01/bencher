import { useMemo, useState } from "react";
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, Link2, Maximize2, Minimize2 } from "lucide-react";

import { InteractiveTimeline } from "@/components/interactive-timeline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

interface TimelineMark {
  label: string;
  time: number;
}

interface TimelinePayload {
  startTime: string;
  marks: TimelineMark[];
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

interface LabelHierarchy {
  parent: string;
  child: string | null;
}

const MIN_SPAN_DURATION_SECONDS = 0.001;
const MERGE_EPSILON_SECONDS = 0.000_001;
const QUERY_PARAM_KEY = "bench";

const defaultJson = `{
  "startTime": "3/4/2026, 10:18:18 PM",
  "marks": [
    { "label": "feed: init", "time": 0 },
    { "label": "Parse auth claims", "time": 0 },
    { "label": "feed: init prisma client", "time": 0.406 },
    { "label": "feed: find unique user", "time": 0.904 },
    { "label": "listv2: parse auth claims", "time": 0.905 },
    { "label": "listv2: validate json", "time": 0.985 },
    { "label": "listv2: get unique user", "time": 0.994 },
    { "label": "listv2: db call to get posts", "time": 1.07 },
    { "label": "listv2: finish listv2", "time": 1.072 },
    { "label": "feed: parse posts", "time": 1.072 },
    { "label": "feed: should Fetch Causes", "time": 1.076 },
    { "label": "feed: supported by user db call", "time": 1.08 },
    { "label": "feed: get causes", "time": 1.357 },
    { "label": "feed: arrange causes", "time": 1.357 },
    { "label": "feed: finish", "time": 1.357 }
  ]
}`;

function parsePayload(text: string): TimelinePayload {
  const value = JSON.parse(text) as Record<string, unknown>;

  if (typeof value !== "object" || value === null) {
    throw new Error("Input must be a JSON object.");
  }

  if (typeof value.startTime !== "string") {
    throw new Error("`startTime` must be a string.");
  }

  if (!Array.isArray(value.marks)) {
    throw new Error("`marks` must be an array.");
  }

  const marks = value.marks.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`marks[${index}] must be an object.`);
    }

    const label = (entry as Record<string, unknown>).label;
    const time = (entry as Record<string, unknown>).time;

    if (typeof label !== "string" || label.trim().length === 0) {
      throw new Error(`marks[${index}].label must be a non-empty string.`);
    }

    if (typeof time !== "number" || Number.isNaN(time)) {
      throw new Error(`marks[${index}].time must be a valid number.`);
    }

    return {
      label,
      time,
      _index: index
    };
  });

  marks.sort((a, b) => a.time - b.time || a._index - b._index);

  return {
    startTime: value.startTime,
    marks: marks.map(({ label, time }) => ({ label, time }))
  };
}

function formatSeconds(seconds: number): string {
  if (seconds < 1) {
    return `${Math.round(seconds * 1000)} ms`;
  }

  return `${seconds.toFixed(3)} s`;
}

function parseHierarchyLabel(label: string): LabelHierarchy {
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

function buildParentSpanSegments(segments: SpanSegment[]): ParentSpanSegment[] {
  const byParent = new Map<string, SpanSegment[]>();

  for (const segment of segments) {
    const parent = parseHierarchyLabel(segment.toLabel).parent;
    const existing = byParent.get(parent);
    if (existing) {
      existing.push(segment);
    } else {
      byParent.set(parent, [segment]);
    }
  }

  const parentBlocks: ParentSpanSegment[] = [];

  for (const [parent, spans] of byParent.entries()) {
    const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
    let blockStart = ordered[0]?.start ?? 0;
    let blockEnd = ordered[0]?.end ?? 0;
    let childSpanIndexes = ordered[0] ? [ordered[0].index] : [];
    let blockIndex = 0;

    for (let i = 1; i < ordered.length; i += 1) {
      const span = ordered[i];
      if (span.start <= blockEnd + MERGE_EPSILON_SECONDS) {
        blockEnd = Math.max(blockEnd, span.end);
        childSpanIndexes.push(span.index);
      } else {
        parentBlocks.push({
          id: `${parent}-${blockIndex}`,
          parent,
          start: blockStart,
          end: blockEnd,
          duration: Math.max(blockEnd - blockStart, 0),
          childSpanIndexes,
          blockIndex
        });
        blockIndex += 1;
        blockStart = span.start;
        blockEnd = span.end;
        childSpanIndexes = [span.index];
      }
    }

    if (ordered.length > 0) {
      parentBlocks.push({
        id: `${parent}-${blockIndex}`,
        parent,
        start: blockStart,
        end: blockEnd,
        duration: Math.max(blockEnd - blockStart, 0),
        childSpanIndexes,
        blockIndex
      });
    }
  }

  parentBlocks.sort((a, b) => a.start - b.start || a.end - b.end || a.parent.localeCompare(b.parent));
  return parentBlocks;
}

function prettyPayloadJson(payload: TimelinePayload): string {
  return JSON.stringify({ startTime: payload.startTime, marks: payload.marks }, null, 2);
}

function getShareUrlForPayload(payload: TimelinePayload): string {
  if (typeof window === "undefined") {
    return "";
  }

  const minified = JSON.stringify(payload);
  const encoded = compressToEncodedURIComponent(minified);
  const url = new URL(window.location.href);
  url.searchParams.set(QUERY_PARAM_KEY, encoded);
  return url.toString();
}

function syncPayloadToQuery(payload: TimelinePayload): string {
  if (typeof window === "undefined") {
    return "";
  }

  const shareUrl = getShareUrlForPayload(payload);
  if (shareUrl) {
    window.history.replaceState({}, "", shareUrl);
  }
  return shareUrl;
}

interface InitialAppState {
  input: string;
  payload: TimelinePayload;
  error: string | null;
  isCompactView: boolean;
}

function getInitialAppState(defaultPayload: TimelinePayload): InitialAppState {
  if (typeof window === "undefined") {
    return {
      input: defaultJson,
      payload: defaultPayload,
      error: null,
      isCompactView: false
    };
  }

  const encoded = new URLSearchParams(window.location.search).get(QUERY_PARAM_KEY);

  if (!encoded) {
    return {
      input: defaultJson,
      payload: defaultPayload,
      error: null,
      isCompactView: false
    };
  }

  try {
    const decompressed = decompressFromEncodedURIComponent(encoded);
    if (!decompressed) {
      throw new Error("Could not decompress shared payload.");
    }

    const parsed = parsePayload(decompressed);
    return {
      input: prettyPayloadJson(parsed),
      payload: parsed,
      error: null,
      isCompactView: true
    };
  } catch {
    return {
      input: defaultJson,
      payload: defaultPayload,
      error: "Could not decode shared benchmark URL. Loaded sample payload instead.",
      isCompactView: false
    };
  }
}

export default function App() {
  const [initialAppState] = useState<InitialAppState>(() => {
    const defaultPayload = parsePayload(defaultJson);
    return getInitialAppState(defaultPayload);
  });
  const [input, setInput] = useState(initialAppState.input);
  const [error, setError] = useState<string | null>(initialAppState.error);
  const [payload, setPayload] = useState<TimelinePayload>(initialAppState.payload);
  const [isCompactView, setIsCompactView] = useState(initialAppState.isCompactView);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState<number | null>(null);
  const [activeParentName, setActiveParentName] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  const segments = useMemo<SpanSegment[]>(() => {
    const spans: SpanSegment[] = [];

    for (let i = 0; i < payload.marks.length - 1; i += 1) {
      const current = payload.marks[i];
      const next = payload.marks[i + 1];
      const duration = Math.max(next.time - current.time, 0);

      if (duration < MIN_SPAN_DURATION_SECONDS) {
        continue;
      }

      spans.push({
        label: `${current.label} -> ${next.label}`,
        fromLabel: current.label,
        toLabel: next.label,
        start: current.time,
        end: next.time,
        duration,
        index: i
      });
    }

    return spans;
  }, [payload]);

  const totalTime = payload.marks.length > 0 ? Math.max(payload.marks[payload.marks.length - 1].time, 0.001) : 0.001;

  const segmentParentByIndex = useMemo(() => {
    const indexToParent = new Map<number, string>();
    for (const segment of segments) {
      indexToParent.set(segment.index, parseHierarchyLabel(segment.toLabel).parent);
    }
    return indexToParent;
  }, [segments]);

  const parentSpanSegments = useMemo(() => buildParentSpanSegments(segments), [segments]);

  const parsedStart = Number.isNaN(new Date(payload.startTime).valueOf())
    ? payload.startTime
    : new Date(payload.startTime).toLocaleString();

  function handleRenderTimeline() {
    try {
      const next = parsePayload(input);
      setPayload(next);
      setError(null);
      setIsCompactView(true);
      setActiveSegmentIndex(null);
      setActiveParentName(null);
      syncPayloadToQuery(next);
      setShareCopied(false);
    } catch (parseError) {
      if (parseError instanceof Error) {
        setError(parseError.message);
      } else {
        setError("Failed to parse JSON input.");
      }
    }
  }

  function handleCopyShareLink() {
    if (typeof window === "undefined" || !navigator.clipboard) {
      return;
    }

    const shareUrl = getShareUrlForPayload(payload);
    if (!shareUrl) {
      return;
    }
    window.history.replaceState({}, "", shareUrl);

    navigator.clipboard
      .writeText(shareUrl)
      .then(() => {
        setShareCopied(true);
        window.setTimeout(() => setShareCopied(false), 1400);
      })
      .catch(() => {
        setShareCopied(false);
      });
  }

  function handleSegmentHover(segmentIndex: number | null) {
    setActiveSegmentIndex(segmentIndex);
    if (segmentIndex === null) {
      setActiveParentName(null);
      return;
    }

    const parent = segmentParentByIndex.get(segmentIndex) ?? null;
    setActiveParentName(parent);
  }

  function handleParentHover(parentName: string | null) {
    setActiveParentName(parentName);
    if (parentName === null) {
      setActiveSegmentIndex(null);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-10 md:px-8">
      <header className="anim-fade-up mb-8 space-y-3">
        <p className="glass-chip inline-flex items-center px-3 py-1 text-sm font-medium uppercase tracking-wide text-slate-700">
          Bench Timing Visualizer
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900 md:text-4xl">JSON to Timeline</h1>
        <p className="max-w-3xl text-base text-slate-600/95 md:text-[1.04rem]">
          Paste benchmark marks JSON and render each span as a timeline segment. Times are interpreted in seconds and converted to a
          visual trace.
        </p>
      </header>

      <div className={`grid gap-6 ${isCompactView ? "grid-cols-1" : "lg:grid-cols-[1.2fr_1fr]"}`}>
        <Card className="glass-panel anim-fade-up anim-delay-1 transition-all duration-300">
          <CardHeader className={isCompactView ? "pb-3" : undefined}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Input JSON</CardTitle>
                <CardDescription>
                  Provide an object with `startTime` and `marks[]` entries containing `label` and `time`.
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIsCompactView((current) => !current)}
                className="gap-1"
              >
                {isCompactView ? (
                  <>
                    <Maximize2 className="h-3.5 w-3.5" />
                    Expand
                  </>
                ) : (
                  <>
                    <Minimize2 className="h-3.5 w-3.5" />
                    Focus Timeline
                  </>
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {isCompactView ? (
              <div className="anim-fade-up glass-subpanel rounded-xl px-3 py-2 text-sm text-slate-600">
                Timeline-focused mode is enabled. Click <span className="font-medium text-slate-800">Expand</span> to edit JSON.
              </div>
            ) : (
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                className="anim-fade-up min-h-[420px] font-mono text-sm md:text-[0.98rem]"
                spellCheck={false}
              />
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleRenderTimeline}>Render Timeline</Button>
              <Button variant="outline" onClick={() => setInput(defaultJson)}>
                Reset Sample
              </Button>
              <Button variant="secondary" className="gap-1" onClick={handleCopyShareLink}>
                <Link2 className="h-3.5 w-3.5" />
                {shareCopied ? "Copied Link" : "Copy Share Link"}
              </Button>
              {isCompactView ? (
                <Button variant="secondary" onClick={() => setIsCompactView(false)}>
                  Edit JSON
                </Button>
              ) : null}
            </div>
            {error ? (
              <div className="flex items-center gap-2 rounded-xl border border-red-300/35 bg-red-100/50 px-3 py-2 text-sm text-red-700">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-300/35 bg-emerald-100/55 px-3 py-2 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                JSON parsed successfully.
              </div>
            )}
          </CardContent>
        </Card>

        {isCompactView ? null : (
          <Card className="glass-panel anim-fade-up anim-delay-2">
            <CardHeader>
              <CardTitle>Run Summary</CardTitle>
              <CardDescription>Derived from the currently rendered payload.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 text-[0.95rem]">
                <div className="glass-subpanel rounded-xl p-3">
                  <p className="text-[0.82rem] uppercase tracking-wide text-slate-500">Start Time</p>
                  <p className="mt-1 font-medium text-slate-900">{parsedStart}</p>
                </div>
                <div className="glass-subpanel rounded-xl p-3">
                  <p className="text-[0.82rem] uppercase tracking-wide text-slate-500">Marks</p>
                  <p className="mt-1 font-medium text-slate-900">{payload.marks.length}</p>
                </div>
                <div className="glass-subpanel rounded-xl p-3">
                  <p className="text-[0.82rem] uppercase tracking-wide text-slate-500">Total Duration</p>
                  <p className="mt-1 font-medium text-slate-900">{formatSeconds(totalTime)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="glass-panel anim-fade-up anim-delay-3 mt-6">
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <CardDescription>Drag to pan, wheel to zoom, hover items for exact details.</CardDescription>
          {isCompactView ? (
            <div className="flex flex-wrap gap-2 pt-1 text-sm">
              <span className="glass-chip compact-chip px-2 py-1 text-slate-700">{parsedStart}</span>
              <span className="glass-chip compact-chip px-2 py-1 text-slate-700">{payload.marks.length} marks</span>
              <span className="glass-chip compact-chip px-2 py-1 text-slate-700">{formatSeconds(totalTime)}</span>
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          <div className="space-y-5">
            <InteractiveTimeline
              startTime={payload.startTime}
              marks={payload.marks}
              segments={segments}
              parentSegments={parentSpanSegments}
              totalTime={totalTime}
              activeSegmentIndex={activeSegmentIndex}
              activeParentName={activeParentName}
              onSegmentHover={handleSegmentHover}
              onParentHover={handleParentHover}
            />

            <div className="space-y-4">
              {segments.length === 0 ? (
                <p className="text-sm text-slate-500">Add at least two marks to render spans.</p>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_9.5rem_4.5rem] gap-3 px-2 text-[0.78rem] font-semibold uppercase tracking-wide text-slate-500">
                    <span>Transition</span>
                    <span>Window</span>
                    <span>Duration</span>
                    <span>%</span>
                  </div>

                  {segments.map((segment, segmentOrder) => {
                    const toHierarchy = parseHierarchyLabel(segment.toLabel);
                    const fromHierarchy = parseHierarchyLabel(segment.fromLabel);
                    const rawStartPercent = totalTime > 0 ? (segment.start / totalTime) * 100 : 0;
                    const rawEndPercent = totalTime > 0 ? (segment.end / totalTime) * 100 : 0;
                    const startPercent = Math.max(Math.min(rawStartPercent, 100), 0);
                    const endPercent = Math.max(Math.min(rawEndPercent, 100), startPercent);
                    const widthPercent = Math.max(endPercent - startPercent, 0);

                    return (
                      <div
                        key={`row-${segment.label}-${segment.index}`}
                        className={`glass-row span-row-enter grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_9.5rem_4.5rem] items-center gap-3 rounded-xl p-3 text-[0.98rem] transition-transform duration-200 ${
                          activeSegmentIndex === segment.index ? "span-row-active" : ""
                        }`}
                        style={{ animationDelay: `${Math.min(segmentOrder * 24, 360)}ms` }}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold uppercase tracking-wide text-slate-500">{toHierarchy.parent}</p>
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-medium text-slate-800">{fromHierarchy.child ?? fromHierarchy.parent}</span>
                            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                            <span className="truncate font-medium text-slate-900">{toHierarchy.child ?? toHierarchy.parent}</span>
                          </div>
                        </div>

                        <div className="min-w-0 space-y-1">
                          <p className="text-sm text-slate-600">
                            {formatSeconds(segment.start)} to {formatSeconds(segment.end)}
                          </p>
                          <div className="relative h-2 rounded-full bg-slate-300/65">
                            <span
                              className="absolute top-0 h-2 rounded-full bg-sky-400/65"
                              style={{
                                left: `${startPercent}%`,
                                width: `${widthPercent}%`
                              }}
                            />
                          </div>
                        </div>

                        <div className="glass-chip inline-flex items-center gap-1 px-2.5 py-1 text-sm font-medium text-slate-700">
                          <Clock3 className="h-3.5 w-3.5" />
                          {formatSeconds(segment.duration)}
                        </div>
                        <div className="text-sm font-semibold tabular-nums text-slate-700">
                          {totalTime > 0 ? `${((segment.duration / totalTime) * 100).toFixed(1)}%` : "0.0%"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
