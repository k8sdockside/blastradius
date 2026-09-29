// The parts of Kubernetes objects this plugin reads. Everything is optional:
// the bridge hands back what the API server returned, and a field an object
// does not have is simply absent.

import type { LabelSelector, Labels } from './selector';

export interface Meta {
    name: string;
    namespace?: string;
    uid?: string;
    labels?: Labels;
    annotations?: Record<string, string>;
    ownerReferences?: { kind: string; name: string; uid?: string; controller?: boolean }[];
    deletionTimestamp?: string;
}

export interface Obj {
    metadata: Meta;
    [field: string]: unknown;
}

export interface KeyRef {
    name?: string;
    key?: string;
    optional?: boolean;
}

export interface EnvVar {
    name: string;
    valueFrom?: { configMapKeyRef?: KeyRef; secretKeyRef?: KeyRef };
}

export interface EnvFrom {
    configMapRef?: { name?: string; optional?: boolean };
    secretRef?: { name?: string; optional?: boolean };
}

export interface Container {
    name: string;
    env?: EnvVar[];
    envFrom?: EnvFrom[];
    volumeMounts?: { name: string; mountPath: string }[];
}

export interface ProjectedSource {
    configMap?: { name?: string; optional?: boolean };
    secret?: { name?: string; optional?: boolean };
}

export interface Volume {
    name: string;
    configMap?: { name?: string; optional?: boolean };
    secret?: { secretName?: string; optional?: boolean };
    projected?: { sources?: ProjectedSource[] };
    persistentVolumeClaim?: { claimName: string };
}

export interface Pod extends Obj {
    spec?: {
        nodeName?: string;
        serviceAccountName?: string;
        automountServiceAccountToken?: boolean;
        containers?: Container[];
        initContainers?: Container[];
        volumes?: Volume[];
        imagePullSecrets?: { name: string }[];
    };
    status?: { phase?: string };
}

export interface Workload extends Obj {
    spec?: {
        replicas?: number;
        serviceName?: string;
        selector?: LabelSelector;
        volumeClaimTemplates?: { metadata?: { name?: string }; spec?: { storageClassName?: string } }[];
    };
}

export interface Service extends Obj {
    spec?: { selector?: Labels; type?: string; clusterIP?: string };
}

export interface IngressBackend {
    service?: { name: string };
}

export interface Ingress extends Obj {
    spec?: {
        defaultBackend?: IngressBackend;
        tls?: { hosts?: string[]; secretName?: string }[];
        rules?: { host?: string; http?: { paths?: { path?: string; backend?: IngressBackend }[] } }[];
    };
}

export interface HTTPRoute extends Obj {
    spec?: {
        hostnames?: string[];
        rules?: { backendRefs?: { name: string; namespace?: string; kind?: string; group?: string; weight?: number }[] }[];
    };
}

export interface PVC extends Obj {
    spec?: { storageClassName?: string; volumeName?: string };
}

export interface NodeSelectorTerm {
    matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

export interface PV extends Obj {
    spec?: {
        storageClassName?: string;
        persistentVolumeReclaimPolicy?: string;
        claimRef?: { namespace?: string; name?: string };
        local?: { path?: string };
        hostPath?: { path?: string };
        nodeAffinity?: { required?: { nodeSelectorTerms?: NodeSelectorTerm[] } };
    };
}

export interface StorageClass extends Obj {
    provisioner?: string;
    reclaimPolicy?: string;
}

export interface PDB extends Obj {
    spec?: { selector?: LabelSelector };
    status?: { disruptionsAllowed?: number };
}

export interface ServiceAccount extends Obj {
    automountServiceAccountToken?: boolean;
}

export interface Node extends Obj {
    spec?: { unschedulable?: boolean };
}

/** Every object the impact is worked out from. A kind the cluster does not serve is an empty list. */
export interface Snapshot {
    pods: Pod[];
    replicasets: Workload[];
    deployments: Workload[];
    statefulsets: Workload[];
    daemonsets: Workload[];
    jobs: Workload[];
    cronjobs: Workload[];
    services: Service[];
    ingresses: Ingress[];
    httproutes: HTTPRoute[];
    pvcs: PVC[];
    pvs: PV[];
    storageclasses: StorageClass[];
    configmaps: Obj[];
    nodes: Node[];
    pdbs: PDB[];
    serviceaccounts: ServiceAccount[];
}

export function emptySnapshot(): Snapshot {
    return {
        pods: [],
        replicasets: [],
        deployments: [],
        statefulsets: [],
        daemonsets: [],
        jobs: [],
        cronjobs: [],
        services: [],
        ingresses: [],
        httproutes: [],
        pvcs: [],
        pvs: [],
        storageclasses: [],
        configmaps: [],
        nodes: [],
        pdbs: [],
        serviceaccounts: [],
    };
}

/** An object as the app names it: its app kind, namespace (`''` when cluster-scoped) and name. */
export interface Ref {
    kind: string;
    namespace: string;
    name: string;
}

export function refKey(ref: Ref): string {
    return `${ref.kind}/${ref.namespace}/${ref.name}`;
}

export function parseRefKey(key: string): Ref | null {
    const parts = key.split('/');
    if (parts.length < 3) return null;
    const [kind, namespace, ...rest] = parts;
    const name = rest.join('/');
    if (!kind || !name) return null;
    return { kind, namespace: namespace ?? '', name };
}

export const HTTPROUTES = 'crd:httproutes.gateway.networking.k8s.io';

/** How the page writes a kind for a person. */
export const KIND_LABEL: Record<string, string> = {
    nodes: 'Node',
    pods: 'Pod',
    deployments: 'Deployment',
    statefulsets: 'StatefulSet',
    daemonsets: 'DaemonSet',
    replicasets: 'ReplicaSet',
    jobs: 'Job',
    cronjobs: 'CronJob',
    services: 'Service',
    ingresses: 'Ingress',
    [HTTPROUTES]: 'HTTPRoute',
    persistentvolumeclaims: 'PVC',
    persistentvolumes: 'PV',
    storageclasses: 'StorageClass',
    configmaps: 'ConfigMap',
    secrets: 'Secret',
    serviceaccounts: 'ServiceAccount',
    poddisruptionbudgets: 'PDB',
};

/** An API kind (`ReplicaSet`) as the app's kind name (`replicasets`), for the kinds that have one here. */
export const APP_KIND: Record<string, string> = {
    Pod: 'pods',
    Deployment: 'deployments',
    StatefulSet: 'statefulsets',
    DaemonSet: 'daemonsets',
    ReplicaSet: 'replicasets',
    Job: 'jobs',
    CronJob: 'cronjobs',
    Node: 'nodes',
};

export function kindLabel(kind: string): string {
    return KIND_LABEL[kind] ?? kind.replace(/^crd:/, '').split('.')[0] ?? kind;
}

/** The kinds a blast radius can be worked out for. */
export const TARGET_KINDS = [
    'nodes',
    'persistentvolumeclaims',
    'persistentvolumes',
    'storageclasses',
    'configmaps',
    'secrets',
    'services',
    'serviceaccounts',
    'deployments',
    'statefulsets',
    'daemonsets',
] as const;

export const CLUSTER_SCOPED = new Set(['nodes', 'persistentvolumes', 'storageclasses']);

/** Kinds the app will open for this plugin. Secrets are never among them. */
export const OPENABLE = new Set([
    'nodes',
    'pods',
    'deployments',
    'statefulsets',
    'daemonsets',
    'replicasets',
    'jobs',
    'cronjobs',
    'services',
    'ingresses',
    HTTPROUTES,
    'persistentvolumeclaims',
    'persistentvolumes',
    'storageclasses',
    'configmaps',
    'serviceaccounts',
    'poddisruptionbudgets',
]);

/** Whether a pod still counts: not finished, not already on its way out. */
export function live(pod: Pod): boolean {
    const phase = pod.status?.phase;
    return phase !== 'Succeeded' && phase !== 'Failed' && !pod.metadata.deletionTimestamp;
}
