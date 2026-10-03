// The Blast radius view: pick an object, see what fails if it goes away.

import { button, byId, el, replace, svg } from '@k8sdockside/plugin-sdk/dom';
import { CLUSTER_SCOPED, TARGET_KINDS, kindLabel, type Ref, type Snapshot } from '../model/kube';
import {
    COLUMN_LABEL,
    Index,
    SEVERITIES,
    SEVERITY_LABEL,
    blastRadius,
    candidates,
    hotspots,
    type GraphNode,
    type Impact,
    type Severity,
} from '../model/impact';
import { RINGS, SURVEY_KINDS, consequences, radarLayout, stats, type Dot } from '../model/overview';
import { LOGO, chip, clearError, kindTag, open, readHash, refLabel, showError, takeHandOver, when, writeHash } from '../ui/common';
import { loadSnapshot } from '../ui/load';

let snap: Snapshot | null = null;
let index: Index | null = null;
let target: Ref | null = null;
let pickKind: string = 'nodes';
let pickNs = '';
let stopResize: (() => void) | null = null;
let showQuiet = false;
/** Every ranked target of the current snapshot, worked out once per read. */
let survey: Impact[] | null = null;
/** The overview's kind filter; '' for all. */
let hotKind = '';

const kindSel = byId<HTMLSelectElement>('kind');
const nsSel = byId<HTMLSelectElement>('namespace');
const nameSel = byId<HTMLSelectElement>('name');
const main = byId('main');

async function start(): Promise<void> {
    const ctx = await k8sdockside.ready();
    byId('logo').append(svg(LOGO, 'mark'));
    byId('where').textContent = ctx.contextName;

    for (const kind of TARGET_KINDS) kindSel.append(el('option', { value: kind }, kindLabel(kind)));
    kindSel.addEventListener('change', () => {
        pickKind = kindSel.value;
        pickNs = '';
        target = null;
        fillPickers();
        render();
    });
    nsSel.addEventListener('change', () => {
        pickNs = nsSel.value;
        target = null;
        fillPickers();
        render();
    });
    nameSel.addEventListener('change', () => {
        const name = nameSel.value;
        target = name ? { kind: pickKind, namespace: CLUSTER_SCOPED.has(pickKind) ? '' : pickNs, name } : null;
        render();
    });
    byId('clear').addEventListener('click', () => {
        target = null;
        fillPickers();
        render();
    });
    byId('refresh').addEventListener('click', () => void refresh());

    const hash = readHash();
    const handed = await takeHandOver();
    if (handed) target = handed;
    else if (hash.kind && hash.name) target = { kind: hash.kind, namespace: hash.ns ?? '', name: hash.name };
    if (target) {
        pickKind = target.kind;
        pickNs = target.namespace;
    } else if (hash.kind) pickKind = hash.kind;

    await refresh();
}

async function refresh(): Promise<void> {
    try {
        const loaded = await loadSnapshot();
        snap = loaded.snap;
        index = new Index(snap);
        survey = null;
        clearError();
        const missing = byId('missing');
        missing.hidden = !loaded.missing.length;
        missing.textContent = loaded.missing.length
            ? `Could not read ${loaded.missing.join(', ')}; what depends on them is left out.`
            : '';
        byId('where').textContent = `${(await k8sdockside.ready()).contextName} · read at ${when()}`;
        fillPickers();
        render();
    } catch (err) {
        showError(err);
    }
}

function fillPickers(): void {
    if (!snap) return;
    kindSel.value = pickKind;
    const all = candidates(snap, pickKind);
    const scoped = !CLUSTER_SCOPED.has(pickKind);
    byId('ns-wrap').hidden = !scoped;
    if (scoped) {
        const namespaces = [...new Set(all.map((r) => r.namespace))].sort();
        if (!namespaces.includes(pickNs)) pickNs = namespaces.includes('default') ? 'default' : (namespaces[0] ?? '');
        replace(nsSel, ...namespaces.map((ns) => el('option', { value: ns }, ns)));
        nsSel.value = pickNs;
    }
    const names = all.filter((r) => !scoped || r.namespace === pickNs).map((r) => r.name).sort();
    replace(nameSel, el('option', { value: '' }, names.length ? `Pick one of ${names.length}…` : 'None here'), ...names.map((n) => el('option', { value: n }, n)));
    nameSel.value = target && target.kind === pickKind && names.includes(target.name) ? target.name : '';
}

function pick(ref: Ref): void {
    target = ref;
    pickKind = ref.kind;
    pickNs = ref.namespace;
    fillPickers();
    render();
    main.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0 });
}

function render(): void {
    stopResize?.();
    stopResize = null;
    if (!snap || !index) return;
    writeHash(target ? { kind: target.kind, ns: target.namespace, name: target.name } : { kind: pickKind });
    if (!target) return renderHotspots();
    const full = blastRadius(snap, target, index);
    // Unaffected objects (a node's DaemonSet pods, say) are hidden unless asked for: they are
    // most of the graph and none of the news.
    const quiet = full.nodes.filter((n) => n.severity === 'info').length;
    const shown = showQuiet ? full : trimQuiet(full);
    const toggle = el('label', { class: 'toggle small' }, el('input', { type: 'checkbox' }), `Show ${quiet} touched but unaffected`);
    const box = toggle.querySelector('input')!;
    box.checked = showQuiet;
    box.addEventListener('change', () => {
        showQuiet = box.checked;
        render();
    });
    replace(main, verdictCard(full), quiet ? toggle : null, graph(shown), notes(full), table(shown));
}

// ----- the overview: where it would hurt most ----------------------------------------------------

const SVGNS = 'http://www.w3.org/2000/svg';

/** An SVG element. Cluster data only ever goes in as text, through `.textContent`. */
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text;
    return node;
}

/** The radar is drawn in a box of ±R around the centre, plus room for the sector labels. */
const R = 100;

function renderHotspots(): void {
    survey ??= hotspots(snap!, Infinity);
    const all = survey;
    if (hotKind && !all.some((i) => i.target.ref.kind === hotKind)) hotKind = '';
    const st = stats(all);
    const radar = radarLayout(all);
    const shown = all.filter((i) => !hotKind || i.target.ref.kind === hotKind).slice(0, 24);

    const dots = new Map<string, SVGGElement>();
    const cards = new Map<string, HTMLElement>();
    const byTarget = new Map(all.map((i) => [i.target.id, i]));
    const readout = el('div', { class: 'readout' });
    const idleReadout = (): void =>
        replace(readout,
            el('div', { class: 'readout-title' }, all.length ? 'Pick a dot' : 'All clear'),
            el('div', { class: 'dim small' }, all.length
                ? 'Each dot is one object imagined gone. The nearer the bullseye and the bigger, the more breaks with it.'
                : 'No single node, claim, ConfigMap, Secret, Service or StorageClass takes anything down with it.'),
        );
    const focus = (id: string | null): void => {
        for (const [key, g] of dots) g.classList.toggle('lit', key === id);
        for (const [key, c] of cards) c.classList.toggle('lit', key === id);
        radarBox.classList.toggle('focusing', id !== null && dots.has(id));
        const impact = id ? byTarget.get(id) : undefined;
        if (!impact) return idleReadout();
        const c = consequences(impact);
        replace(readout,
            el('div', { class: 'readout-head' }, kindTag(impact.target.ref.kind), el('span', { class: `score sev-${impact.verdict.severity ?? 'info'}` }, `impact ${impact.score}`)),
            el('div', { class: 'readout-title' }, refLabel(impact.target.ref)),
            el('div', { class: 'dim small' }, impact.verdict.text),
            severityBar(c),
            el('div', { class: 'faint small' }, 'Click to see the whole blast'),
        );
    };

    // --- the radar
    const chart = s('svg', { viewBox: `${-R * 1.66} ${-R * 1.22} ${R * 3.32} ${R * 2.44}`, class: 'radar', role: 'img' });
    chart.append(s('title', {}, `Radar of ${all.length} objects whose loss would break something`));
    for (const ring of [...RINGS].reverse()) {
        chart.append(s('circle', { r: ring.outer * R, class: `ring sev-${ring.severity}` }));
    }
    chart.append(s('circle', { r: RINGS[0]!.inner * R, class: 'bullseye' }));
    for (const sector of radar.sectors) {
        for (const a of sector === radar.sectors.at(-1) ? [sector.start, sector.end] : [sector.start]) {
            const edge = polar(a, R * 0.98);
            chart.append(s('line', { x1: 0, y1: 0, x2: edge.x, y2: edge.y, class: 'spoke' }));
        }
        const mid = (sector.start + sector.end) / 2;
        const at = polar(mid, R * 1.1);
        const anchor = Math.abs(at.x) < R * 0.2 ? 'middle' : at.x > 0 ? 'start' : 'end';
        const label = s('text', { x: at.x, y: at.y, 'text-anchor': anchor, 'dominant-baseline': 'middle', class: `sector-label${hotKind === sector.kind ? ' on' : ''}` }, `${kindLabel(sector.kind)} · ${sector.count}`);
        label.addEventListener('click', () => setHotKind(hotKind === sector.kind ? '' : sector.kind));
        chart.append(label);
    }
    for (const ring of RINGS) {
        chart.append(s('text', { x: 0, y: -ring.outer * R + 6.5, 'text-anchor': 'middle', class: 'ring-label' }, SEVERITY_LABEL[ring.severity]));
    }
    for (const dot of radar.dots) chart.append(dotMark(dot, dots, focus));
    if (!all.length) {
        chart.classList.add('clear');
        chart.append(s('path', { d: 'M-9,0 L-3,6 L9,-6', class: 'all-clear' }));
    }

    const radarBox = el('div', { class: 'radar-box' }, el('div', { class: 'sweep', 'aria-hidden': 'true' }));
    radarBox.append(chart);
    radarBox.addEventListener('mouseleave', () => focus(null));

    // --- the headline numbers
    const tiles = el('div', { class: 'tiles' },
        tile(st.spof, 'Single points of failure', 'objects whose loss takes a workload, Service or entry point fully down'),
        tile(st.workloadsAtRisk, 'Workloads exposed', 'go down or cannot come back after one loss'),
        tile(st.servicesAtRisk, 'Services exposed', 'left with no endpoints after one loss'),
        tile(st.entriesAtRisk, 'Entry points exposed', 'Ingresses and HTTPRoutes that stop answering'),
    );

    const legend = el('div', { class: 'legend' },
        el('div', { class: 'faint small legend-title' }, `${all.length} ${all.length === 1 ? 'object' : 'objects'} would break something · worst loss`),
        severityBar(st.bySeverity, true),
        el('div', { class: 'chips' }, ...SEVERITIES.filter((sv) => sv !== 'info' && st.bySeverity[sv] > 0).map((sv) => chip(sv, `${st.bySeverity[sv]} · ${SEVERITY_LABEL[sv]}`))),
    );

    const steps = el('ol', { class: 'steps small' },
        el('li', {}, el('b', {}, 'Pick'), ' a dot, a card, or any object in the pickers above'),
        el('li', {}, el('b', {}, 'See'), ' what breaks, from the object to the front door'),
        el('li', {}, el('b', {}, 'Follow'), ' the chain: anything it reaches can be the next target'),
    );

    idleReadout();
    const hero = el('section', { class: 'hero' },
        el('div', { class: 'hero-radar' }, radarBox, readout, radar.hidden ? el('div', { class: 'faint small' }, `${radar.hidden} smaller ones are left off the radar.`) : null),
        el('div', { class: 'hero-side' },
            el('div', {}, el('h2', {}, 'Where it would hurt most'), el('p', { class: 'dim intro-text' }, 'Every node, claim, ConfigMap, Secret, Service and StorageClass, imagined gone one at a time.')),
            tiles, all.length ? legend : null, steps),
    );

    // --- the ranked list
    const counts = new Map<string, number>();
    for (const i of all) counts.set(i.target.ref.kind, (counts.get(i.target.ref.kind) ?? 0) + 1);
    const filter = el('div', { class: 'filter' },
        filterChip('', `All · ${all.length}`),
        ...SURVEY_KINDS.filter((k) => counts.has(k)).map((k) => filterChip(k, `${kindLabel(k)} · ${counts.get(k)}`)),
    );
    const max = Math.max(1, ...all.map((i) => i.score));
    const list = all.length
        ? el('section', { class: 'ranked' },
            el('div', { class: 'ranked-head' }, el('h3', {}, 'Ranked by impact'), filter),
            el('div', { class: 'hot-grid' }, ...shown.map((impact) => hotCard(impact, all.indexOf(impact) + 1, max, cards, focus))),
          )
        : null;

    replace(main, hero, list);
}

function setHotKind(kind: string): void {
    hotKind = kind;
    renderHotspots();
}

function filterChip(kind: string, text: string): HTMLElement {
    const b = button(text, () => setHotKind(kind), { class: `pill${hotKind === kind ? ' on' : ''}` });
    b.setAttribute('aria-pressed', String(hotKind === kind));
    return b;
}

function polar(angle: number, radius: number): { x: number; y: number } {
    return { x: Math.sin(angle) * radius, y: -Math.cos(angle) * radius };
}

function dotMark(dot: Dot, dots: Map<string, SVGGElement>, focus: (id: string | null) => void): SVGGElement {
    const g = s('g', { class: `dot sev-${dot.severity}`, tabindex: 0, role: 'button', transform: `translate(${(dot.x * R).toFixed(2)},${(dot.y * R).toFixed(2)})` });
    g.setAttribute('aria-label', `${kindLabel(dot.ref.kind)} ${refLabel(dot.ref)}, impact ${dot.score}`);
    g.append(s('title', {}, `${kindLabel(dot.ref.kind)} ${refLabel(dot.ref)} · impact ${dot.score}`));
    const r = dot.size * R;
    g.append(s('circle', { r: r * 1.9, class: 'halo' }), s('circle', { r, class: 'core' }));
    g.addEventListener('mouseenter', () => focus(dot.id));
    g.addEventListener('focus', () => focus(dot.id));
    g.addEventListener('click', () => pick(dot.ref));
    g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick(dot.ref);
        }
    });
    dots.set(dot.id, g);
    return g;
}

function tile(n: number, label: string, hint: string): HTMLElement {
    return el('div', { class: `tile ${n ? 'bad' : 'good'}` },
        el('div', { class: 'tile-n' }, String(n)),
        el('div', { class: 'tile-label' }, label),
        el('div', { class: 'faint small' }, n ? hint : 'none — nice'),
    );
}

/** A bar split by severity, worst first. */
function severityBar(counts: Record<Severity, number>, tall = false): HTMLElement {
    const parts = SEVERITIES.filter((sv) => sv !== 'info' && counts[sv] > 0);
    const bar = el('div', { class: `sevbar${tall ? ' tall' : ''}` });
    for (const sv of parts) {
        const seg = el('span', { class: `sev-${sv}`, title: `${counts[sv]} · ${SEVERITY_LABEL[sv]}` });
        seg.style.flexGrow = String(counts[sv]);
        bar.append(seg);
    }
    if (!parts.length) bar.append(el('span', { class: 'sev-info' }));
    return bar;
}

function hotCard(impact: Impact, rank: number, max: number, cards: Map<string, HTMLElement>, focus: (id: string | null) => void): HTMLElement {
    const t = impact.target;
    const c = consequences(impact);
    const counts = SEVERITIES.filter((sv) => sv !== 'info' && c[sv] > 0);
    const meter = el('div', { class: 'meter', title: 'How much would break, weighted by how badly' }, el('span', {}));
    (meter.firstChild as HTMLElement).style.width = `${Math.max(4, (impact.score / max) * 100)}%`;
    const card = el('button', { type: 'button', class: `hot sev-${impact.verdict.severity ?? 'info'}` },
        el('div', { class: 'hot-head' },
            el('span', { class: 'rank' }, `#${rank}`),
            kindTag(t.ref.kind),
            el('span', { class: 'grow' }),
            el('span', { class: 'score', title: 'How much would break, weighted by how badly' }, String(impact.score)),
        ),
        el('div', { class: 'hot-name' }, refLabel(t.ref)),
        meter,
        el('div', { class: 'hot-text dim' }, impact.verdict.text),
        counts.length ? severityBar(c) : null,
        el('div', { class: 'chips' }, ...counts.map((sv) => chip(sv, `${c[sv]} · ${SEVERITY_LABEL[sv]}`))),
    );
    card.addEventListener('click', () => pick(t.ref));
    card.addEventListener('mouseenter', () => focus(t.id));
    card.addEventListener('mouseleave', () => focus(null));
    cards.set(t.id, card);
    return card;
}

// ----- one target -------------------------------------------------------------------------------

function verdictCard(impact: Impact): HTMLElement {
    const t = impact.target.ref;
    const sev = impact.verdict.severity;
    const actions = el('div', { class: 'actions' });
    if (impact.target.openable) actions.append(button('Open', () => open(t), { class: 'ghost' }));
    return el('section', { class: `verdict sev-${sev ?? 'none'}` },
        el('div', { class: 'verdict-main' },
            el('div', { class: 'scenario' }, impact.scenario),
            el('div', { class: 'verdict-text' }, impact.found ? impact.verdict.text : `${kindLabel(t.kind)} ${refLabel(t)} is not in the cluster.`),
            el('div', { class: 'chips' },
                ...SEVERITIES.map((s) => [s, impact.nodes.filter((n) => n.severity === s).length] as const)
                    .filter(([, n]) => n > 0)
                    .map(([s, n]) => chip(s, `${n} · ${SEVERITY_LABEL[s]}`)),
            ),
        ),
        actions,
    );
}

function graph(impact: Impact): HTMLElement {
    const wrap = el('section', { class: 'graph-wrap' });
    if (!impact.nodes.length) return wrap;
    const columns = [...new Set([0, ...impact.nodes.map((n) => n.column)])].sort();
    const grid = el('div', { class: 'graph' });
    grid.style.gridTemplateColumns = `repeat(${columns.length}, minmax(200px, 1fr))`;
    const cards = new Map<string, HTMLElement>();
    const byId = new Map<string, GraphNode>([[impact.target.id, impact.target], ...impact.nodes.map((n) => [n.id, n] as [string, GraphNode])]);

    for (const col of columns) {
        const inCol = col === 0 ? [impact.target] : impact.nodes.filter((n) => n.column === col).sort(bySeverity);
        const column = el('div', { class: 'col' }, el('div', { class: 'col-head faint small' }, `${COLUMN_LABEL[col]} · ${inCol.length}`));
        for (const node of inCol) {
            const card = nodeCard(node, node === impact.target);
            cards.set(node.id, card);
            column.append(card);
        }
        grid.append(column);
    }

    const lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    lines.setAttribute('class', 'edges');
    wrap.append(lines, grid);

    const draw = (): void => {
        const box = wrap.getBoundingClientRect();
        lines.setAttribute('width', String(wrap.scrollWidth));
        lines.setAttribute('height', String(wrap.scrollHeight));
        lines.replaceChildren();
        for (const edge of impact.edges) {
            const a = cards.get(edge.from)?.getBoundingClientRect();
            const b = cards.get(edge.to)?.getBoundingClientRect();
            if (!a || !b) continue;
            const x1 = a.right - box.left + wrap.scrollLeft;
            const y1 = a.top + a.height / 2 - box.top + wrap.scrollTop;
            const x2 = b.left - box.left + wrap.scrollLeft;
            const y2 = b.top + b.height / 2 - box.top + wrap.scrollTop;
            const dx = Math.max(24, (x2 - x1) / 2);
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
            path.setAttribute('class', `edge sev-${byId.get(edge.to)?.severity ?? 'info'}`);
            path.dataset.from = edge.from;
            path.dataset.to = edge.to;
            lines.append(path);
        }
    };

    // Hovering a card lights the paths through it and dims the rest.
    const related = (id: string): Set<string> => {
        const seen = new Set([id]);
        const walk = (key: 'from' | 'to', other: 'from' | 'to'): void => {
            const queue = [id];
            while (queue.length) {
                const at = queue.pop()!;
                for (const e of impact.edges) {
                    if (e[key] === at && !seen.has(e[other])) {
                        seen.add(e[other]);
                        queue.push(e[other]);
                    }
                }
            }
        };
        walk('from', 'to');
        walk('to', 'from');
        return seen;
    };
    for (const [id, card] of cards) {
        card.addEventListener('mouseenter', () => {
            const lit = related(id);
            wrap.classList.add('focusing');
            for (const [other, c] of cards) c.classList.toggle('lit', lit.has(other));
            for (const p of lines.querySelectorAll('path')) {
                const path = p as SVGPathElement;
                path.classList.toggle('lit', lit.has(path.dataset.from ?? '') && lit.has(path.dataset.to ?? ''));
            }
        });
        card.addEventListener('mouseleave', () => wrap.classList.remove('focusing'));
    }

    requestAnimationFrame(draw);
    const observer = new ResizeObserver(() => draw());
    observer.observe(wrap);
    wrap.addEventListener('scroll', draw, { passive: true });
    stopResize = () => observer.disconnect();
    return wrap;
}

function trimQuiet(impact: Impact): Impact {
    const keep = new Set([impact.target.id, ...impact.nodes.filter((n) => n.severity !== 'info').map((n) => n.id)]);
    return { ...impact, nodes: impact.nodes.filter((n) => keep.has(n.id)), edges: impact.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
}

function bySeverity(a: GraphNode, b: GraphNode): number {
    return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || refLabel(a.ref).localeCompare(refLabel(b.ref));
}

function nodeCard(node: GraphNode, isTarget: boolean): HTMLElement {
    const card = el('div', { class: `node sev-${isTarget ? 'target' : node.severity}`, tabindex: '0' },
        el('div', { class: 'node-head' }, kindTag(node.ref.kind), node.detail ? el('span', { class: 'faint small' }, node.detail) : null),
        el('div', { class: 'node-name', title: refLabel(node.ref) }, isTarget || !node.ref.namespace ? node.ref.name : refLabel(node.ref)),
        node.reason ? el('div', { class: 'node-reason' }, node.reason) : null,
    );
    const foot = el('div', { class: 'node-foot' });
    if (!isTarget && node.targetable) foot.append(button('Its blast radius', () => pick(node.ref), { class: 'link' }));
    if (node.openable) foot.append(button('Open', () => open(node.ref), { class: 'link' }));
    if (foot.childElementCount) card.append(foot);
    return card;
}

function notes(impact: Impact): HTMLElement | null {
    if (!impact.notes.length) return null;
    return el('section', { class: 'notes' }, el('h3', {}, 'Worth knowing'), el('ul', {}, ...impact.notes.map((n) => el('li', {}, n))));
}

function table(impact: Impact): HTMLElement | null {
    if (!impact.nodes.length) return null;
    const rows = [...impact.nodes].sort(bySeverity).map((n) => {
        const name = n.openable ? button(refLabel(n.ref), () => open(n.ref), { class: 'link' }) : el('span', {}, refLabel(n.ref));
        return el('tr', {}, el('td', {}, chip(n.severity)), el('td', {}, kindTag(n.ref.kind)), el('td', {}, name), el('td', { class: 'faint' }, n.detail), el('td', { class: 'dim' }, n.reason));
    });
    return el('section', { class: 'list' },
        el('h3', {}, 'Everything it reaches'),
        el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Effect'), el('th', {}, 'Kind'), el('th', {}, 'Object'), el('th', {}, ''), el('th', {}, 'Why'))), el('tbody', {}, ...rows)),
    );
}

start().catch(showError);
