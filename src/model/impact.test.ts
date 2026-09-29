import { describe, expect, it } from 'vitest';
import { blastRadius, candidates, hotspots } from './impact';
import { emptySnapshot, type Pod, type Snapshot } from './kube';

function pod(name: string, ns: string, node: string, labels: Record<string, string>, owner?: { kind: string; name: string }, spec: Pod['spec'] = {}): Pod {
    return {
        metadata: { name, namespace: ns, labels, ownerReferences: owner ? [{ ...owner, controller: true }] : undefined },
        spec: { nodeName: node, ...spec },
        status: { phase: 'Running' },
    };
}

function cluster(): Snapshot {
    const s = emptySnapshot();
    s.nodes = [{ metadata: { name: 'n1' } }, { metadata: { name: 'n2' } }];
    s.replicasets = [
        { metadata: { name: 'web-abc', namespace: 'shop', ownerReferences: [{ kind: 'Deployment', name: 'web', controller: true }] } },
        { metadata: { name: 'api-def', namespace: 'shop', ownerReferences: [{ kind: 'Deployment', name: 'api', controller: true }] } },
    ];
    s.deployments = [
        { metadata: { name: 'web', namespace: 'shop' } },
        { metadata: { name: 'api', namespace: 'shop' } },
    ];
    s.daemonsets = [{ metadata: { name: 'agent', namespace: 'kube-system' } }];
    s.statefulsets = [{ metadata: { name: 'db', namespace: 'shop' }, spec: { serviceName: 'db' } }];
    const cm = { volumes: [{ name: 'cfg', configMap: { name: 'web-config' } }], containers: [{ name: 'web', volumeMounts: [{ name: 'cfg', mountPath: '/etc/web' }] }] };
    s.pods = [
        pod('web-abc-1', 'shop', 'n1', { app: 'web' }, { kind: 'ReplicaSet', name: 'web-abc' }, cm),
        pod('web-abc-2', 'shop', 'n2', { app: 'web' }, { kind: 'ReplicaSet', name: 'web-abc' }, cm),
        pod('api-def-1', 'shop', 'n1', { app: 'api' }, { kind: 'ReplicaSet', name: 'api-def' }, {
            containers: [{ name: 'api', env: [{ name: 'DB_PASS', valueFrom: { secretKeyRef: { name: 'db-pass', key: 'password' } } }] }],
        }),
        pod('db-0', 'shop', 'n1', { app: 'db' }, { kind: 'StatefulSet', name: 'db' }, { volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-db-0' } }] }),
        pod('agent-x', 'kube-system', 'n1', { app: 'agent' }, { kind: 'DaemonSet', name: 'agent' }),
        pod('debug', 'shop', 'n1', { app: 'debug' }),
        pod('kube-apiserver-n1', 'kube-system', 'n1', { component: 'kube-apiserver' }, { kind: 'Node', name: 'n1' }),
    ];
    s.pvcs = [{ metadata: { name: 'data-db-0', namespace: 'shop' }, spec: { volumeName: 'pv-local', storageClassName: 'local' } }];
    s.pvs = [
        {
            metadata: { name: 'pv-local' },
            spec: {
                claimRef: { namespace: 'shop', name: 'data-db-0' },
                persistentVolumeReclaimPolicy: 'Delete',
                nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['n1'] }] }] } },
            },
        },
    ];
    s.storageclasses = [{ metadata: { name: 'local' } }];
    s.configmaps = [{ metadata: { name: 'web-config', namespace: 'shop' } }];
    s.services = [
        { metadata: { name: 'web', namespace: 'shop' }, spec: { selector: { app: 'web' } } },
        { metadata: { name: 'api', namespace: 'shop' }, spec: { selector: { app: 'api' } } },
        { metadata: { name: 'db', namespace: 'shop' }, spec: { selector: { app: 'db' } } },
    ];
    s.ingresses = [
        {
            metadata: { name: 'shop', namespace: 'shop' },
            spec: {
                tls: [{ hosts: ['shop.example'], secretName: 'shop-tls' }],
                rules: [{ host: 'shop.example', http: { paths: [{ path: '/', backend: { service: { name: 'web' } } }, { path: '/api', backend: { service: { name: 'api' } } }] } }],
            },
        },
    ];
    s.pdbs = [{ metadata: { name: 'api', namespace: 'shop' }, spec: { selector: { matchLabels: { app: 'api' } } }, status: { disruptionsAllowed: 0 } }];
    return s;
}

const find = (impact: ReturnType<typeof blastRadius>, id: string) => impact.nodes.find((n) => n.id === id);

describe('a node', () => {
    const impact = blastRadius(cluster(), { kind: 'nodes', namespace: '', name: 'n1' });

    it('takes down a workload whose only pod is there, and dents one with a pod elsewhere', () => {
        expect(find(impact, 'deployments/shop/api')?.severity).toBe('down');
        expect(find(impact, 'deployments/shop/web')?.severity).toBe('degraded');
        expect(find(impact, 'deployments/shop/web')?.detail).toBe('1 of 2 pods');
    });

    it('knows a pod on a local volume cannot move', () => {
        const db = find(impact, 'statefulsets/shop/db');
        expect(db?.severity).toBe('down');
        expect(db?.reason).toMatch(/pv-local lives on this node/);
    });

    it('treats a DaemonSet pod as going with the node, and a bare pod as lost', () => {
        expect(find(impact, 'daemonsets/kube-system/agent')?.severity).toBe('info');
        expect(find(impact, 'pods/shop/debug')?.severity).toBe('down');
    });

    it('follows Services to the Ingress in front of them', () => {
        expect(find(impact, 'services/shop/api')?.severity).toBe('down');
        expect(find(impact, 'services/shop/web')?.severity).toBe('degraded');
        const ing = find(impact, 'ingresses/shop/shop');
        expect(ing?.severity).toBe('degraded');
        expect(impact.edges).toContainEqual({ from: 'services/shop/api', to: 'ingresses/shop/shop' });
    });

    it('warns about a PodDisruptionBudget that would hold up a drain', () => {
        expect(impact.notes.join(' ')).toMatch(/PodDisruptionBudget shop\/api/);
    });

    it('says a static pod with no peers is the only copy', () => {
        const apiserver = impact.nodes.find((n) => n.id.includes('kube-apiserver'));
        expect(apiserver?.severity).toBe('down');
        expect(apiserver?.ref).toEqual({ kind: 'pods', namespace: 'kube-system', name: 'kube-apiserver-n1' });
    });
});

describe('a ConfigMap and a Secret', () => {
    it('break the pods that mount them on their next restart', () => {
        const impact = blastRadius(cluster(), { kind: 'configmaps', namespace: 'shop', name: 'web-config' });
        const web = find(impact, 'deployments/shop/web');
        expect(web?.severity).toBe('restart');
        expect(web?.reason).toBe('mounts it at /etc/web');
        expect(find(impact, 'services/shop/web')?.severity).toBe('restart');
    });

    it('finds Secrets from what refers to them, never by reading them', () => {
        const names = candidates(cluster(), 'secrets').map((r) => r.name).sort();
        expect(names).toEqual(['db-pass', 'shop-tls']);
    });

    it('costs an Ingress its certificate', () => {
        const impact = blastRadius(cluster(), { kind: 'secrets', namespace: 'shop', name: 'shop-tls' });
        expect(find(impact, 'ingresses/shop/shop')?.severity).toBe('degraded');
        expect(impact.found).toBe(true);
    });

    it('reads an env var reference', () => {
        const impact = blastRadius(cluster(), { kind: 'secrets', namespace: 'shop', name: 'db-pass' });
        expect(find(impact, 'deployments/shop/api')?.reason).toBe('reads password into $DB_PASS');
    });
});

describe('a Service', () => {
    it('takes its entry points and a StatefulSet naming it with it', () => {
        const impact = blastRadius(cluster(), { kind: 'services', namespace: 'shop', name: 'db' });
        expect(find(impact, 'statefulsets/shop/db')?.severity).toBe('degraded');
        const web = blastRadius(cluster(), { kind: 'services', namespace: 'shop', name: 'web' });
        expect(find(web, 'ingresses/shop/shop')?.severity).toBe('degraded');
    });
});

describe('storage', () => {
    it('a PV reaches its pods through its claim', () => {
        const impact = blastRadius(cluster(), { kind: 'persistentvolumes', namespace: '', name: 'pv-local' });
        expect(find(impact, 'persistentvolumeclaims/shop/data-db-0')?.column).toBe(1);
        expect(find(impact, 'statefulsets/shop/db')?.severity).toBe('restart');
        expect(impact.edges).toContainEqual({ from: 'persistentvolumeclaims/shop/data-db-0', to: 'statefulsets/shop/db' });
    });

    it('a claim warns about its reclaim policy', () => {
        const impact = blastRadius(cluster(), { kind: 'persistentvolumeclaims', namespace: 'shop', name: 'data-db-0' });
        expect(impact.notes.join(' ')).toMatch(/reclaim policy Delete/);
    });
});

describe('a workload', () => {
    it('is drawn as the target, with its Services after it', () => {
        const impact = blastRadius(cluster(), { kind: 'deployments', namespace: 'shop', name: 'api' });
        expect(find(impact, 'deployments/shop/api')).toBeUndefined();
        expect(find(impact, 'services/shop/api')?.severity).toBe('down');
        expect(impact.edges).toContainEqual({ from: 'deployments/shop/api', to: 'services/shop/api' });
        expect(impact.verdict.text).toMatch(/Service loses every endpoint/);
    });
});

describe('hotspots', () => {
    it('ranks the node first', () => {
        expect(hotspots(cluster())[0]?.target.id).toBe('nodes//n1');
    });
});
