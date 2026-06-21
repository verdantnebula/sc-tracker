// RouteMapView — the MAP view of the ROUTE tab. A deterministic, physics-free
// layered flow map of cargo movements built from selectors.routeEdges. Nodes are
// stations (union of all edge from/to), laid out in three columns by role:
//   col 0 = pure sources (pickup-only)   -> origins on the left
//   col 1 = pass-through (source & sink)  -> middle
//   col 2 = pure sinks (dropoff-only)     -> destinations on the right
// Directed edges flow left->right: amber dot at the pick-up end, cyan arrow at the
// drop-off end, commodity+SCU label at the midpoint. Fully-delivered edges (done)
// are dimmed + dashed. Read-only overview (no editing in v1).
import { useMemo } from "react";
import type { RouteEdge } from "../lib/selectors";
import { fmt } from "../lib/selectors";

const NODE_W = 128;
const NODE_H = 48;
const ROW_PITCH = 70;
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
}

export function RouteMapView({
  edges,
}: {
  edges: RouteEdge[];
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

        {/* Nodes. */}
        {nodes.map((n) => (
          <NodeBox key={n.id} node={n} />
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
// stack each column vertically with an even pitch. Deterministic (sorted by id).
// ---------------------------------------------------------------------------
function buildLayout(edges: RouteEdge[]): { nodes: MapNode[]; height: number } {
  const sources = new Set<string>();
  const sinks = new Set<string>();
  for (const e of edges) {
    sources.add(e.fromLocation);
    sinks.add(e.toLocation);
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
  cols.forEach((ids, col) => {
    ids.forEach((id, i) => {
      nodes.push({
        id,
        label: id,
        isSource: sources.has(id),
        isSink: sinks.has(id),
        col,
        x: COL_X[col],
        y: TOP_PAD + i * ROW_PITCH,
      });
    });
  });

  const maxRows = Math.max(1, ...cols.map((c) => c.length));
  const height = TOP_PAD * 2 + (maxRows - 1) * ROW_PITCH + NODE_H;
  return { nodes, height };
}

function NodeBox({ node }: { node: MapNode }): React.JSX.Element {
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

  // Truncate long station names to fit the node width (~16 chars at 13px).
  const label =
    node.label.length > 17 ? node.label.slice(0, 16) + "…" : node.label;

  return (
    <g>
      <rect
        x={node.x}
        y={node.y}
        width={NODE_W}
        height={NODE_H}
        rx={6}
        fill="var(--window)"
        stroke="var(--border-strong)"
        strokeWidth={1}
      />
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
    </g>
  );
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
  // Anchor on the node edges facing the flow direction. Same-column or
  // right-to-left layouts still connect sensibly (left/right midpoints).
  const goingRight = to.x >= from.x;
  const x1 = goingRight ? from.x + NODE_W : from.x;
  const y1 = from.y + NODE_H / 2;
  const x2 = goingRight ? to.x : to.x + NODE_W;
  const y2 = to.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  const label = `${edge.commodity || "?"} · ${fmt(edge.scu)}`;

  return (
    <g opacity={edge.done ? 0.32 : 1}>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="var(--primary)"
        strokeWidth={1.6}
        strokeOpacity={0.7}
        strokeDasharray={edge.done ? "5 4" : undefined}
        markerEnd="url(#route-arrow)"
      />
      {/* amber pick-up dot at the source end */}
      <circle cx={x1} cy={y1} r={3.6} fill="var(--secondary)" />
      {/* commodity + SCU label with a dark halo for legibility */}
      <text
        x={mx}
        y={my - 5}
        textAnchor="middle"
        fontFamily="var(--font-mono)"
        fontSize={11}
        fill="var(--text)"
        stroke="var(--window)"
        strokeWidth={3}
        paintOrder="stroke"
      >
        {label}
      </text>
    </g>
  );
}
