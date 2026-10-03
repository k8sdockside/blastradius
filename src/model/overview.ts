// The overview: every target imagined gone, boiled down to headline numbers
// and laid out on a radar. Pure functions, no DOM, so the layout is testable.

import { SEVERITIES, type Impact, type Severity } from './impact';
import type { Ref } from './kube';

/** The kinds the survey ranks, in the order their radar sectors go round. */
export const SURVEY_KINDS = ['nodes', 'persistentvolumeclaims', 'storageclasses', 'configmaps', 'secrets', 'services'] as const;

/** What breaks downstream of a target, by severity: workloads, Services and entry points only. */
export function consequences(impact: Impact): Record<Severity, number> {
    const out: Record<Severity, number> = { down: 0, stuck: 0, degraded: 0, restart: 0, info: 0 };
    for (const n of impact.nodes) if (n.column >= 2) out[n.severity]++;
    return out;
}

export interface Stats {
    /** Targets ranked, i.e. that break something. */
    risky: number;
    /** Targets whose loss takes something fully down: single points of failure. */
    spof: number;
    /** Distinct workloads some single loss takes down or leaves unable to recover. */
    workloadsAtRisk: number;
    /** Distinct Services some single loss leaves with no endpoints. */
    servicesAtRisk: number;
    /** Distinct Ingresses/HTTPRoutes some single loss stops from answering. */
    entriesAtRisk: number;
    /** Ranked targets per verdict severity. */
    bySeverity: Record<Severity, number>;
}

export function stats(impacts: Impact[]): Stats {
    const workloads = new Set<string>();
    const services = new Set<string>();
    const entries = new Set<string>();
    const bySeverity: Record<Severity, number> = { down: 0, stuck: 0, degraded: 0, restart: 0, info: 0 };
    let spof = 0;
    for (const impact of impacts) {
        const sev = impact.verdict.severity;
        if (sev) bySeverity[sev]++;
        let downstreamDown = false;
        for (const n of impact.nodes) {
            if (n.column === 2 && (n.severity === 'down' || n.severity === 'stuck')) workloads.add(n.id);
            if (n.column === 3 && n.severity === 'down') services.add(n.id);
            if (n.column === 4 && n.severity === 'down') entries.add(n.id);
            if (n.column >= 2 && n.severity === 'down') downstreamDown = true;
        }
        if (downstreamDown) spof++;
    }
    return {
        risky: impacts.length,
        spof,
        workloadsAtRisk: workloads.size,
        servicesAtRisk: services.size,
        entriesAtRisk: entries.size,
        bySeverity,
    };
}

// ----- the radar ---------------------------------------------------------------------------

/**
 * Rings, inside out: the worse a loss, the nearer the bullseye. Radii are a
 * fraction of the radar's radius.
 */
export const RINGS: { severity: Severity; inner: number; outer: number }[] = [
    { severity: 'down', inner: 0.1, outer: 0.34 },
    { severity: 'stuck', inner: 0.34, outer: 0.56 },
    { severity: 'degraded', inner: 0.56, outer: 0.78 },
    { severity: 'restart', inner: 0.78, outer: 0.96 },
];

/** Radians left empty at 12 o'clock, where the ring labels go. */
export const TOP_GAP = 0.36;

export interface Sector {
    kind: string;
    /** Angles in radians, clockwise from 12 o'clock. */
    start: number;
    end: number;
    count: number;
}

export interface Dot {
    id: string;
    ref: Ref;
    severity: Severity;
    score: number;
    /** Position in a unit circle centred on 0,0, y pointing down. */
    x: number;
    y: number;
    /** Size as a fraction of the radar's radius. */
    size: number;
}

export interface Radar {
    sectors: Sector[];
    dots: Dot[];
    /** Ranked targets left off the radar to keep it readable. */
    hidden: number;
}

/**
 * Places every ranked target on the radar: its kind picks the sector, its
 * verdict the ring, its score how deep into the ring (higher, nearer the
 * centre) and how big. Kinds with nothing ranked get no sector.
 */
export function radarLayout(impacts: Impact[], maxDots = 80): Radar {
    const shown = [...impacts].sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id)).slice(0, maxDots);
    const order = (kind: string): number => {
        const i = (SURVEY_KINDS as readonly string[]).indexOf(kind);
        return i < 0 ? SURVEY_KINDS.length : i;
    };
    const byKind = new Map<string, Impact[]>();
    for (const impact of shown) {
        const kind = impact.target.ref.kind;
        const list = byKind.get(kind);
        if (list) list.push(impact);
        else byKind.set(kind, [impact]);
    }
    const kinds = [...byKind.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    const total = shown.length;
    const maxScore = Math.max(1, ...shown.map((i) => i.score));
    const sectors: Sector[] = [];
    const dots: Dot[] = [];
    // Each kind gets a share of the circle by the square root of how many it has -- so a crowded
    // kind gets more room without starving the rest -- and never less than a minimum, so a lone
    // dot still has room for its label. A gap at 12 o'clock is left for the ring labels.
    const minShare = kinds.length ? Math.min(1 / kinds.length, 0.08) : 0;
    const raw = kinds.map((k) => Math.max(minShare, Math.sqrt(byKind.get(k)!.length / Math.max(1, total))));
    const sum = raw.reduce((a, b) => a + b, 0) || 1;
    const room = Math.PI * 2 - TOP_GAP;
    let angle = TOP_GAP / 2;
    kinds.forEach((kind, k) => {
        const span = (raw[k]! / sum) * room;
        const list = byKind.get(kind)!;
        sectors.push({ kind, start: angle, end: angle + span, count: list.length });
        const pad = Math.min(span * 0.08, 0.06);
        const usable = span - pad * 2;
        // A crowded sector spreads its dots over three lanes, in, middle and out, so neighbours do not touch.
        const lanes = list.length > 5 ? 3 : 1;
        list.forEach((impact, i) => {
            const sev = ringOf(impact.verdict.severity);
            const ring = RINGS.find((r) => r.severity === sev) ?? RINGS[RINGS.length - 1]!;
            const depth = 1 - impact.score / maxScore;
            const lane = lanes === 1 ? 0 : (i % lanes) - 1;
            const t = clamp(0.5 + lane * 0.32 + (depth - 0.5) * (lanes === 1 ? 0.6 : 0.15), 0.1, 0.9);
            const radius = ring.inner + (ring.outer - ring.inner) * t;
            const a = angle + pad + (list.length === 1 ? usable / 2 : (usable * (i + 0.5)) / list.length);
            dots.push({
                id: impact.target.id,
                ref: impact.target.ref,
                severity: sev,
                score: impact.score,
                x: Math.sin(a) * radius,
                y: -Math.cos(a) * radius,
                size: 0.016 + 0.03 * Math.sqrt(impact.score / maxScore),
            });
        });
        angle += span;
    });
    return { sectors, dots, hidden: Math.max(0, impacts.length - shown.length) };
}

function ringOf(sev: Severity | null): Severity {
    if (!sev || sev === 'info') return 'restart';
    return SEVERITIES.includes(sev) ? sev : 'restart';
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, n));
}
