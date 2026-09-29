// What fails if one object goes away.
//
// The impact is worked out in four steps, each feeding the next, which is
// also how the graph is drawn left to right:
//
//   1. the pods the target touches, each with a fate -- it goes and comes
//      back elsewhere, it goes for good, it cannot start again, it keeps
//      running but will not survive a restart, or it is touched and fine;
//   2. the workloads those pods belong to, judged by how many of their pods
//      are hit;
//   3. the Services selecting those pods, judged by how many endpoints are left;
//   4. the Ingresses and HTTPRoutes sending traffic to those Services.
//
// Everything is read from one snapshot of the cluster, so the answer is what
// would happen now, not a prediction of the scheduler: a pod that "moves" is
// one a controller will recreate, not a promise that another node has room.

import {
    APP_KIND,
    CLUSTER_SCOPED,
    HTTPROUTES,
    OPENABLE,
    TARGET_KINDS,
    kindLabel,
    live,
    refKey,
    type Container,
    type Obj,
    type Pod,
    type Ref,
    type Snapshot,
    type Volume,
    type Workload,
} from './kube';
import { matches, matchesMap } from './selector';

export type Severity = 'down' | 'stuck' | 'degraded' | 'restart' | 'info';

/** Worst first. */
export const SEVERITIES: Severity[] = ['down', 'stuck', 'degraded', 'restart', 'info'];

export const SEVERITY_LABEL: Record<Severity, string> = {
    down: 'Goes down',
    stuck: 'Cannot come back',
    degraded: 'Loses capacity',
    restart: 'Breaks on restart',
    info: 'Touched, keeps working',
};

const WEIGHT: Record<Severity, number> = { down: 10, stuck: 8, degraded: 4, restart: 2, info: 0 };

export function worst(a: Severity, b: Severity): Severity {
    return SEVERITIES.indexOf(a) <= SEVERITIES.indexOf(b) ? a : b;
}

/** What happens to one pod. */
export type Fate = 'moves' | 'lost' | 'stuck' | 'fragile' | 'info';

interface PodHit {
    pod: Pod;
    fate: Fate;
    reason: string;
    /** The graph node the hit comes through: the target, or a claim in between. */
    via: string;
}

/** Columns of the graph, left to right. */
export type Column = 0 | 1 | 2 | 3 | 4;
export const COLUMN_LABEL = ['Target', 'Through', 'Workloads', 'Services', 'Entry points'];

export interface GraphNode {
    id: string;
    ref: Ref;
    column: Column;
    severity: Severity;
    reason: string;
    /** A short count: `2 of 3 pods`, `1 of 4 endpoints`. */
    detail: string;
    /** Whether the app can open it for this plugin. */
    openable: boolean;
    /** Whether it can be made the target in its turn. */
    targetable: boolean;
}

export interface Edge {
    from: string;
    to: string;
}

export interface Impact {
    target: GraphNode;
    /** Whether the target was found in the snapshot at all. */
    found: boolean;
    /** What is being imagined: "If node pve2 fails or is drained". */
    scenario: string;
    nodes: GraphNode[];
    edges: Edge[];
    notes: string[];
    verdict: { severity: Severity | null; text: string };
    /** How much it hurts, for ranking targets against each other. */
    score: number;
}

// ----- the index ------------------------------------------------------------------

interface Owner {
    /** Groups the pods of one workload. */
    key: string;
    ref: Ref;
    static: boolean;
}

/** Lookups built once per snapshot and shared by every target worked out from it. */
export class Index {
    readonly livePods: Pod[];
    private readonly rs = new Map<string, Workload>();
    private readonly jobs = new Map<string, Workload>();
    private readonly owners = new Map<Pod, Owner | null>();
    private readonly byOwner = new Map<string, Pod[]>();

    constructor(readonly snap: Snapshot) {
        this.livePods = snap.pods.filter(live);
        for (const rs of snap.replicasets) this.rs.set(nsName(rs), rs);
        for (const job of snap.jobs) this.jobs.set(nsName(job), job);
        for (const pod of this.livePods) {
            const owner = this.owner(pod);
            const key = owner?.key ?? podKey(pod);
            const list = this.byOwner.get(key);
            if (list) list.push(pod);
            else this.byOwner.set(key, [pod]);
        }
    }

    /** The workload a pod belongs to, followed up past ReplicaSets and Jobs; null for a bare pod. */
    owner(pod: Pod): Owner | null {
        if (this.owners.has(pod)) return this.owners.get(pod) ?? null;
        const found = this.findOwner(pod);
        this.owners.set(pod, found);
        return found;
    }

    /** The live pods of an owner key (or the one pod, for a bare pod's key). */
    podsOf(key: string): Pod[] {
        return this.byOwner.get(key) ?? [];
    }

    private findOwner(pod: Pod): Owner | null {
        const refs = pod.metadata.ownerReferences ?? [];
        const ctrl = refs.find((r) => r.controller) ?? refs[0];
        if (!ctrl) return null;
        const ns = pod.metadata.namespace ?? '';
        if (ctrl.kind === 'Node') {
            // A static pod: the kubelet runs it from a file, one per node,
            // named <component>-<node>. The other nodes' copies are its peers.
            const node = pod.spec?.nodeName ?? '';
            const name = pod.metadata.name;
            const component = node && name.endsWith('-' + node) ? name.slice(0, -node.length - 1) : name;
            return { key: `static/${ns}/${component}`, ref: { kind: 'pods', namespace: ns, name }, static: true };
        }
        let kind = ctrl.kind;
        let name = ctrl.name;
        if (kind === 'ReplicaSet') {
            const up = controllerOf(this.rs.get(`${ns}/${name}`));
            if (up?.kind === 'Deployment') ({ kind, name } = up);
        } else if (kind === 'Job') {
            const up = controllerOf(this.jobs.get(`${ns}/${name}`));
            if (up?.kind === 'CronJob') ({ kind, name } = up);
        }
        const appKind = APP_KIND[kind] ?? kind;
        return { key: `${appKind}/${ns}/${name}`, ref: { kind: appKind, namespace: ns, name }, static: false };
    }
}

function controllerOf(obj: Obj | undefined): { kind: string; name: string } | undefined {
    const refs = obj?.metadata.ownerReferences ?? [];
    return refs.find((r) => r.controller) ?? refs[0];
}

function nsName(obj: Obj): string {
    return `${obj.metadata.namespace ?? ''}/${obj.metadata.name}`;
}

function podKey(pod: Pod): string {
    return `pods/${pod.metadata.namespace ?? ''}/${pod.metadata.name}`;
}

function plural(n: number, one: string, many = one + 's'): string {
    return `${n} ${n === 1 ? one : many}`;
}

// ----- what can be picked -----------------------------------------------------------

/**
 * The objects of a kind that can be a target. Secrets are never read: their
 * names come from what pods and Ingresses say they use, which is also the
 * only way a Secret can have a blast radius here.
 */
export function candidates(snap: Snapshot, kind: string): Ref[] {
    const out = (objs: Obj[]): Ref[] =>
        objs.map((o) => ({ kind, namespace: CLUSTER_SCOPED.has(kind) ? '' : (o.metadata.namespace ?? ''), name: o.metadata.name }));
    switch (kind) {
        case 'nodes':
            return out(snap.nodes);
        case 'persistentvolumeclaims':
            return out(snap.pvcs);
        case 'persistentvolumes':
            return out(snap.pvs);
        case 'storageclasses':
            return out(snap.storageclasses);
        case 'configmaps':
            return out(snap.configmaps);
        case 'services':
            return out(snap.services);
        case 'serviceaccounts':
            return out(snap.serviceaccounts);
        case 'deployments':
            return out(snap.deployments);
        case 'statefulsets':
            return out(snap.statefulsets);
        case 'daemonsets':
            return out(snap.daemonsets);
        case 'secrets':
            return secretNames(snap);
        default:
            return [];
    }
}

function secretNames(snap: Snapshot): Ref[] {
    const seen = new Map<string, Ref>();
    const add = (namespace: string, name: string | undefined): void => {
        if (name) seen.set(`${namespace}/${name}`, { kind: 'secrets', namespace, name });
    };
    for (const pod of snap.pods) {
        const ns = pod.metadata.namespace ?? '';
        for (const use of podUses(pod, 'secret')) add(ns, use.name);
    }
    for (const ing of snap.ingresses) {
        for (const tls of ing.spec?.tls ?? []) add(ing.metadata.namespace ?? '', tls.secretName);
    }
    return [...seen.values()];
}

// ----- how a pod uses a ConfigMap or a Secret ------------------------------------------

interface Use {
    name: string;
    optional: boolean;
    how: string;
}

function mountPath(pod: Pod, volume: string): string {
    for (const c of allContainers(pod)) {
        const mount = (c.volumeMounts ?? []).find((m) => m.name === volume);
        if (mount) return mount.mountPath;
    }
    return '';
}

function allContainers(pod: Pod): Container[] {
    return [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])];
}

/** Every way a pod names a ConfigMap or a Secret. */
export function podUses(pod: Pod, what: 'configmap' | 'secret'): Use[] {
    const uses: Use[] = [];
    const mounted = (v: Volume, how: string): string => {
        const path = mountPath(pod, v.name);
        return path ? `${how} at ${path}` : `${how} (volume ${v.name}, not mounted)`;
    };
    for (const v of pod.spec?.volumes ?? []) {
        if (what === 'configmap' && v.configMap?.name) {
            uses.push({ name: v.configMap.name, optional: !!v.configMap.optional, how: mounted(v, 'mounts it') });
        }
        if (what === 'secret' && v.secret?.secretName) {
            uses.push({ name: v.secret.secretName, optional: !!v.secret.optional, how: mounted(v, 'mounts it') });
        }
        for (const src of v.projected?.sources ?? []) {
            const ref = what === 'configmap' ? src.configMap : src.secret;
            if (ref?.name) uses.push({ name: ref.name, optional: !!ref.optional, how: mounted(v, 'projects it') });
        }
    }
    for (const c of allContainers(pod)) {
        for (const env of c.env ?? []) {
            const ref = what === 'configmap' ? env.valueFrom?.configMapKeyRef : env.valueFrom?.secretKeyRef;
            if (ref?.name) uses.push({ name: ref.name, optional: !!ref.optional, how: `reads ${ref.key ?? 'a key'} into $${env.name}` });
        }
        for (const from of c.envFrom ?? []) {
            const ref = what === 'configmap' ? from.configMapRef : from.secretRef;
            if (ref?.name) uses.push({ name: ref.name, optional: !!ref.optional, how: `loads every key as environment in ${c.name}` });
        }
    }
    if (what === 'secret') {
        for (const pull of pod.spec?.imagePullSecrets ?? []) {
            uses.push({ name: pull.name, optional: false, how: 'pulls its images with it' });
        }
    }
    return uses;
}

// ----- the worker ----------------------------------------------------------------------

class Builder {
    readonly nodes = new Map<string, GraphNode>();
    readonly edges = new Map<string, Edge>();
    readonly notes: string[] = [];
    readonly hits = new Map<string, PodHit>();

    constructor(
        readonly idx: Index,
        readonly target: GraphNode,
    ) {}

    node(ref: Ref, column: Column, severity: Severity, reason: string, detail = ''): GraphNode {
        const id = refKey(ref);
        const have = this.nodes.get(id);
        if (have) {
            if (worst(have.severity, severity) !== have.severity) {
                have.severity = severity;
                have.reason = reason;
                if (detail) have.detail = detail;
            }
            return have;
        }
        const made: GraphNode = {
            id,
            ref,
            column,
            severity,
            reason,
            detail,
            openable: OPENABLE.has(ref.kind),
            targetable: (TARGET_KINDS as readonly string[]).includes(ref.kind),
        };
        this.nodes.set(id, made);
        return made;
    }

    edge(from: string, to: string): void {
        if (from !== to) this.edges.set(`${from}>${to}`, { from, to });
    }

    /** Records a pod's fate, keeping the worse one when two paths reach it. */
    hit(pod: Pod, fate: Fate, reason: string, via = this.target.id): void {
        const key = podKey(pod);
        const have = this.hits.get(key);
        const order: Fate[] = ['lost', 'stuck', 'moves', 'fragile', 'info'];
        if (have && order.indexOf(have.fate) <= order.indexOf(fate)) return;
        this.hits.set(key, { pod, fate, reason, via });
    }
}

/** Works out what fails if `target` goes away. */
export function blastRadius(snap: Snapshot, target: Ref, idx = new Index(snap)): Impact {
    const t: GraphNode = {
        id: refKey(target),
        ref: target,
        column: 0,
        severity: 'down',
        reason: '',
        detail: '',
        openable: OPENABLE.has(target.kind),
        targetable: true,
    };
    const b = new Builder(idx, t);
    let found = true;
    let scenario = `If ${kindLabel(target.kind)} ${target.name} is deleted`;

    switch (target.kind) {
        case 'nodes':
            found = snap.nodes.some((n) => n.metadata.name === target.name);
            scenario = `If node ${target.name} fails or is drained`;
            nodeHits(b, target.name);
            break;
        case 'persistentvolumeclaims':
            found = snap.pvcs.some((p) => sameRef(p, target));
            claimHits(b, target.namespace, target.name, t.id);
            break;
        case 'persistentvolumes':
            found = snap.pvs.some((p) => p.metadata.name === target.name);
            volumeHits(b, target.name);
            break;
        case 'storageclasses':
            found = snap.storageclasses.some((s) => s.metadata.name === target.name);
            classHits(b, target.name);
            break;
        case 'configmaps':
            found = snap.configmaps.some((c) => sameRef(c, target));
            referenceHits(b, 'configmap', target);
            break;
        case 'secrets':
            // Never read, so "found" means something refers to it.
            found = secretNames(snap).some((r) => r.namespace === target.namespace && r.name === target.name);
            referenceHits(b, 'secret', target);
            break;
        case 'services':
            found = snap.services.some((s) => sameRef(s, target));
            serviceHits(b, target);
            break;
        case 'serviceaccounts':
            found = snap.serviceaccounts.some((s) => sameRef(s, target));
            accountHits(b, target);
            break;
        case 'deployments':
        case 'statefulsets':
        case 'daemonsets':
            found = workloadsOf(snap, target.kind).some((w) => sameRef(w, target));
            workloadHits(b, target);
            break;
    }

    const workloadIds = aggregateWorkloads(b);
    const serviceSeverity = aggregateServices(b, workloadIds);
    if (target.kind === 'services') serviceSeverity.set(`${target.namespace}/${target.name}`, { severity: 'down', id: t.id });
    entryPoints(b, serviceSeverity);

    const nodes = [...b.nodes.values()].filter((n) => n.id !== t.id);
    const score = nodes.reduce((sum, n) => sum + WEIGHT[n.severity], 0);
    return {
        target: t,
        found,
        scenario,
        nodes,
        edges: [...b.edges.values()].filter((e) => e.from === t.id || b.nodes.has(e.from)),
        notes: b.notes,
        verdict: verdict(nodes),
        score,
    };
}

function sameRef(obj: Obj, ref: Ref): boolean {
    return obj.metadata.name === ref.name && (obj.metadata.namespace ?? '') === ref.namespace;
}

function workloadsOf(snap: Snapshot, kind: string): Workload[] {
    if (kind === 'deployments') return snap.deployments;
    if (kind === 'statefulsets') return snap.statefulsets;
    return snap.daemonsets;
}

// ----- step 1, per kind: which pods, and how ---------------------------------------------

function nodeHits(b: Builder, nodeName: string): void {
    const snap = b.idx.snap;
    const node = snap.nodes.find((n) => n.metadata.name === nodeName);
    const hostname = node?.metadata.labels?.['kubernetes.io/hostname'] ?? nodeName;
    if (node?.spec?.unschedulable) b.notes.push(`${nodeName} is already cordoned: nothing new is scheduled on it.`);
    const onNode = b.idx.livePods.filter((p) => p.spec?.nodeName === nodeName);
    if (!onNode.length) b.notes.push(`No running pods are on ${nodeName}.`);
    for (const pod of onNode) {
        const owner = b.idx.owner(pod);
        const pinned = pinnedVolume(snap, pod, nodeName, hostname);
        if (owner?.static) b.hit(pod, 'lost', 'a static pod: it only ever runs on this node');
        else if (owner?.ref.kind === 'daemonsets') b.hit(pod, 'info', 'runs on every node; it goes with this one');
        else if (pinned) b.hit(pod, 'stuck', `its volume ${pinned} lives on this node, so it cannot start anywhere else`);
        else if (!owner) b.hit(pod, 'lost', 'a bare pod: nothing starts it again');
        else b.hit(pod, 'moves', 'recreated on another node');
    }
    drainNotes(b, onNode);
}

/** The name of a volume a pod uses that can only be reached on this node, if any. */
function pinnedVolume(snap: Snapshot, pod: Pod, nodeName: string, hostname: string): string {
    const ns = pod.metadata.namespace ?? '';
    for (const v of pod.spec?.volumes ?? []) {
        const claim = v.persistentVolumeClaim?.claimName;
        if (!claim) continue;
        const pvc = snap.pvcs.find((p) => p.metadata.name === claim && (p.metadata.namespace ?? '') === ns);
        const pv = snap.pvs.find((p) => p.metadata.name === pvc?.spec?.volumeName);
        const terms = pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? [];
        // Pinned when every term the volume allows asks for this node by name.
        const pinned =
            terms.length > 0 &&
            terms.every((term) =>
                (term.matchExpressions ?? []).some(
                    (e) =>
                        e.operator === 'In' &&
                        (e.values ?? []).length > 0 &&
                        (e.values ?? []).every((val) => val === hostname || val === nodeName),
                ),
            );
        if (pinned) return pv?.metadata.name ?? claim;
    }
    return '';
}

function drainNotes(b: Builder, onNode: Pod[]): void {
    for (const pdb of b.idx.snap.pdbs) {
        const ns = pdb.metadata.namespace ?? '';
        const here = onNode.filter((p) => (p.metadata.namespace ?? '') === ns && matches(pdb.spec?.selector, p.metadata.labels));
        if (!here.length) continue;
        const allowed = pdb.status?.disruptionsAllowed ?? 0;
        if (here.length > allowed) {
            b.notes.push(
                `A drain would wait on PodDisruptionBudget ${ns}/${pdb.metadata.name}: it allows ${plural(allowed, 'disruption')} now, and ${plural(here.length, 'of its pods is', 'of its pods are')} on this node. A node that fails does not ask.`,
            );
        }
    }
}

function claimHits(b: Builder, ns: string, claim: string, via: string): number {
    const snap = b.idx.snap;
    let count = 0;
    for (const pod of b.idx.livePods) {
        if ((pod.metadata.namespace ?? '') !== ns) continue;
        const vol = (pod.spec?.volumes ?? []).find((v) => v.persistentVolumeClaim?.claimName === claim);
        if (!vol) continue;
        const path = mountPath(pod, vol.name);
        b.hit(pod, 'fragile', `keeps the claim while it runs${path ? ` (at ${path})` : ''}, but cannot start again once it is gone`, via);
        count++;
    }
    if (via !== b.target.id) return count;

    // Only for a claim that is the target itself: what happens to its data.
    const pvc = snap.pvcs.find((p) => p.metadata.name === claim && (p.metadata.namespace ?? '') === ns);
    const pv = snap.pvs.find((p) => p.metadata.name === pvc?.spec?.volumeName);
    if (count) {
        b.notes.push(`Kubernetes holds a claim that pods use (the pvc-protection finalizer): it is removed only once ${plural(count, 'pod lets', 'pods let')} go of it.`);
    }
    if (pv) {
        const policy = pv.spec?.persistentVolumeReclaimPolicy ?? 'Delete';
        b.notes.push(
            policy === 'Delete'
                ? `Its volume ${pv.metadata.name} has reclaim policy Delete: the data is deleted with the claim.`
                : `Its volume ${pv.metadata.name} has reclaim policy ${policy}: the data is kept, but nothing binds to it again on its own.`,
        );
    }
    for (const sts of snap.statefulsets) {
        if ((sts.metadata.namespace ?? '') !== ns) continue;
        for (const tpl of sts.spec?.volumeClaimTemplates ?? []) {
            const prefix = `${tpl.metadata?.name ?? ''}-${sts.metadata.name}-`;
            if (claim.startsWith(prefix) && /^\d+$/.test(claim.slice(prefix.length))) {
                b.notes.push(`StatefulSet ${sts.metadata.name} made this claim from a template, and would make it again, empty, for pod ${sts.metadata.name}-${claim.slice(prefix.length)}.`);
            }
        }
    }
    return count;
}

function volumeHits(b: Builder, pvName: string): void {
    const snap = b.idx.snap;
    const pv = snap.pvs.find((p) => p.metadata.name === pvName);
    const claim = pv?.spec?.claimRef;
    if (!pv || !claim?.name) {
        b.notes.push(`${pvName} is not bound to a claim: nothing uses it.`);
        return;
    }
    const pvcRef: Ref = { kind: 'persistentvolumeclaims', namespace: claim.namespace ?? '', name: claim.name };
    const pvcNode = b.node(pvcRef, 1, 'restart', 'bound to it: loses its data');
    b.edge(b.target.id, pvcNode.id);
    const n = claimHits(b, pvcRef.namespace, pvcRef.name, pvcNode.id);
    pvcNode.detail = plural(n, 'pod');
    const policy = pv.spec?.persistentVolumeReclaimPolicy ?? 'Delete';
    b.notes.push(`Kubernetes holds a volume that is bound (the pv-protection finalizer) until its claim lets go. Reclaim policy: ${policy}.`);
}

function classHits(b: Builder, className: string): void {
    const snap = b.idx.snap;
    const sc = snap.storageclasses.find((s) => s.metadata.name === className);
    const isDefault = sc?.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true';
    b.notes.push('Volumes already made keep working: a StorageClass is read when a volume is made or expanded, not while it is used.');
    if (isDefault) b.notes.push(`${className} is the default class: new claims that name no class would stay Pending too.`);
    for (const pvc of snap.pvcs) {
        if (pvc.spec?.storageClassName !== className) continue;
        const ref: Ref = { kind: 'persistentvolumeclaims', namespace: pvc.metadata.namespace ?? '', name: pvc.metadata.name };
        const bound = !!pvc.spec?.volumeName;
        const node = b.node(ref, 1, bound ? 'info' : 'stuck', bound ? 'bound already; cannot be expanded' : 'not bound yet: stays Pending');
        b.edge(b.target.id, node.id);
        for (const pod of b.idx.livePods) {
            if ((pod.metadata.namespace ?? '') !== ref.namespace) continue;
            if ((pod.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === ref.name)) {
                b.hit(pod, bound ? 'info' : 'fragile', bound ? 'its volume keeps working' : 'waits for a volume that will not be made', node.id);
            }
        }
    }
    for (const sts of snap.statefulsets) {
        const uses = (sts.spec?.volumeClaimTemplates ?? []).some(
            (tpl) => tpl.spec?.storageClassName === className || (isDefault && !tpl.spec?.storageClassName),
        );
        if (!uses) continue;
        const ref: Ref = { kind: 'statefulsets', namespace: sts.metadata.namespace ?? '', name: sts.metadata.name };
        const node = b.node(ref, 2, 'restart', 'a new replica would wait forever for its claim');
        b.edge(b.target.id, node.id);
    }
}

function referenceHits(b: Builder, what: 'configmap' | 'secret', target: Ref): void {
    const rootCA = what === 'configmap' && target.name === 'kube-root-ca.crt';
    if (rootCA) b.notes.push('kube-controller-manager puts kube-root-ca.crt back in every namespace within moments, so deleting it heals itself.');
    else b.notes.push('Running pods keep what they read when they started; a mounted copy stops updating. They fail when they are next started.');
    for (const pod of b.idx.livePods) {
        if ((pod.metadata.namespace ?? '') !== target.namespace) continue;
        const uses = podUses(pod, what).filter((u) => u.name === target.name);
        if (!uses.length) continue;
        const required = uses.find((u) => !u.optional);
        if (rootCA) b.hit(pod, 'info', (required ?? uses[0])!.how);
        else if (required) b.hit(pod, 'fragile', required.how);
        else b.hit(pod, 'info', `${uses[0]!.how} (optional)`);
    }
    if (what !== 'secret') return;
    for (const ing of b.idx.snap.ingresses) {
        if ((ing.metadata.namespace ?? '') !== target.namespace) continue;
        const tls = (ing.spec?.tls ?? []).filter((t) => t.secretName === target.name);
        if (!tls.length) continue;
        const hosts = tls.flatMap((t) => t.hosts ?? []);
        const ref: Ref = { kind: 'ingresses', namespace: target.namespace, name: ing.metadata.name };
        const node = b.node(ref, 4, 'degraded', `its certificate${hosts.length ? ` for ${hosts.join(', ')}` : ''}: the controller falls back to its default one`);
        b.edge(b.target.id, node.id);
    }
}

function serviceHits(b: Builder, target: Ref): void {
    const snap = b.idx.snap;
    const svc = snap.services.find((s) => sameRef(s, target));
    b.notes.push(`Anything calling ${target.name}.${target.namespace} by name stops resolving. Nothing in the cluster records who does, so those callers are not shown.`);
    if (svc?.spec?.type === 'LoadBalancer') b.notes.push('It is a LoadBalancer: its external address is given back, and may not be the same one if it is made again.');
    for (const sts of snap.statefulsets) {
        if ((sts.metadata.namespace ?? '') !== target.namespace || sts.spec?.serviceName !== target.name) continue;
        const ref: Ref = { kind: 'statefulsets', namespace: target.namespace, name: sts.metadata.name };
        const node = b.node(ref, 2, 'degraded', `its pods' own DNS names (${sts.metadata.name}-0.${target.name}) stop resolving`);
        b.edge(b.target.id, node.id);
    }
}

function accountHits(b: Builder, target: Ref): void {
    const sa = b.idx.snap.serviceaccounts.find((s) => sameRef(s, target));
    for (const pod of b.idx.livePods) {
        if ((pod.metadata.namespace ?? '') !== target.namespace) continue;
        if ((pod.spec?.serviceAccountName ?? 'default') !== target.name) continue;
        const token = pod.spec?.automountServiceAccountToken ?? sa?.automountServiceAccountToken ?? true;
        b.hit(pod, 'fragile', token ? 'its API token stops working now, and a new pod is refused' : 'a new pod is refused');
    }
    if (target.name === 'default') b.notes.push('The default ServiceAccount is made again by kube-controller-manager, but with a new identity: tokens issued for the old one stay invalid.');
}

function workloadHits(b: Builder, target: Ref): void {
    const key = refKey(target);
    for (const pod of b.idx.podsOf(key)) b.hit(pod, 'lost', 'deleted with it');
    if (target.kind === 'statefulsets') b.notes.push('Its PersistentVolumeClaims stay behind unless its persistentVolumeClaimRetentionPolicy says otherwise.');
}

// ----- step 2: workloads -------------------------------------------------------------------

const HARD: Fate[] = ['moves', 'lost', 'stuck'];

/** Groups the hit pods by workload and judges each. Returns the graph node id each hit pod is drawn under. */
function aggregateWorkloads(b: Builder): Map<string, string> {
    const groups = new Map<string, { owner: Owner | null; hits: PodHit[] }>();
    for (const hit of b.hits.values()) {
        const owner = b.idx.owner(hit.pod);
        const key = owner?.key ?? podKey(hit.pod);
        const group = groups.get(key);
        if (group) group.hits.push(hit);
        else groups.set(key, { owner, hits: [hit] });
    }

    const drawnUnder = new Map<string, string>();
    for (const [key, { owner, hits }] of groups) {
        // The target's own pods are drawn as the target.
        if (key === b.target.id) {
            for (const hit of hits) drawnUnder.set(podKey(hit.pod), b.target.id);
            continue;
        }
        const total = Math.max(b.idx.podsOf(key).length, hits.length);
        const hard = hits.filter((h) => HARD.includes(h.fate));
        const stuck = hits.filter((h) => h.fate === 'stuck');
        const lost = hits.filter((h) => h.fate === 'lost');
        const fragile = hits.filter((h) => h.fate === 'fragile');
        const left = total - hard.length;

        let severity: Severity;
        let reason: string;
        let detail = `${hard.length || hits.length} of ${plural(total, 'pod')}`;
        if (hard.length) {
            const sample = (stuck[0] ?? lost[0] ?? hard[0])!.reason;
            if (left <= 0) {
                severity = 'down';
                reason = stuck.length || lost.length ? sample : 'every pod goes, until they are started elsewhere';
            } else {
                severity = stuck.length ? 'stuck' : 'degraded';
                reason = `${sample}; ${plural(left, 'pod keeps', 'pods keep')} running`;
            }
            if (owner?.static) {
                const peers = total;
                severity = peers > 1 ? 'degraded' : 'down';
                reason = peers > 1 ? `a static pod; ${plural(peers - 1, 'other node keeps', 'other nodes keep')} a copy` : 'a static pod, and the only copy';
                detail = `1 of ${plural(peers, 'copy', 'copies')}`;
            }
        } else if (fragile.length) {
            severity = 'restart';
            reason = fragile[0]!.reason;
            detail = `${fragile.length} of ${plural(total, 'pod')}`;
        } else {
            severity = 'info';
            reason = hits[0]!.reason;
        }

        const ref = owner?.ref ?? { kind: 'pods', namespace: hits[0]!.pod.metadata.namespace ?? '', name: hits[0]!.pod.metadata.name };
        const staticKey = owner?.static ? { ...ref, name: key.split('/').slice(2).join('/') + ' (static)' } : null;
        const node = b.node(staticKey ?? ref, 2, severity, reason, detail);
        if (staticKey) {
            // Open the pod itself: the static group has no object of its own.
            node.ref = ref;
            node.targetable = false;
        }
        for (const hit of hits) {
            drawnUnder.set(podKey(hit.pod), node.id);
            b.edge(hit.via, node.id);
        }
    }
    return drawnUnder;
}

// ----- step 3: services -------------------------------------------------------------------

interface Hurt {
    severity: Severity;
    id: string;
}

function aggregateServices(b: Builder, drawnUnder: Map<string, string>): Map<string, Hurt> {
    const out = new Map<string, Hurt>();
    for (const svc of b.idx.snap.services) {
        const ns = svc.metadata.namespace ?? '';
        const selected = b.idx.livePods.filter((p) => (p.metadata.namespace ?? '') === ns && matchesMap(svc.spec?.selector, p.metadata.labels));
        if (!selected.length) continue;
        const hits = selected.map((p) => b.hits.get(podKey(p))).filter((h): h is PodHit => !!h);
        if (!hits.length) continue;
        const hard = hits.filter((h) => HARD.includes(h.fate));
        const left = selected.length - hard.length;
        let severity: Severity;
        let reason: string;
        if (hard.length) {
            severity = left <= 0 ? 'down' : 'degraded';
            const onlyMoves = hard.every((h) => h.fate === 'moves');
            reason = left <= 0 ? (onlyMoves ? 'no endpoints left until its pods start elsewhere' : 'no endpoints left') : `${plural(left, 'endpoint')} left`;
        } else if (hits.some((h) => h.fate === 'fragile')) {
            severity = 'restart';
            reason = 'its endpoints fail the next time they start';
        } else continue;
        const ref: Ref = { kind: 'services', namespace: ns, name: svc.metadata.name };
        const node = b.node(ref, 3, severity, reason, `${hard.length || hits.length} of ${plural(selected.length, 'endpoint')}`);
        for (const hit of hits) b.edge(drawnUnder.get(podKey(hit.pod)) ?? b.target.id, node.id);
        out.set(`${ns}/${svc.metadata.name}`, { severity, id: node.id });
    }
    return out;
}

// ----- step 4: what sends traffic to them -----------------------------------------------------

function entryPoints(b: Builder, services: Map<string, Hurt>): void {
    if (!services.size) return;
    for (const ing of b.idx.snap.ingresses) {
        const ns = ing.metadata.namespace ?? '';
        const names = new Set<string>();
        if (ing.spec?.defaultBackend?.service?.name) names.add(ing.spec.defaultBackend.service.name);
        for (const rule of ing.spec?.rules ?? []) {
            for (const path of rule.http?.paths ?? []) if (path.backend?.service?.name) names.add(path.backend.service.name);
        }
        const hosts = (ing.spec?.rules ?? []).map((r) => r.host).filter((h): h is string => !!h);
        judgeEntry(b, { kind: 'ingresses', namespace: ns, name: ing.metadata.name }, [...names].map((n) => `${ns}/${n}`), services, hosts);
    }
    for (const route of b.idx.snap.httproutes) {
        const ns = route.metadata.namespace ?? '';
        const keys = new Set<string>();
        for (const rule of route.spec?.rules ?? []) {
            for (const ref of rule.backendRefs ?? []) {
                if ((ref.kind ?? 'Service') !== 'Service' || (ref.group ?? '') !== '') continue;
                keys.add(`${ref.namespace ?? ns}/${ref.name}`);
            }
        }
        judgeEntry(b, { kind: HTTPROUTES, namespace: ns, name: route.metadata.name }, [...keys], services, route.spec?.hostnames ?? []);
    }
}

function judgeEntry(b: Builder, ref: Ref, backends: string[], services: Map<string, Hurt>, hosts: string[]): void {
    const hurt = backends.map((k) => services.get(k)).filter((h): h is Hurt => !!h);
    if (!hurt.length) return;
    const down = hurt.filter((h) => h.severity === 'down').length;
    let severity: Severity;
    let reason: string;
    const where = hosts.length ? ` for ${hosts.slice(0, 2).join(', ')}${hosts.length > 2 ? ' …' : ''}` : '';
    if (down && down === backends.length) {
        severity = 'down';
        reason = `stops answering${where}`;
    } else if (down) {
        severity = 'degraded';
        reason = `${plural(down, 'backend')} of ${backends.length} down${where}`;
    } else {
        severity = hurt.map((h) => h.severity).reduce(worst);
        reason = `its backends ${severity === 'restart' ? 'break on their next restart' : 'lose capacity'}${where}`;
    }
    const node = b.node(ref, 4, severity, reason, `${hurt.length} of ${plural(backends.length, 'backend')}`);
    for (const h of hurt) b.edge(h.id, node.id);
}

// ----- the verdict ---------------------------------------------------------------------------

function verdict(nodes: GraphNode[]): Impact['verdict'] {
    if (!nodes.length) return { severity: null, text: 'Nothing that this plugin can see depends on it.' };
    const severity = nodes.map((n) => n.severity).reduce(worst);
    const count = (column: Column, sev: Severity): number => nodes.filter((n) => n.column === column && n.severity === sev).length;
    const parts: string[] = [];
    const say = (n: number, one: string, many: string): void => {
        if (n) parts.push(`${n} ${n === 1 ? one : many}`);
    };
    say(count(2, 'down'), 'workload goes down', 'workloads go down');
    say(count(2, 'stuck'), 'workload cannot bring back all its pods', 'workloads cannot bring back all their pods');
    say(count(2, 'degraded'), 'workload loses capacity', 'workloads lose capacity');
    say(count(2, 'restart'), 'workload breaks on its next restart', 'workloads break on their next restart');
    say(count(3, 'down'), 'Service loses every endpoint', 'Services lose every endpoint');
    say(count(4, 'down'), 'entry point stops answering', 'entry points stop answering');
    say(count(4, 'degraded'), 'entry point is partly down', 'entry points are partly down');
    say(count(1, 'stuck'), 'claim stays Pending', 'claims stay Pending');
    if (!parts.length) return { severity, text: 'It is used, but nothing breaks.' };
    const text = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    return { severity, text: text.charAt(0).toUpperCase() + text.slice(1) + '.' };
}

// ----- ranking -------------------------------------------------------------------------------

/** Every target worth a look, worst first: where losing one thing would hurt most. */
export function hotspots(snap: Snapshot, limit = 12): Impact[] {
    const idx = new Index(snap);
    const kinds = ['nodes', 'persistentvolumeclaims', 'configmaps', 'secrets', 'services', 'storageclasses'];
    const out: Impact[] = [];
    for (const kind of kinds) {
        for (const ref of candidates(snap, kind)) {
            if (kind === 'configmaps' && ref.name === 'kube-root-ca.crt') continue;
            const impact = blastRadius(snap, ref, idx);
            if (impact.score > 0) out.push(impact);
        }
    }
    return out.sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id)).slice(0, limit);
}
