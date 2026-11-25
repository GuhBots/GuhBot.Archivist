import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ArtifactPage,
  type EventPage,
  type GraphView as GraphData,
  mediaUrl,
  query,
} from "../api.js";
import { dayText, initials } from "../format.js";
import { FiltersModal } from "../modals/FiltersModal.js";
import { characterPath, navigate } from "../router.js";
import { useWindows } from "../Shell.js";
import { filterCount, filterQuery, loadLocal, saveLocal, useArchive } from "../state.js";
import { ErrorNote } from "../ui.js";
import { graphLayout, type Link, linkWeight } from "./graph-layout.js";
import { AddMenu } from "../components/AddMenu.js";
import { ViewFrame } from "./ViewFrame.js";

/**
 * Characters as nodes, with toggled layers for shared artifacts, shared
 * events, introductions, and overlapping server memberships. The layout is
 * the approved deterministic one, so the same data always draws the same
 * picture. Selecting a line opens an album of what the pair shares.
 */

type Layer = "artifacts" | "events" | "introductions" | "memberships";
type Layers = Record<Layer, boolean>;
type View = { k: number; x: number; y: number };

const WIDTH = 660;
const HEIGHT = 480;
const LAYERS: [Layer, string][] = [
  ["artifacts", "Artifacts"],
  ["events", "Events"],
  ["introductions", "Introductions"],
  ["memberships", "Memberships"],
];
const STYLES = {
  artifacts: { color: "#57c084", offset: -3, dash: undefined },
  events: { color: "#f23f43", offset: 0, dash: undefined },
  memberships: { color: "#f0b232", offset: 3, dash: "5 4" },
} as const;
const INTRO_COLOR = "#c9cdfb";
const FIT: View = { k: 1, x: 0, y: 0 };

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

interface Selected {
  a: string;
  b: string;
}

/** Records behind a line, shown when the pair shares no artifacts. */
interface Support {
  events: { id: string; title: string; day: string }[];
  introductions: { from: string; to: string; day: string | null }[];
  memberships: number;
}

export function GraphView() {
  const { archive, filters, revision } = useArchive();
  const windows = useWindows();
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [layers, setLayers] = useState<Layers>(() =>
    loadLocal("archivist:graph-layers", {
      artifacts: true,
      events: false,
      introductions: false,
      memberships: false,
    }),
  );
  const [minShared, setMinShared] = useState<number>(() =>
    loadLocal("archivist:graph-min-shared", 1),
  );
  const [focus, setFocus] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("focus") || null,
  );
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [support, setSupport] = useState<Support | null>(null);
  const [view, setView] = useState<View>(FIT);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; view: View; scale: number } | null>(null);
  const moved = useRef(false);
  const filterKey = JSON.stringify(filterQuery(filters));

  useEffect(() => {
    api<GraphData>(`/api/archives/${archive.archiveId}/graph${query(filterQuery(filters))}`)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch(setError);
  }, [archive.archiveId, filterKey, revision]);

  const nodes = useMemo(
    () => [...(data?.nodes ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    [data],
  );
  const names = useMemo(
    () => Object.fromEntries((data?.nodes ?? []).map((node) => [node.id, node.knownName])),
    [data],
  );

  // What the visible layers count for each pair. This sets the pull, the
  // circle sizes, and who counts as a neighbor.
  const { totals, edges } = useMemo(() => {
    const totals = new Map<string, number>();
    const edges: { layer: Exclude<Layer, "introductions">; a: string; b: string; count: number }[] =
      [];
    for (const layer of ["artifacts", "events", "memberships"] as const) {
      if (!layers[layer] || !data) continue;
      for (const pair of data[layer]) {
        if (layer === "artifacts" && pair.count < minShared) continue;
        edges.push({ layer, ...pair });
        const key = pairKey(pair.a, pair.b);
        totals.set(key, (totals.get(key) ?? 0) + pair.count);
      }
    }
    if (layers.introductions && data) {
      for (const intro of data.introductions) {
        const key = pairKey(intro.from, intro.to);
        totals.set(key, (totals.get(key) ?? 0) + 1);
      }
    }
    return { totals, edges };
  }, [data, layers, minShared]);

  const positions = useMemo(() => {
    const links: Link[] = [...totals].map(([key, count]) => {
      const [a, b] = key.split("|") as [string, string];
      return { a, b, weight: linkWeight(count) };
    });
    return graphLayout(
      nodes.map((node) => node.id),
      links,
      WIDTH,
      HEIGHT,
    );
  }, [nodes, totals]);

  const degree = useMemo(() => {
    const degree = new Map<string, number>();
    for (const [key, count] of totals) {
      for (const id of key.split("|")) degree.set(id, (degree.get(id) ?? 0) + count);
    }
    return degree;
  }, [totals]);
  const neighbors = (a: string, b: string) => totals.has(pairKey(a, b));
  const radius = (id: string) => 9 + Math.min(9, Math.sqrt(degree.get(id) ?? 0) * 1.6);

  // Wheels and pinches zoom around the pointer. React's wheel events are passive, so this listens directly.
  useEffect(() => {
    const root = svg.current;
    if (!root) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = root.getBoundingClientRect();
      const cx = ((event.clientX - rect.left) / rect.width) * WIDTH;
      const cy = ((event.clientY - rect.top) / rect.height) * HEIGHT;
      zoom(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), cx, cy);
    };
    root.addEventListener("wheel", wheel, { passive: false });
    return () => root.removeEventListener("wheel", wheel);
  }, [data]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = drag.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!moved.current && Math.hypot(dx, dy) > 4) {
        moved.current = true;
        document.body.classList.add("graph-panning");
        setHovered(null);
      }
      if (moved.current) {
        setView({
          ...start.view,
          x: start.view.x + dx * start.scale,
          y: start.view.y + dy * start.scale,
        });
      }
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.classList.remove("graph-panning");
      window.setTimeout(() => (moved.current = false), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("graph-panning");
    };
  }, []);

  function zoom(factor: number, cx = WIDTH / 2, cy = HEIGHT / 2) {
    setView((v) => {
      const k = Math.min(4, Math.max(0.4, v.k * factor));
      return { k, x: cx - (cx - v.x) * (k / v.k), y: cy - (cy - v.y) * (k / v.k) };
    });
  }

  const saveLayers = (next: Layers) => {
    setLayers(next);
    saveLocal("archivist:graph-layers", next);
    setSelected(null);
  };

  /** Opens the album of what two characters share, or the supporting records when they share none. */
  async function openPair(a: string, b: string) {
    setSelected(null);
    setSupport(null);
    try {
      const page = await api<ArtifactPage>(
        `/api/archives/${archive.archiveId}/artifacts${query({
          // The same filters as the line's count, plus both characters.
          ...filterQuery(filters),
          withCharacter: [a, b],
          sort: "oldest",
          limit: 100,
        })}`,
      );
      if (page.items.length) {
        const ids = page.items.map((item) => item.id);
        const title = `${names[a] ?? "?"} and ${names[b] ?? "?"}`;
        windows.openArtifact(ids[0]!, {
          ids,
          index: 0,
          title: page.total > ids.length ? `${title}, first ${ids.length} of ${page.total}` : title,
        });
        return;
      }
      const events = await api<EventPage>(
        `/api/archives/${archive.archiveId}/events${query({ character: a, limit: 100 })}`,
      );
      setSupport({
        events: events.items
          .filter((event) => event.links.characters?.includes(b))
          .map((event) => ({ id: event.id, title: event.title, day: event.start.archiveDay })),
        introductions: (data?.introductions ?? []).filter(
          (i) => (i.from === a && i.to === b) || (i.from === b && i.to === a),
        ),
        memberships: data?.memberships.find((m) => pairKey(m.a, m.b) === pairKey(a, b))?.count ?? 0,
      });
      setSelected({ a, b });
    } catch (failure) {
      setError(failure);
    }
  }

  const select = (open: () => void) => () => {
    if (!moved.current) open();
  };
  const keys = (open: () => void) => (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };
  const lit = (a: string, b: string) => hovered !== null && (a === hovered || b === hovered);
  const litNode = (id: string) => hovered !== null && (id === hovered || neighbors(id, hovered));

  const tray = (
    <>
      <AddMenu />
      <span className="sep" />
      <span className="label">Layers</span>
      {LAYERS.map(([layer, label]) => (
        <button
          key={layer}
          className="btn"
          type="button"
          aria-pressed={layers[layer]}
          onClick={() => saveLayers({ ...layers, [layer]: !layers[layer] })}
        >
          {label}
        </button>
      ))}
      <span className="sep" />
      <span className="label">At least</span>
      <div className="seg" role="group" aria-label="Fewest shared artifacts">
        {[1, 3, 5].map((n) => (
          <button
            key={n}
            className="btn"
            type="button"
            aria-pressed={minShared === n}
            onClick={() => {
              setMinShared(n);
              saveLocal("archivist:graph-min-shared", n);
            }}
          >
            {n} shared
          </button>
        ))}
      </div>
      <span className="sep" />
      <span className="label">Zoom</span>
      <button className="btn" type="button" title="Zoom out" onClick={() => zoom(1 / 1.3)}>
        −
      </button>
      <button className="btn" type="button" title="Zoom in" onClick={() => zoom(1.3)}>
        +
      </button>
      <button
        className="btn"
        type="button"
        title="Show the whole graph"
        onClick={() => setView(FIT)}
      >
        Fit
      </button>
      <span className="sep" />
      <button className="btn" type="button" onClick={() => windows.show(<FiltersModal />)}>
        Filters{filterCount(filters) ? ` (${filterCount(filters)})` : ""}
      </button>
      {focus ? (
        <button className="btn" type="button" onClick={() => setFocus(null)}>
          Clear focus
        </button>
      ) : null}
    </>
  );

  return (
    <ViewFrame
      label="Graph"
      head={
        <>
          <h1>Character graph</h1>
          <span className="meta">
            Characters who share more sit closer. Point at one to light up their connections, or
            select a line to see what the pair shares.
          </span>
          {filterCount(filters) ? <span className="meta">Filtered</span> : null}
        </>
      }
      tray={tray}
    >
      <ErrorNote error={error} />
      {!data ? (
        error ? null : (
          <div className="empty">Drawing the graph…</div>
        )
      ) : !nodes.length ? (
        <div className="empty">
          No characters yet. Add them with the + button, or type their names when adding an
          artifact.
        </div>
      ) : (
        <div className="graph-layout">
          <div style={{ padding: 8 }}>
            <svg
              ref={svg}
              className={`graph-svg ${hovered ? "hovering" : ""}`}
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              role="group"
              aria-label="Character graph. Scroll or pinch to zoom, drag to move."
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                const rect = svg.current!.getBoundingClientRect();
                drag.current = {
                  x: event.clientX,
                  y: event.clientY,
                  view,
                  scale: WIDTH / rect.width,
                };
                moved.current = false;
              }}
            >
              <defs>
                <marker
                  id="graph-arrowhead"
                  viewBox="0 0 10 10"
                  refX="10"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L10 5 L0 10 z" fill={INTRO_COLOR} />
                </marker>
                <clipPath id="graph-node-clip" clipPathUnits="objectBoundingBox">
                  <circle cx="0.5" cy="0.5" r="0.5" />
                </clipPath>
              </defs>
              <rect width={WIDTH} height={HEIGHT} fill="transparent" />
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {edges.map((edge) => {
                  const pa = positions.get(edge.a);
                  const pb = positions.get(edge.b);
                  if (!pa || !pb) return null;
                  const style = STYLES[edge.layer];
                  const nx = -(pb.y - pa.y);
                  const ny = pb.x - pa.x;
                  const length = Math.hypot(nx, ny) || 1;
                  const ox = (nx / length) * style.offset;
                  const oy = (ny / length) * style.offset;
                  const label = `${names[edge.a]} and ${names[edge.b]}: ${edge.count} shared ${
                    edge.layer === "memberships" ? "servers at the same time" : edge.layer
                  }`;
                  const dim = focus !== null && edge.a !== focus && edge.b !== focus;
                  const open = () => void openPair(edge.a, edge.b);
                  return (
                    <g
                      key={`${edge.layer}:${edge.a}:${edge.b}`}
                      className={`edge ${lit(edge.a, edge.b) ? "hl" : ""}`}
                      tabIndex={0}
                      role="button"
                      aria-label={label}
                      opacity={dim ? 0.12 : 1}
                      onClick={select(open)}
                      onKeyDown={keys(open)}
                    >
                      <title>{label}</title>
                      {/* A wide invisible line makes thin lines easy to select. */}
                      <line
                        x1={pa.x + ox}
                        y1={pa.y + oy}
                        x2={pb.x + ox}
                        y2={pb.y + oy}
                        stroke="transparent"
                        strokeWidth={12}
                      />
                      <line
                        x1={pa.x + ox}
                        y1={pa.y + oy}
                        x2={pb.x + ox}
                        y2={pb.y + oy}
                        stroke={style.color}
                        strokeOpacity={0.6}
                        strokeWidth={Math.min(1 + Math.log2(edge.count), 4)}
                        strokeDasharray={style.dash}
                      />
                      {focus && (edge.a === focus || edge.b === focus) ? (
                        <text
                          className="t-sub"
                          x={(pa.x + pb.x) / 2 + ox * 3}
                          y={(pa.y + pb.y) / 2 + oy * 3}
                        >
                          {edge.count}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
                {layers.introductions
                  ? data.introductions.map((intro, i) => {
                      const pa = positions.get(intro.from);
                      const pb = positions.get(intro.to);
                      if (!pa || !pb) return null;
                      const d = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
                      const end = radius(intro.to) + 3;
                      const label = `${names[intro.from]} introduced ${names[intro.to]}${
                        intro.day ? ` on ${dayText(intro.day)}` : ", date unknown"
                      }`;
                      const dim = focus !== null && intro.from !== focus && intro.to !== focus;
                      const open = () => void openPair(intro.from, intro.to);
                      return (
                        <g
                          key={`intro:${i}`}
                          className={`edge ${lit(intro.from, intro.to) ? "hl" : ""}`}
                          tabIndex={0}
                          role="button"
                          aria-label={label}
                          opacity={dim ? 0.12 : 1}
                          onClick={select(open)}
                          onKeyDown={keys(open)}
                        >
                          <title>{label}</title>
                          <line
                            x1={pa.x}
                            y1={pa.y}
                            x2={pb.x - ((pb.x - pa.x) / d) * end}
                            y2={pb.y - ((pb.y - pa.y) / d) * end}
                            stroke={INTRO_COLOR}
                            strokeOpacity={0.7}
                            strokeWidth={1.5}
                            markerEnd="url(#graph-arrowhead)"
                          />
                        </g>
                      );
                    })
                  : null}
                {nodes.map((node) => {
                  const p = positions.get(node.id);
                  if (!p) return null;
                  const r = radius(node.id);
                  const mediaId = "mediaId" in node.picture ? node.picture.mediaId : null;
                  const isFocus = focus === node.id;
                  const faded = focus !== null && !isFocus && !neighbors(focus, node.id);
                  const toggle = () => {
                    setFocus(isFocus ? null : node.id);
                    setSelected(null);
                  };
                  return (
                    <g
                      key={node.id}
                      className={`node ${isFocus ? "focus" : ""} ${litNode(node.id) ? "hl" : ""}`}
                      tabIndex={0}
                      role="button"
                      aria-label={node.knownName}
                      opacity={faded ? 0.3 : 1}
                      onClick={select(toggle)}
                      onKeyDown={keys(toggle)}
                      onPointerEnter={() => !drag.current && setHovered(node.id)}
                      onPointerLeave={() => setHovered(null)}
                    >
                      {mediaId ? (
                        <image
                          href={mediaUrl(archive.archiveId, mediaId)}
                          x={p.x - r}
                          y={p.y - r}
                          width={r * 2}
                          height={r * 2}
                          preserveAspectRatio="xMidYMid slice"
                          clipPath="url(#graph-node-clip)"
                        />
                      ) : (
                        <text
                          x={p.x}
                          y={p.y + 3.5}
                          textAnchor="middle"
                          fontSize={r > 13 ? 10 : 8}
                          fontWeight={700}
                          fill="#f2f3f5"
                        >
                          {initials(node.knownName)}
                        </text>
                      )}
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={r}
                        fill={mediaId ? "none" : "#383a40"}
                        fillOpacity={mediaId ? 0 : 0.35}
                        stroke={isFocus ? "#f2f3f5" : "#1e1f22"}
                        strokeWidth={isFocus ? 3 : 2}
                        strokeDasharray={mediaId ? undefined : "3 3"}
                      />
                      <text className="name" x={p.x} y={p.y + r + 13} textAnchor="middle">
                        {node.knownName}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
          <div className="graph-side">
            {selected && support ? (
              <SupportPanel
                a={selected.a}
                b={selected.b}
                names={names}
                support={support}
                onEvent={(id) => windows.openEvent(id)}
              />
            ) : focus && names[focus] ? (
              <>
                <h3>{names[focus]}</h3>
                <p className="hint">
                  Lines to this character are highlighted, with their counts. Select a line to open
                  the artifacts the two share.
                </p>
                <button
                  className="btn"
                  type="button"
                  onClick={() => navigate(characterPath(archive.archiveId, focus))}
                >
                  Open character page
                </button>
              </>
            ) : (
              <>
                {totals.size === 0 ? (
                  <p className="hint" style={{ marginTop: 0 }}>
                    No connections to draw yet. Lines appear when two characters share an artifact
                    or event, one introduced the other, or both were in a server at the same time.
                    Turn on more layers in the tray, or add characters to artifacts.
                  </p>
                ) : null}
                <h3>How to read this</h3>
                <ul>
                  <li>
                    Characters who share more are pulled closer. Everyone pushes everyone else away
                    a little, so groups form on their own.
                  </li>
                  <li>Bigger circles have more connections.</li>
                  <li>Green: shared artifacts. The tray hides pairs with only a few.</li>
                  <li>Red: shared events.</li>
                  <li>
                    Yellow dashed: servers where both were members at the same time. Unknown dates
                    are left out.
                  </li>
                  <li>Arrows: who introduced whom.</li>
                  <li>Select a line to open an album of the artifacts the two share.</li>
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </ViewFrame>
  );
}

function SupportPanel(props: {
  a: string;
  b: string;
  names: Record<string, string>;
  support: Support;
  onEvent(id: string): void;
}) {
  const { a, b, names, support } = props;
  const nothing = !support.events.length && !support.introductions.length && !support.memberships;
  return (
    <>
      <h3>
        {names[a]} and {names[b]}
      </h3>
      <p className="hint">No shared artifacts{nothing ? "." : ". What connects them:"}</p>
      <ul>
        {support.events.map((event) => (
          <li key={event.id}>
            <button className="linkish" type="button" onClick={() => props.onEvent(event.id)}>
              {event.title}
            </button>{" "}
            ({dayText(event.day)})
          </li>
        ))}
        {support.introductions.map((intro, i) => (
          <li key={i}>
            {names[intro.from]} introduced {names[intro.to]}
            {intro.day ? ` on ${dayText(intro.day)}` : ", date unknown"}
          </li>
        ))}
        {support.memberships ? (
          <li>
            Both were members of {support.memberships}{" "}
            {support.memberships === 1 ? "server" : "servers"} at the same time.
          </li>
        ) : null}
      </ul>
    </>
  );
}
