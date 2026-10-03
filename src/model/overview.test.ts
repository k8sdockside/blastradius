import { describe, expect, it } from 'vitest';
import type { Column, GraphNode, Impact, Severity } from './impact';
import { RINGS, TOP_GAP, consequences, radarLayout, stats } from './overview';

function node(id: string, column: Column, severity: Severity): GraphNode {
    const [kind = '', namespace = '', name = ''] = id.split('/');
    return { id, ref: { kind, namespace, name }, column, severity, reason: '', detail: '', openable: true, targetable: true };
}

function impact(id: string, score: number, severity: Severity | null, nodes: GraphNode[] = []): Impact {
    return { target: node(id, 0, 'info'), found: true, scenario: '', nodes, edges: [], notes: [], verdict: { severity, text: '' }, score };
}

const n1 = impact('nodes//n1', 40, 'down', [
    node('persistentvolumeclaims/shop/data', 1, 'stuck'),
    node('deployments/shop/api', 2, 'down'),
    node('deployments/shop/web', 2, 'degraded'),
    node('services/shop/api', 3, 'down'),
    node('ingresses/shop/shop', 4, 'degraded'),
    node('daemonsets/kube-system/agent', 2, 'info'),
]);
const cm = impact('configmaps/shop/web-config', 4, 'restart', [node('deployments/shop/web', 2, 'restart'), node('services/shop/web', 3, 'restart')]);
const svc = impact('services/shop/api', 20, 'down', [node('ingresses/shop/shop', 4, 'down')]);

describe('consequences', () => {
    it('counts only what is downstream of the target, by severity', () => {
        expect(consequences(n1)).toEqual({ down: 2, stuck: 0, degraded: 2, restart: 0, info: 1 });
    });
});

describe('stats', () => {
    it('counts single points of failure and distinct things at risk', () => {
        const s = stats([n1, cm, svc]);
        expect(s.risky).toBe(3);
        expect(s.spof).toBe(2);
        expect(s.workloadsAtRisk).toBe(1);
        expect(s.servicesAtRisk).toBe(1);
        expect(s.entriesAtRisk).toBe(1);
        expect(s.bySeverity).toMatchObject({ down: 2, restart: 1 });
    });

    it('is all zero for a quiet cluster', () => {
        expect(stats([])).toMatchObject({ risky: 0, spof: 0, workloadsAtRisk: 0 });
    });
});

describe('radarLayout', () => {
    const radius = (d: { x: number; y: number }) => Math.hypot(d.x, d.y);

    it('puts worse losses nearer the centre, inside their ring', () => {
        const radar = radarLayout([cm, n1, svc]);
        const at = (id: string) => radar.dots.find((d) => d.id === id)!;
        const ringOf = (sev: Severity) => RINGS.find((r) => r.severity === sev)!;
        expect(radius(at('nodes//n1'))).toBeLessThan(radius(at('configmaps/shop/web-config')));
        for (const id of ['nodes//n1', 'services/shop/api']) {
            expect(radius(at(id))).toBeGreaterThanOrEqual(ringOf('down').inner);
            expect(radius(at(id))).toBeLessThanOrEqual(ringOf('down').outer);
        }
        expect(radius(at('configmaps/shop/web-config'))).toBeGreaterThanOrEqual(ringOf('restart').inner);
        expect(at('nodes//n1').size).toBeGreaterThan(at('configmaps/shop/web-config').size);
    });

    it('gives each kind present one sector, together the circle less the label gap, in survey order', () => {
        const radar = radarLayout([cm, n1, svc]);
        expect(radar.sectors.map((s) => s.kind)).toEqual(['nodes', 'configmaps', 'services']);
        expect(radar.sectors[0]!.start).toBeCloseTo(TOP_GAP / 2);
        expect(radar.sectors.at(-1)!.end).toBeCloseTo(Math.PI * 2 - TOP_GAP / 2);
        radar.sectors.slice(1).forEach((sec, i) => expect(sec.start).toBeCloseTo(radar.sectors[i]!.end));
        for (const dot of radar.dots) {
            const sector = radar.sectors.find((s) => s.kind === dot.ref.kind)!;
            const a = (Math.atan2(dot.x, -dot.y) + Math.PI * 2) % (Math.PI * 2);
            expect(a).toBeGreaterThanOrEqual(sector.start);
            expect(a).toBeLessThanOrEqual(sector.end);
        }
    });

    it('keeps the worst when there are too many to draw', () => {
        const radar = radarLayout([cm, n1, svc], 2);
        expect(radar.dots.map((d) => d.id).sort()).toEqual(['nodes//n1', 'services/shop/api']);
        expect(radar.hidden).toBe(1);
    });

    it('draws nothing for nothing', () => {
        expect(radarLayout([])).toEqual({ sectors: [], dots: [], hidden: 0 });
    });
});
