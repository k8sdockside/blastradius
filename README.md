# Blast radius

A [K8s Dockside](https://github.com/k8sdockside/k8sdockside) plugin: pick a
Kubernetes object and see **what fails if it goes away**.

- **Blast radius** (the page the plugin opens on). Pick a Node, PVC, PV, StorageClass, ConfigMap,
  Secret, Service, ServiceAccount, Deployment, StatefulSet or DaemonSet. The
  page draws a graph from the object to the front door: object → claims →
  workloads → Services → Ingresses and HTTPRoutes. Each box is coloured by what
  happens to it:

  | | |
  | --- | --- |
  | **Goes down** | every pod goes, or a Service loses every endpoint, or an entry point stops answering |
  | **Cannot come back** | its pods cannot start elsewhere, like a pod on a local volume when the node is gone |
  | **Loses capacity** | some replicas or endpoints go, and the rest carry on |
  | **Breaks on restart** | it keeps running, but fails the next time a pod starts (a deleted ConfigMap, Secret, claim or ServiceAccount) |
  | **Touched, keeps working** | a DaemonSet pod on a failed node, an optional reference; hidden unless asked for |

  Hover a box to light the paths through it. Any box can become the target in
  its turn. The *Worth knowing* notes cover what the graph cannot show:
  PodDisruptionBudgets that would hold up a drain, reclaim policies,
  StatefulSets that would recreate a claim empty, and objects Kubernetes puts
  back on its own.

  With nothing picked, the page ranks every node, claim, ConfigMap, Secret,
  Service and StorageClass by how much would break without it: **where it
  would hurt most**.

- **A Blast radius panel** in the detail view of nodes, PVCs, PVs,
  StorageClasses, ConfigMaps, Services, ServiceAccounts, Deployments,
  StatefulSets and DaemonSets, with **Open the map**.

## What it reads, and what it does not

It only reads, and never writes anything. It reads pods, nodes, ReplicaSets, Deployments,
StatefulSets, DaemonSets, Jobs, CronJobs, Services, Ingresses, HTTPRoutes (when
the Gateway API is installed), PVCs, PVs, StorageClasses, ConfigMaps,
PodDisruptionBudgets and ServiceAccounts.

**It never reads Secrets**, and the app would refuse if it tried. The Secrets you
can pick are the ones pods (volumes, env, envFrom, imagePullSecrets) and
Ingresses (TLS) refer to by name, and their blast radius comes from those
references.

It answers from one snapshot of the cluster. It cannot know which callers
reach a Service by DNS name, and it does not simulate the scheduler: a pod
that "moves" has a controller that will recreate it, but that is no promise
another node has room for it.

## Try it

**Settings → Plugins → From a repository**:

```
https://github.com/k8sdockside/blastradius
```

Or, to work on it, **Settings → Plugins → Watch another folder** and pick this
folder. `ui/` is committed, so nothing has to be built first.

## Develop

```sh
npm install
npm run watch        # rebuild ui/ from src/ on every change; reopen the tab to see it
npm test             # the impact model's tests
npm run check        # type-check, test, and check ui/ matches a fresh build
go run github.com/k8sdockside/k8sdockside/cmd/plugincheck@main .
```

`src/model/impact.ts` is the whole model. It is plain TypeScript with no DOM and no
bridge, and `impact.test.ts` covers it. `src/pages/radius.ts` is the view and
`src/pages/panel.ts` is the panel.

Needs K8s Dockside 0.1.1 or newer.
