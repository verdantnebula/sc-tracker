// RouteMapView — the MAP view of the ROUTE tab. A deterministic, physics-free
// layered flow map of cargo movements built from selectors.routeEdges. Nodes are
// stations (union of all edge from/to), laid out in three columns by role:
//   col 0 = pure sources (pickup-only)   -> origins on the left
//   col 1 = pass-through (source & sink)  -> middle
//   col 2 = pure sinks (dropoff-only)     -> destinations on the right
// Directed edges flow left->right: amber dot at the pick-up end, cyan arrow at the
// drop-off end. The commodity+SCU is listed inside each drop-off (sink) node card
// under its "DROP OFF" role label — one line per incoming edge. Fully-delivered
// edges (done) are dimmed + dashed. Read-only overview (no editing in v1).
import { useMemo } from "react";
import type { RouteEdge } from "../lib/selectors";
import { fmt } from "../lib/selectors";

const NODE_W = 140;
const HEADER_H = 44; // name + role rows (used by sinks for the cargo-line offset)
const BASE_H = 48; // pure-source (pickup-only) node height
const LINE_H = 15; // per cargo line inside a sink card
const PAD = 8; // bottom padding under the cargo lines in a sink card
const ROW_GAP = 22; // vertical gap between stacked nodes in a column
const TOP_PAD = 24;
const COL_X = [60, 286, 548]; // left / middle / right column x-origins
const VIEW_W = 700;

interface MapNode {
  id: string; // = location label (sentinel "Unknown" allowed)
  label: string;
  isSource: boolean;
  isSink: boolean;
  col: number;
  x: number;
  y: number;
  h: number; // computed node height (varies for sinks with cargo lines)
  incoming: RouteEdge[]; // edges terminating at this node (cargo it receives)
}

// Pure height calc for a node, exported for unit testing. Sinks grow to fit one
// cargo line per incoming edge; pure-source (pickup-only) nodes stay at BASE_H.
// A sink with zero incoming edges also collapses to BASE_H (just name + role).
export function mapNodeHeight(isSink: boolean, incomingCount: number): number {
  if (!isSink || incomingCount <= 0) return BASE_H;
  return HEADER_H + incomingCount * LINE_H + PAD;
}

export function RouteMapView({
  edges,
  visitOrder,
}: {
  edges: RouteEdge[];
  /** Optional location -> 1-based visit number; when set, nodes are badged. */
  visitOrder?: Map<string, number>;
}): React.JSX.Element {
  const { nodes, height } = useMemo(() => buildLayout(edges), [edges]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  if (edges.length === 0) {
    return (
      <div
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 13,
          color: "var(--muted)",
          padding: "24px 6px",
        }}
      >
        No active hauls to map.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        width="100%"
        role="img"
        aria-label="Cargo route map"
        style={{ display: "block" }}
      >
        <defs>
          <marker
            id="route-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" />
          </marker>
        </defs>

        {/* Edges first, so nodes render on top. */}
        {edges.map((e) => {
          const from = nodeById.get(e.fromLocation);
          const to = nodeById.get(e.toLocation);
          if (!from || !to) return null;
          return <EdgeLine key={e.id} edge={e} from={from} to={to} />;
        })}

        {/* Nodes (drop-off cards carry their incoming-cargo lines). */}
        {nodes.map((n) => (
          <NodeBox key={n.id} node={n} visit={visitOrder?.get(n.id)} />
        ))}
      </svg>

      {/* Legend. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          fontFamily: "var(--font-display)",
          fontSize: 10,
          letterSpacing: 1,
          color: "var(--muted)",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--secondary)",
              display: "inline-block",
            }}
          />
          PICK UP (LOAD)
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--primary)", fontSize: 14 }}>→</span>
          DROP OFF (UNLOAD)
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout — classify stations into source/sink/both, bucket into 3 columns, then
// stack each column vertically. Node heights now vary (sinks list their cargo),
// so columns stack cumulatively by each node's height. Deterministic (sorted id).
// ---------------------------------------------------------------------------
function buildLayout(edges: RouteEdge[]): { nodes: MapNode[]; height: number } {
  const sources = new Set<string>();
  const sinks = new Set<string>();
  for (const e of edges) {
    sources.add(e.fromLocation);
    sinks.add(e.toLocation);
  }

  // Group incoming edges per destination so each sink can list its cargo and we
  // can size its card. Edge order is preserved (routeEdges is already sorted).
  const incomingByNode = new Map<string, RouteEdge[]>();
  for (const e of edges) {
    const list = incomingByNode.get(e.toLocation);
    if (list) list.push(e);
    else incomingByNode.set(e.toLocation, [e]);
  }

  const allIds = Array.from(new Set([...sources, ...sinks])).sort();

  // col: 0 = pure source, 1 = both, 2 = pure sink. (An isolated id that's only a
  // source goes left; only a sink goes right; both -> middle.)
  const cols: string[][] = [[], [], []];
  for (const id of allIds) {
    const isSource = sources.has(id);
    const isSink = sinks.has(id);
    const col = isSource && isSink ? 1 : isSource ? 0 : 2;
    cols[col].push(id);
  }

  const nodes: MapNode[] = [];
  const colHeights: number[] = [];
  cols.forEach((ids, col) => {
    let runningY = TOP_PAD;
    ids.forEach((id) => {
      const isSink = sinks.has(id);
      const incoming = incomingByNode.get(id) ?? [];
      const h = mapNodeHeight(isSink, incoming.length);
      nodes.push({
        id,
        label: id,
        isSource: sources.has(id),
        isSink,
        col,
        x: COL_X[col],
        y: runningY,
        h,
        incoming,
      });
      runningY += h + ROW_GAP;
    });
    // runningY overshoots by one ROW_GAP after the last node; subtract it back.
    colHeights.push(ids.length > 0 ? runningY - ROW_GAP : TOP_PAD);
  });

  const tallest = Math.max(TOP_PAD + BASE_H, ...colHeights);
  const height = tallest + TOP_PAD;
  return { nodes, height };
}

function NodeBox({
  node,
  visit,
}: {
  node: MapNode;
  /** 1-based visit number when route optimization is on; undefined otherwise. */
  visit?: number;
}): React.JSX.Element {
  const roleParts: React.JSX.Element[] = [];
  if (node.isSource)
    roleParts.push(
      <tspan key="pu" fill="var(--secondary)">
        PICK UP
      </tspan>,
    );
  if (node.isSource && node.isSink)
    roleParts.push(
      <tspan key="dot" fill="var(--muted)">
        {" · "}
      </tspan>,
    );
  if (node.isSink)
    roleParts.push(
      <tspan key="do" fill="var(--primary)">
        DROP OFF
      </tspan>,
    );

  // Truncate long station names to fit the node width.
  const label =
    node.label.length > 18 ? node.label.slice(0, 17) + "…" : node.label;

  // Cargo lines: one per incoming edge, only for sinks. Pure-source nodes show
  // just the name + role. Long commodity names are truncated so the line fits.
  const cargoLines = node.isSink
    ? node.incoming.map((e) => ({
        id: e.id,
        text: `${truncCommodity(e.commodity)} · ${fmt(e.scu)}`,
        done: e.done,
      }))
    : [];

  return (
    <g>
      <rect
        x={node.x}
        y={node.y}
        width={NODE_W}
        height={node.h}
        rx={6}
        fill="var(--window)"
        stroke={visit != null ? "var(--primary)" : "var(--border-strong)"}
        strokeWidth={1}
      />
      {/* Visit-order badge (top-left), shown only when optimization is on. */}
      {visit != null && (
        <g>
          <circle
            cx={node.x + 14}
            cy={node.y + 14}
            r={9}
            fill="var(--window)"
            stroke="var(--primary)"
            strokeWidth={1.4}
          />
          <text
            x={node.x + 14}
            y={node.y + 18}
            textAnchor="middle"
            fontFamily="var(--font-mono)"
            fontSize={10}
            fontWeight={700}
            fill="var(--primary)"
          >
            {visit}
          </text>
        </g>
      )}
      <text
        x={node.x + NODE_W / 2}
        y={node.y + 20}
        textAnchor="middle"
        fontFamily="var(--font-display)"
        fontSize={13}
        fontWeight={600}
        fill="var(--text-bright)"
      >
        {label}
      </text>
      <text
        x={node.x + NODE_W / 2}
        y={node.y + 36}
        textAnchor="middle"
        fontFamily="var(--font-display)"
        fontSize={9}
        fontWeight={700}
        letterSpacing={1}
      >
        {roleParts}
      </text>
      {cargoLines.map((line, i) => (
        <text
          key={line.id}
          x={node.x + NODE_W / 2}
          y={node.y + HEADER_H + i * LINE_H + 4}
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fontSize={11}
          fill={line.done ? "var(--muted)" : "var(--primary)"}
        >
          {line.text}
        </text>
      ))}
    </g>
  );
}

// Truncate a commodity name so a "<commodity> · <scu>" line fits the node width.
function truncCommodity(name: string): string {
  const n = name || "?";
  return n.length > 18 ? n.slice(0, 17) + "…" : n;
}

function EdgeLine({
  edge,
  from,
  to,
}: {
  edge: RouteEdge;
  from: MapNode;
  to: MapNode;
}): React.JSX.Element {
  // Anchor on the node edges facing the flow direction, at each node's actual
  // vertical center (heights now vary). Same-column or right-to-left layouts
  // still connect sensibly (left/right midpoints).
  const goingRight = to.x >= from.x;
  const x1 = goingRight ? from.x + NODE_W : from.x;
  const y1 = from.y + from.h / 2;
  const x2 = goingRight ? to.x : to.x + NODE_W;
  const y2 = to.y + to.h / 2;
  return (
    <g opacity={edge.done ? 0.32 : 1}>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={edge.done ? "var(--muted)" : "var(--primary)"}
        strokeWidth={1.6}
        strokeOpacity={0.7}
        strokeDasharray={edge.done ? "5 4" : undefined}
        markerEnd="url(#route-arrow)"
      />
      {/* amber pick-up dot at the source end */}
      <circle cx={x1} cy={y1} r={3.6} fill="var(--secondary)" />
    </g>
  );
}
