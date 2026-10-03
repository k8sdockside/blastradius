// What both pages share: errors, the address, and how an object and a
// severity are drawn.

import { el } from '@k8sdockside/plugin-sdk/dom';
import { kindLabel, type Ref } from '../model/kube';
import { SEVERITY_LABEL, type Severity } from '../model/impact';

export function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function showError(err: unknown): void {
    const node = document.getElementById('error');
    if (!node) return;
    node.textContent = message(err);
    node.hidden = false;
}

export function clearError(): void {
    const node = document.getElementById('error');
    if (node) node.hidden = true;
}

// ----- the address: what is picked survives the tab being switched away ------------------

export function readHash(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const pair of location.hash.replace(/^#/, '').split('&')) {
        const cut = pair.indexOf('=');
        if (cut <= 0) continue;
        try {
            out[pair.slice(0, cut)] = decodeURIComponent(pair.slice(cut + 1));
        } catch {
            // A stray % in a hand-edited address is ignored.
        }
    }
    return out;
}

export function writeHash(values: Record<string, string>): void {
    const text = Object.entries(values)
        .filter(([, v]) => v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
    try {
        history.replaceState(null, '', text ? '#' + text : location.pathname);
    } catch {
        try {
            location.hash = text;
        } catch {
            /* kept in memory only */
        }
    }
}

// ----- the hand-over from a panel to the map -------------------------------------------------

export const FOCUS_KEY = 'focus';

export async function handOver(ref: Ref): Promise<void> {
    await k8sdockside.storage?.set(FOCUS_KEY, ref).catch(() => null);
    // The blast radius is the plugin's overview: the page it opens on.
    await k8sdockside.openView('overview');
}

export async function takeHandOver(): Promise<Ref | null> {
    const store = k8sdockside.storage;
    if (!store) return null;
    try {
        const ref = await store.get<Ref>(FOCUS_KEY);
        if (ref) await store.remove(FOCUS_KEY);
        return ref && typeof ref.kind === 'string' && typeof ref.name === 'string' ? { kind: ref.kind, namespace: ref.namespace ?? '', name: ref.name } : null;
    } catch {
        return null;
    }
}

// ----- drawing -------------------------------------------------------------------------------

export function chip(severity: Severity, text: string = SEVERITY_LABEL[severity]): HTMLElement {
    return el('span', { class: `chip sev-${severity}` }, text);
}

export function refLabel(ref: Ref): string {
    return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
}

export function kindTag(kind: string): HTMLElement {
    return el('span', { class: 'kind' }, kindLabel(kind));
}

export function open(ref: Ref): void {
    void k8sdockside.open({ kind: ref.kind, namespace: ref.namespace || undefined, name: ref.name }).catch(showError);
}

export function when(): string {
    const now = new Date();
    return k8sdockside.format?.time(now) ?? now.toLocaleTimeString();
}

/** The plugin's mark, drawn inline so it follows the theme. A constant, never cluster data. */
export const LOGO = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".35"/><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".65"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`;
