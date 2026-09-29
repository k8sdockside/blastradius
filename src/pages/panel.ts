// The Blast radius panel in an object's detail view: the verdict, the worst
// of what it reaches, and a way into the full map.

import { button, byId, el, replace } from '@k8sdockside/plugin-sdk/dom';
import { SEVERITIES, SEVERITY_LABEL, blastRadius } from '../model/impact';
import type { Ref } from '../model/kube';
import { chip, handOver, kindTag, open, refLabel, showError } from '../ui/common';
import { loadSnapshot } from '../ui/load';

const SHOWN = 6;

async function start(): Promise<void> {
    const ctx = await k8sdockside.ready();
    if (!ctx.object) return;
    const target: Ref = { kind: ctx.object.kind, namespace: ctx.object.namespace, name: ctx.object.name };
    const { snap } = await loadSnapshot();
    const impact = blastRadius(snap, target);
    const worst = [...impact.nodes]
        .filter((n) => n.severity !== 'info')
        .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));

    const rows = worst.slice(0, SHOWN).map((n) =>
        el('li', { class: 'row' },
            chip(n.severity),
            kindTag(n.ref.kind),
            n.openable ? button(refLabel(n.ref), () => open(n.ref), { class: 'link' }) : el('span', {}, refLabel(n.ref)),
            el('span', { class: 'dim small grow' }, n.reason),
        ),
    );
    const more = worst.length - SHOWN;
    const quiet = impact.nodes.length - worst.length;

    replace(
        byId('main'),
        el('div', { class: `verdict compact sev-${impact.verdict.severity ?? 'none'}` },
            el('div', { class: 'verdict-main' },
                el('div', { class: 'scenario' }, impact.scenario),
                el('div', { class: 'verdict-text' }, impact.verdict.text),
                el('div', { class: 'chips' },
                    ...SEVERITIES.map((s) => [s, impact.nodes.filter((n) => n.severity === s).length] as const)
                        .filter(([, n]) => n > 0)
                        .map(([s, n]) => chip(s, `${n} · ${SEVERITY_LABEL[s]}`)),
                ),
            ),
            el('div', { class: 'actions' }, button('Open the map', () => void handOver(target).catch(showError))),
        ),
        rows.length ? el('ul', { class: 'rows' }, ...rows) : null,
        more > 0 || quiet > 0
            ? el('p', { class: 'faint small' }, [more > 0 ? `${more} more` : '', quiet > 0 ? `${quiet} touched but unaffected` : ''].filter(Boolean).join(' · ') + ' — on the map.')
            : null,
        impact.notes.length ? el('ul', { class: 'notes-small dim small' }, ...impact.notes.map((n) => el('li', {}, n))) : null,
    );
}

start().catch(showError);
