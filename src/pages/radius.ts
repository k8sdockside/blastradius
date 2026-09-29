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
} from '../model/impact';
import { LOGO, chip, clearError, kindTag, open, readHash, refLabel, showError, takeHandOver, when, writeHash } from '../ui/common';
import { loadSnapshot } from '../ui/load';

let snap: Snapshot | null = null;
let index: Index | null = null;
let target: Ref | null = null;
let pickKind: string = 'nodes';
let pickNs = '';
let stopResize: (() => void) | null = null;
let showQuiet = false;

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

// ----- hotspots -------------------------------------------------------------------------------

function renderHotspots(): void {
    const top = hotspots(snap!, 12);
    replace(
        main,
        el('section', { class: 'intro' },
            el('h2', {}, 'Where it would hurt most'),
            el('p', { class: 'dim' }, 'Every node, claim, ConfigMap, Secret, Service and StorageClass, imagined gone one at a time, ranked by what would break. Pick one to see the whole blast, or choose any object above.'),
        ),
        top.length
            ? el('div', { class: 'hot-grid' }, ...top.map(hotCard))
            : el('p', { class: 'empty' }, 'Nothing here would take anything else down with it.'),
    );
}

function hotCard(impact: Impact): HTMLElement {
    const t = impact.target;
    const counts = SEVERITIES.filter((s) => s !== 'info')
        .map((s) => [s, impact.nodes.filter((n) => n.severity === s && n.column >= 2).length] as const)
        .filter(([, n]) => n > 0);
    const card = el('button', { type: 'button', class: `hot sev-${impact.verdict.severity ?? 'info'}` },
        el('div', { class: 'hot-head' }, kindTag(t.ref.kind), el('span', { class: 'score', title: 'How much would break, weighted by how badly' }, String(impact.score))),
        el('div', { class: 'hot-name' }, refLabel(t.ref)),
        el('div', { class: 'hot-text dim' }, impact.verdict.text),
        el('div', { class: 'chips' }, ...counts.map(([s, n]) => chip(s, `${n} · ${SEVERITY_LABEL[s]}`))),
    );
    card.addEventListener('click', () => pick(t.ref));
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
