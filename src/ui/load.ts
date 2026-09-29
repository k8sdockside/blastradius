// Reads the snapshot every impact is worked out from.

import { HTTPROUTES, emptySnapshot, type Obj, type Snapshot } from '../model/kube';

const KINDS: [keyof Snapshot, string][] = [
    ['pods', 'pods'],
    ['replicasets', 'replicasets'],
    ['deployments', 'deployments'],
    ['statefulsets', 'statefulsets'],
    ['daemonsets', 'daemonsets'],
    ['jobs', 'jobs'],
    ['cronjobs', 'cronjobs'],
    ['services', 'services'],
    ['ingresses', 'ingresses'],
    ['httproutes', HTTPROUTES],
    ['pvcs', 'persistentvolumeclaims'],
    ['pvs', 'persistentvolumes'],
    ['storageclasses', 'storageclasses'],
    ['configmaps', 'configmaps'],
    ['nodes', 'nodes'],
    ['pdbs', 'poddisruptionbudgets'],
    ['serviceaccounts', 'serviceaccounts'],
];

/** Kinds the cluster would not give: missing (Gateway API not installed) or refused (RBAC). */
export interface Loaded {
    snap: Snapshot;
    missing: string[];
}

/**
 * Every kind at once. One that fails is left empty rather than failing the
 * whole read -- a cluster without the Gateway API has no HTTPRoutes, and that
 * is not an error -- but pods failing is, since nothing works without them.
 */
export async function loadSnapshot(): Promise<Loaded> {
    const snap = emptySnapshot();
    const missing: string[] = [];
    await Promise.all(
        KINDS.map(async ([field, kind]) => {
            try {
                (snap[field] as Obj[]) = await k8sdockside.list<K8sDockside.KubeObject>({ kind }) as Obj[];
            } catch (err) {
                if (field === 'pods') throw err;
                if (kind !== HTTPROUTES) missing.push(kind);
            }
        }),
    );
    return { snap, missing };
}
