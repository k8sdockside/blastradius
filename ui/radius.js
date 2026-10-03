// Built by k8sdockside-plugin from src/ -- edit the TypeScript there, not this file.
"use strict";
(() => {
  // node_modules/@k8sdockside/plugin-sdk/dom.js
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value === void 0 || value === false) continue;
      if (name === "class") node.className = String(value);
      else if (name === "text") node.textContent = String(value);
      else node.setAttribute(name, String(value));
    }
    append(node, children);
    return node;
  }
  function button(label, onClick, attrs = {}) {
    const node = el("button", { type: "button", ...attrs }, label);
    node.addEventListener("click", onClick);
    return node;
  }
  function replace(parent, ...children) {
    parent.replaceChildren();
    append(parent, children);
  }
  function byId(id) {
    const node = document.getElementById(id);
    if (!node) throw new Error(`the page has no #${id}`);
    return node;
  }
  function svg(markup, className = "icon") {
    const holder = document.createElement("span");
    holder.innerHTML = markup;
    const node = holder.firstElementChild;
    if (!node) throw new Error("svg() was given no element");
    node.setAttribute("class", className);
    return node;
  }
  function append(parent, children) {
    for (const child of children) {
      if (child === null || child === void 0 || child === false) continue;
      parent.append(child);
    }
  }

  // src/model/kube.ts
  function emptySnapshot() {
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
      serviceaccounts: []
    };
  }
  function refKey(ref) {
    return `${ref.kind}/${ref.namespace}/${ref.name}`;
  }
  var HTTPROUTES = "crd:httproutes.gateway.networking.k8s.io";
  var KIND_LABEL = {
    nodes: "Node",
    pods: "Pod",
    deployments: "Deployment",
    statefulsets: "StatefulSet",
    daemonsets: "DaemonSet",
    replicasets: "ReplicaSet",
    jobs: "Job",
    cronjobs: "CronJob",
    services: "Service",
    ingresses: "Ingress",
    [HTTPROUTES]: "HTTPRoute",
    persistentvolumeclaims: "PVC",
    persistentvolumes: "PV",
    storageclasses: "StorageClass",
    configmaps: "ConfigMap",
    secrets: "Secret",
    serviceaccounts: "ServiceAccount",
    poddisruptionbudgets: "PDB"
  };
  var APP_KIND = {
    Pod: "pods",
    Deployment: "deployments",
    StatefulSet: "statefulsets",
    DaemonSet: "daemonsets",
    ReplicaSet: "replicasets",
    Job: "jobs",
    CronJob: "cronjobs",
    Node: "nodes"
  };
  function kindLabel(kind) {
    return KIND_LABEL[kind] ?? kind.replace(/^crd:/, "").split(".")[0] ?? kind;
  }
  var TARGET_KINDS = [
    "nodes",
    "persistentvolumeclaims",
    "persistentvolumes",
    "storageclasses",
    "configmaps",
    "secrets",
    "services",
    "serviceaccounts",
    "deployments",
    "statefulsets",
    "daemonsets"
  ];
  var CLUSTER_SCOPED = /* @__PURE__ */ new Set(["nodes", "persistentvolumes", "storageclasses"]);
  var OPENABLE = /* @__PURE__ */ new Set([
    "nodes",
    "pods",
    "deployments",
    "statefulsets",
    "daemonsets",
    "replicasets",
    "jobs",
    "cronjobs",
    "services",
    "ingresses",
    HTTPROUTES,
    "persistentvolumeclaims",
    "persistentvolumes",
    "storageclasses",
    "configmaps",
    "serviceaccounts",
    "poddisruptionbudgets"
  ]);
  function live(pod) {
    const phase = pod.status?.phase;
    return phase !== "Succeeded" && phase !== "Failed" && !pod.metadata.deletionTimestamp;
  }

  // src/model/selector.ts
  function matches(selector, labels) {
    if (!selector) return false;
    const have = labels ?? {};
    for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
      if (have[key] !== value) return false;
    }
    for (const req of selector.matchExpressions ?? []) {
      const present = Object.prototype.hasOwnProperty.call(have, req.key);
      const values = req.values ?? [];
      switch (req.operator) {
        case "In":
          if (!present || !values.includes(have[req.key])) return false;
          break;
        case "NotIn":
          if (present && values.includes(have[req.key])) return false;
          break;
        case "Exists":
          if (!present) return false;
          break;
        case "DoesNotExist":
          if (present) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }
  function matchesMap(selector, labels) {
    if (!selector || Object.keys(selector).length === 0) return false;
    return matches({ matchLabels: selector }, labels);
  }

  // src/model/impact.ts
  var SEVERITIES = ["down", "stuck", "degraded", "restart", "info"];
  var SEVERITY_LABEL = {
    down: "Goes down",
    stuck: "Cannot come back",
    degraded: "Loses capacity",
    restart: "Breaks on restart",
    info: "Touched, keeps working"
  };
  var WEIGHT = { down: 10, stuck: 8, degraded: 4, restart: 2, info: 0 };
  function worst(a, b) {
    return SEVERITIES.indexOf(a) <= SEVERITIES.indexOf(b) ? a : b;
  }
  var COLUMN_LABEL = ["Target", "Through", "Workloads", "Services", "Entry points"];
  var Index = class {
    constructor(snap2) {
      this.snap = snap2;
      this.livePods = snap2.pods.filter(live);
      for (const rs of snap2.replicasets) this.rs.set(nsName(rs), rs);
      for (const job of snap2.jobs) this.jobs.set(nsName(job), job);
      for (const pod of this.livePods) {
        const owner = this.owner(pod);
        const key = owner?.key ?? podKey(pod);
        const list = this.byOwner.get(key);
        if (list) list.push(pod);
        else this.byOwner.set(key, [pod]);
      }
    }
    snap;
    livePods;
    rs = /* @__PURE__ */ new Map();
    jobs = /* @__PURE__ */ new Map();
    owners = /* @__PURE__ */ new Map();
    byOwner = /* @__PURE__ */ new Map();
    /** The workload a pod belongs to, followed up past ReplicaSets and Jobs; null for a bare pod. */
    owner(pod) {
      if (this.owners.has(pod)) return this.owners.get(pod) ?? null;
      const found = this.findOwner(pod);
      this.owners.set(pod, found);
      return found;
    }
    /** The live pods of an owner key (or the one pod, for a bare pod's key). */
    podsOf(key) {
      return this.byOwner.get(key) ?? [];
    }
    findOwner(pod) {
      const refs = pod.metadata.ownerReferences ?? [];
      const ctrl = refs.find((r) => r.controller) ?? refs[0];
      if (!ctrl) return null;
      const ns = pod.metadata.namespace ?? "";
      if (ctrl.kind === "Node") {
        const node = pod.spec?.nodeName ?? "";
        const name2 = pod.metadata.name;
        const component = node && name2.endsWith("-" + node) ? name2.slice(0, -node.length - 1) : name2;
        return { key: `static/${ns}/${component}`, ref: { kind: "pods", namespace: ns, name: name2 }, static: true };
      }
      let kind = ctrl.kind;
      let name = ctrl.name;
      if (kind === "ReplicaSet") {
        const up = controllerOf(this.rs.get(`${ns}/${name}`));
        if (up?.kind === "Deployment") ({ kind, name } = up);
      } else if (kind === "Job") {
        const up = controllerOf(this.jobs.get(`${ns}/${name}`));
        if (up?.kind === "CronJob") ({ kind, name } = up);
      }
      const appKind = APP_KIND[kind] ?? kind;
      return { key: `${appKind}/${ns}/${name}`, ref: { kind: appKind, namespace: ns, name }, static: false };
    }
  };
  function controllerOf(obj) {
    const refs = obj?.metadata.ownerReferences ?? [];
    return refs.find((r) => r.controller) ?? refs[0];
  }
  function nsName(obj) {
    return `${obj.metadata.namespace ?? ""}/${obj.metadata.name}`;
  }
  function podKey(pod) {
    return `pods/${pod.metadata.namespace ?? ""}/${pod.metadata.name}`;
  }
  function plural(n, one, many = one + "s") {
    return `${n} ${n === 1 ? one : many}`;
  }
  function candidates(snap2, kind) {
    const out = (objs) => objs.map((o) => ({ kind, namespace: CLUSTER_SCOPED.has(kind) ? "" : o.metadata.namespace ?? "", name: o.metadata.name }));
    switch (kind) {
      case "nodes":
        return out(snap2.nodes);
      case "persistentvolumeclaims":
        return out(snap2.pvcs);
      case "persistentvolumes":
        return out(snap2.pvs);
      case "storageclasses":
        return out(snap2.storageclasses);
      case "configmaps":
        return out(snap2.configmaps);
      case "services":
        return out(snap2.services);
      case "serviceaccounts":
        return out(snap2.serviceaccounts);
      case "deployments":
        return out(snap2.deployments);
      case "statefulsets":
        return out(snap2.statefulsets);
      case "daemonsets":
        return out(snap2.daemonsets);
      case "secrets":
        return secretNames(snap2);
      default:
        return [];
    }
  }
  function secretNames(snap2) {
    const seen = /* @__PURE__ */ new Map();
    const add = (namespace, name) => {
      if (name) seen.set(`${namespace}/${name}`, { kind: "secrets", namespace, name });
    };
    for (const pod of snap2.pods) {
      const ns = pod.metadata.namespace ?? "";
      for (const use of podUses(pod, "secret")) add(ns, use.name);
    }
    for (const ing of snap2.ingresses) {
      for (const tls of ing.spec?.tls ?? []) add(ing.metadata.namespace ?? "", tls.secretName);
    }
    return [...seen.values()];
  }
  function mountPath(pod, volume) {
    for (const c of allContainers(pod)) {
      const mount = (c.volumeMounts ?? []).find((m) => m.name === volume);
      if (mount) return mount.mountPath;
    }
    return "";
  }
  function allContainers(pod) {
    return [...pod.spec?.initContainers ?? [], ...pod.spec?.containers ?? []];
  }
  function podUses(pod, what) {
    const uses = [];
    const mounted = (v, how) => {
      const path = mountPath(pod, v.name);
      return path ? `${how} at ${path}` : `${how} (volume ${v.name}, not mounted)`;
    };
    for (const v of pod.spec?.volumes ?? []) {
      if (what === "configmap" && v.configMap?.name) {
        uses.push({ name: v.configMap.name, optional: !!v.configMap.optional, how: mounted(v, "mounts it") });
      }
      if (what === "secret" && v.secret?.secretName) {
        uses.push({ name: v.secret.secretName, optional: !!v.secret.optional, how: mounted(v, "mounts it") });
      }
      for (const src of v.projected?.sources ?? []) {
        const ref = what === "configmap" ? src.configMap : src.secret;
        if (ref?.name) uses.push({ name: ref.name, optional: !!ref.optional, how: mounted(v, "projects it") });
      }
    }
    for (const c of allContainers(pod)) {
      for (const env of c.env ?? []) {
        const ref = what === "configmap" ? env.valueFrom?.configMapKeyRef : env.valueFrom?.secretKeyRef;
        if (ref?.name) uses.push({ name: ref.name, optional: !!ref.optional, how: `reads ${ref.key ?? "a key"} into $${env.name}` });
      }
      for (const from of c.envFrom ?? []) {
        const ref = what === "configmap" ? from.configMapRef : from.secretRef;
        if (ref?.name) uses.push({ name: ref.name, optional: !!ref.optional, how: `loads every key as environment in ${c.name}` });
      }
    }
    if (what === "secret") {
      for (const pull of pod.spec?.imagePullSecrets ?? []) {
        uses.push({ name: pull.name, optional: false, how: "pulls its images with it" });
      }
    }
    return uses;
  }
  var Builder = class {
    constructor(idx, target2) {
      this.idx = idx;
      this.target = target2;
    }
    idx;
    target;
    nodes = /* @__PURE__ */ new Map();
    edges = /* @__PURE__ */ new Map();
    notes = [];
    hits = /* @__PURE__ */ new Map();
    node(ref, column, severity, reason, detail = "") {
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
      const made = {
        id,
        ref,
        column,
        severity,
        reason,
        detail,
        openable: OPENABLE.has(ref.kind),
        targetable: TARGET_KINDS.includes(ref.kind)
      };
      this.nodes.set(id, made);
      return made;
    }
    edge(from, to) {
      if (from !== to) this.edges.set(`${from}>${to}`, { from, to });
    }
    /** Records a pod's fate, keeping the worse one when two paths reach it. */
    hit(pod, fate, reason, via = this.target.id) {
      const key = podKey(pod);
      const have = this.hits.get(key);
      const order = ["lost", "stuck", "moves", "fragile", "info"];
      if (have && order.indexOf(have.fate) <= order.indexOf(fate)) return;
      this.hits.set(key, { pod, fate, reason, via });
    }
  };
  function blastRadius(snap2, target2, idx = new Index(snap2)) {
    const t = {
      id: refKey(target2),
      ref: target2,
      column: 0,
      severity: "down",
      reason: "",
      detail: "",
      openable: OPENABLE.has(target2.kind),
      targetable: true
    };
    const b = new Builder(idx, t);
    let found = true;
    let scenario = `If ${kindLabel(target2.kind)} ${target2.name} is deleted`;
    switch (target2.kind) {
      case "nodes":
        found = snap2.nodes.some((n) => n.metadata.name === target2.name);
        scenario = `If node ${target2.name} fails or is drained`;
        nodeHits(b, target2.name);
        break;
      case "persistentvolumeclaims":
        found = snap2.pvcs.some((p) => sameRef(p, target2));
        claimHits(b, target2.namespace, target2.name, t.id);
        break;
      case "persistentvolumes":
        found = snap2.pvs.some((p) => p.metadata.name === target2.name);
        volumeHits(b, target2.name);
        break;
      case "storageclasses":
        found = snap2.storageclasses.some((s2) => s2.metadata.name === target2.name);
        classHits(b, target2.name);
        break;
      case "configmaps":
        found = snap2.configmaps.some((c) => sameRef(c, target2));
        referenceHits(b, "configmap", target2);
        break;
      case "secrets":
        found = secretNames(snap2).some((r) => r.namespace === target2.namespace && r.name === target2.name);
        referenceHits(b, "secret", target2);
        break;
      case "services":
        found = snap2.services.some((s2) => sameRef(s2, target2));
        serviceHits(b, target2);
        break;
      case "serviceaccounts":
        found = snap2.serviceaccounts.some((s2) => sameRef(s2, target2));
        accountHits(b, target2);
        break;
      case "deployments":
      case "statefulsets":
      case "daemonsets":
        found = workloadsOf(snap2, target2.kind).some((w) => sameRef(w, target2));
        workloadHits(b, target2);
        break;
    }
    const workloadIds = aggregateWorkloads(b);
    const serviceSeverity = aggregateServices(b, workloadIds);
    if (target2.kind === "services") serviceSeverity.set(`${target2.namespace}/${target2.name}`, { severity: "down", id: t.id });
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
      score
    };
  }
  function sameRef(obj, ref) {
    return obj.metadata.name === ref.name && (obj.metadata.namespace ?? "") === ref.namespace;
  }
  function workloadsOf(snap2, kind) {
    if (kind === "deployments") return snap2.deployments;
    if (kind === "statefulsets") return snap2.statefulsets;
    return snap2.daemonsets;
  }
  function nodeHits(b, nodeName) {
    const snap2 = b.idx.snap;
    const node = snap2.nodes.find((n) => n.metadata.name === nodeName);
    const hostname = node?.metadata.labels?.["kubernetes.io/hostname"] ?? nodeName;
    if (node?.spec?.unschedulable) b.notes.push(`${nodeName} is already cordoned: nothing new is scheduled on it.`);
    const onNode = b.idx.livePods.filter((p) => p.spec?.nodeName === nodeName);
    if (!onNode.length) b.notes.push(`No running pods are on ${nodeName}.`);
    for (const pod of onNode) {
      const owner = b.idx.owner(pod);
      const pinned = pinnedVolume(snap2, pod, nodeName, hostname);
      if (owner?.static) b.hit(pod, "lost", "a static pod: it only ever runs on this node");
      else if (owner?.ref.kind === "daemonsets") b.hit(pod, "info", "runs on every node; it goes with this one");
      else if (pinned) b.hit(pod, "stuck", `its volume ${pinned} lives on this node, so it cannot start anywhere else`);
      else if (!owner) b.hit(pod, "lost", "a bare pod: nothing starts it again");
      else b.hit(pod, "moves", "recreated on another node");
    }
    drainNotes(b, onNode);
  }
  function pinnedVolume(snap2, pod, nodeName, hostname) {
    const ns = pod.metadata.namespace ?? "";
    for (const v of pod.spec?.volumes ?? []) {
      const claim = v.persistentVolumeClaim?.claimName;
      if (!claim) continue;
      const pvc = snap2.pvcs.find((p) => p.metadata.name === claim && (p.metadata.namespace ?? "") === ns);
      const pv = snap2.pvs.find((p) => p.metadata.name === pvc?.spec?.volumeName);
      const terms = pv?.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? [];
      const pinned = terms.length > 0 && terms.every(
        (term) => (term.matchExpressions ?? []).some(
          (e) => e.operator === "In" && (e.values ?? []).length > 0 && (e.values ?? []).every((val) => val === hostname || val === nodeName)
        )
      );
      if (pinned) return pv?.metadata.name ?? claim;
    }
    return "";
  }
  function drainNotes(b, onNode) {
    for (const pdb of b.idx.snap.pdbs) {
      const ns = pdb.metadata.namespace ?? "";
      const here = onNode.filter((p) => (p.metadata.namespace ?? "") === ns && matches(pdb.spec?.selector, p.metadata.labels));
      if (!here.length) continue;
      const allowed = pdb.status?.disruptionsAllowed ?? 0;
      if (here.length > allowed) {
        b.notes.push(
          `A drain would wait on PodDisruptionBudget ${ns}/${pdb.metadata.name}: it allows ${plural(allowed, "disruption")} now, and ${plural(here.length, "of its pods is", "of its pods are")} on this node. A node that fails does not ask.`
        );
      }
    }
  }
  function claimHits(b, ns, claim, via) {
    const snap2 = b.idx.snap;
    let count = 0;
    for (const pod of b.idx.livePods) {
      if ((pod.metadata.namespace ?? "") !== ns) continue;
      const vol = (pod.spec?.volumes ?? []).find((v) => v.persistentVolumeClaim?.claimName === claim);
      if (!vol) continue;
      const path = mountPath(pod, vol.name);
      b.hit(pod, "fragile", `keeps the claim while it runs${path ? ` (at ${path})` : ""}, but cannot start again once it is gone`, via);
      count++;
    }
    if (via !== b.target.id) return count;
    const pvc = snap2.pvcs.find((p) => p.metadata.name === claim && (p.metadata.namespace ?? "") === ns);
    const pv = snap2.pvs.find((p) => p.metadata.name === pvc?.spec?.volumeName);
    if (count) {
      b.notes.push(`Kubernetes holds a claim that pods use (the pvc-protection finalizer): it is removed only once ${plural(count, "pod lets", "pods let")} go of it.`);
    }
    if (pv) {
      const policy = pv.spec?.persistentVolumeReclaimPolicy ?? "Delete";
      b.notes.push(
        policy === "Delete" ? `Its volume ${pv.metadata.name} has reclaim policy Delete: the data is deleted with the claim.` : `Its volume ${pv.metadata.name} has reclaim policy ${policy}: the data is kept, but nothing binds to it again on its own.`
      );
    }
    for (const sts of snap2.statefulsets) {
      if ((sts.metadata.namespace ?? "") !== ns) continue;
      for (const tpl of sts.spec?.volumeClaimTemplates ?? []) {
        const prefix = `${tpl.metadata?.name ?? ""}-${sts.metadata.name}-`;
        if (claim.startsWith(prefix) && /^\d+$/.test(claim.slice(prefix.length))) {
          b.notes.push(`StatefulSet ${sts.metadata.name} made this claim from a template, and would make it again, empty, for pod ${sts.metadata.name}-${claim.slice(prefix.length)}.`);
        }
      }
    }
    return count;
  }
  function volumeHits(b, pvName) {
    const snap2 = b.idx.snap;
    const pv = snap2.pvs.find((p) => p.metadata.name === pvName);
    const claim = pv?.spec?.claimRef;
    if (!pv || !claim?.name) {
      b.notes.push(`${pvName} is not bound to a claim: nothing uses it.`);
      return;
    }
    const pvcRef = { kind: "persistentvolumeclaims", namespace: claim.namespace ?? "", name: claim.name };
    const pvcNode = b.node(pvcRef, 1, "restart", "bound to it: loses its data");
    b.edge(b.target.id, pvcNode.id);
    const n = claimHits(b, pvcRef.namespace, pvcRef.name, pvcNode.id);
    pvcNode.detail = plural(n, "pod");
    const policy = pv.spec?.persistentVolumeReclaimPolicy ?? "Delete";
    b.notes.push(`Kubernetes holds a volume that is bound (the pv-protection finalizer) until its claim lets go. Reclaim policy: ${policy}.`);
  }
  function classHits(b, className) {
    const snap2 = b.idx.snap;
    const sc = snap2.storageclasses.find((s2) => s2.metadata.name === className);
    const isDefault = sc?.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true";
    b.notes.push("Volumes already made keep working: a StorageClass is read when a volume is made or expanded, not while it is used.");
    if (isDefault) b.notes.push(`${className} is the default class: new claims that name no class would stay Pending too.`);
    for (const pvc of snap2.pvcs) {
      if (pvc.spec?.storageClassName !== className) continue;
      const ref = { kind: "persistentvolumeclaims", namespace: pvc.metadata.namespace ?? "", name: pvc.metadata.name };
      const bound = !!pvc.spec?.volumeName;
      const node = b.node(ref, 1, bound ? "info" : "stuck", bound ? "bound already; cannot be expanded" : "not bound yet: stays Pending");
      b.edge(b.target.id, node.id);
      for (const pod of b.idx.livePods) {
        if ((pod.metadata.namespace ?? "") !== ref.namespace) continue;
        if ((pod.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === ref.name)) {
          b.hit(pod, bound ? "info" : "fragile", bound ? "its volume keeps working" : "waits for a volume that will not be made", node.id);
        }
      }
    }
    for (const sts of snap2.statefulsets) {
      const uses = (sts.spec?.volumeClaimTemplates ?? []).some(
        (tpl) => tpl.spec?.storageClassName === className || isDefault && !tpl.spec?.storageClassName
      );
      if (!uses) continue;
      const ref = { kind: "statefulsets", namespace: sts.metadata.namespace ?? "", name: sts.metadata.name };
      const node = b.node(ref, 2, "restart", "a new replica would wait forever for its claim");
      b.edge(b.target.id, node.id);
    }
  }
  function referenceHits(b, what, target2) {
    const rootCA = what === "configmap" && target2.name === "kube-root-ca.crt";
    if (rootCA) b.notes.push("kube-controller-manager puts kube-root-ca.crt back in every namespace within moments, so deleting it heals itself.");
    else b.notes.push("Running pods keep what they read when they started; a mounted copy stops updating. They fail when they are next started.");
    for (const pod of b.idx.livePods) {
      if ((pod.metadata.namespace ?? "") !== target2.namespace) continue;
      const uses = podUses(pod, what).filter((u) => u.name === target2.name);
      if (!uses.length) continue;
      const required = uses.find((u) => !u.optional);
      if (rootCA) b.hit(pod, "info", (required ?? uses[0]).how);
      else if (required) b.hit(pod, "fragile", required.how);
      else b.hit(pod, "info", `${uses[0].how} (optional)`);
    }
    if (what !== "secret") return;
    for (const ing of b.idx.snap.ingresses) {
      if ((ing.metadata.namespace ?? "") !== target2.namespace) continue;
      const tls = (ing.spec?.tls ?? []).filter((t) => t.secretName === target2.name);
      if (!tls.length) continue;
      const hosts = tls.flatMap((t) => t.hosts ?? []);
      const ref = { kind: "ingresses", namespace: target2.namespace, name: ing.metadata.name };
      const node = b.node(ref, 4, "degraded", `its certificate${hosts.length ? ` for ${hosts.join(", ")}` : ""}: the controller falls back to its default one`);
      b.edge(b.target.id, node.id);
    }
  }
  function serviceHits(b, target2) {
    const snap2 = b.idx.snap;
    const svc = snap2.services.find((s2) => sameRef(s2, target2));
    b.notes.push(`Anything calling ${target2.name}.${target2.namespace} by name stops resolving. Nothing in the cluster records who does, so those callers are not shown.`);
    if (svc?.spec?.type === "LoadBalancer") b.notes.push("It is a LoadBalancer: its external address is given back, and may not be the same one if it is made again.");
    for (const sts of snap2.statefulsets) {
      if ((sts.metadata.namespace ?? "") !== target2.namespace || sts.spec?.serviceName !== target2.name) continue;
      const ref = { kind: "statefulsets", namespace: target2.namespace, name: sts.metadata.name };
      const node = b.node(ref, 2, "degraded", `its pods' own DNS names (${sts.metadata.name}-0.${target2.name}) stop resolving`);
      b.edge(b.target.id, node.id);
    }
  }
  function accountHits(b, target2) {
    const sa = b.idx.snap.serviceaccounts.find((s2) => sameRef(s2, target2));
    for (const pod of b.idx.livePods) {
      if ((pod.metadata.namespace ?? "") !== target2.namespace) continue;
      if ((pod.spec?.serviceAccountName ?? "default") !== target2.name) continue;
      const token = pod.spec?.automountServiceAccountToken ?? sa?.automountServiceAccountToken ?? true;
      b.hit(pod, "fragile", token ? "its API token stops working now, and a new pod is refused" : "a new pod is refused");
    }
    if (target2.name === "default") b.notes.push("The default ServiceAccount is made again by kube-controller-manager, but with a new identity: tokens issued for the old one stay invalid.");
  }
  function workloadHits(b, target2) {
    const key = refKey(target2);
    for (const pod of b.idx.podsOf(key)) b.hit(pod, "lost", "deleted with it");
    if (target2.kind === "statefulsets") b.notes.push("Its PersistentVolumeClaims stay behind unless its persistentVolumeClaimRetentionPolicy says otherwise.");
  }
  var HARD = ["moves", "lost", "stuck"];
  function aggregateWorkloads(b) {
    const groups = /* @__PURE__ */ new Map();
    for (const hit of b.hits.values()) {
      const owner = b.idx.owner(hit.pod);
      const key = owner?.key ?? podKey(hit.pod);
      const group = groups.get(key);
      if (group) group.hits.push(hit);
      else groups.set(key, { owner, hits: [hit] });
    }
    const drawnUnder = /* @__PURE__ */ new Map();
    for (const [key, { owner, hits }] of groups) {
      if (key === b.target.id) {
        for (const hit of hits) drawnUnder.set(podKey(hit.pod), b.target.id);
        continue;
      }
      const total = Math.max(b.idx.podsOf(key).length, hits.length);
      const hard = hits.filter((h) => HARD.includes(h.fate));
      const stuck = hits.filter((h) => h.fate === "stuck");
      const lost = hits.filter((h) => h.fate === "lost");
      const fragile = hits.filter((h) => h.fate === "fragile");
      const left = total - hard.length;
      let severity;
      let reason;
      let detail = `${hard.length || hits.length} of ${plural(total, "pod")}`;
      if (hard.length) {
        const sample = (stuck[0] ?? lost[0] ?? hard[0]).reason;
        if (left <= 0) {
          severity = "down";
          reason = stuck.length || lost.length ? sample : "every pod goes, until they are started elsewhere";
        } else {
          severity = stuck.length ? "stuck" : "degraded";
          reason = `${sample}; ${plural(left, "pod keeps", "pods keep")} running`;
        }
        if (owner?.static) {
          const peers = total;
          severity = peers > 1 ? "degraded" : "down";
          reason = peers > 1 ? `a static pod; ${plural(peers - 1, "other node keeps", "other nodes keep")} a copy` : "a static pod, and the only copy";
          detail = `1 of ${plural(peers, "copy", "copies")}`;
        }
      } else if (fragile.length) {
        severity = "restart";
        reason = fragile[0].reason;
        detail = `${fragile.length} of ${plural(total, "pod")}`;
      } else {
        severity = "info";
        reason = hits[0].reason;
      }
      const ref = owner?.ref ?? { kind: "pods", namespace: hits[0].pod.metadata.namespace ?? "", name: hits[0].pod.metadata.name };
      const staticKey = owner?.static ? { ...ref, name: key.split("/").slice(2).join("/") + " (static)" } : null;
      const node = b.node(staticKey ?? ref, 2, severity, reason, detail);
      if (staticKey) {
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
  function aggregateServices(b, drawnUnder) {
    const out = /* @__PURE__ */ new Map();
    for (const svc of b.idx.snap.services) {
      const ns = svc.metadata.namespace ?? "";
      const selected = b.idx.livePods.filter((p) => (p.metadata.namespace ?? "") === ns && matchesMap(svc.spec?.selector, p.metadata.labels));
      if (!selected.length) continue;
      const hits = selected.map((p) => b.hits.get(podKey(p))).filter((h) => !!h);
      if (!hits.length) continue;
      const hard = hits.filter((h) => HARD.includes(h.fate));
      const left = selected.length - hard.length;
      let severity;
      let reason;
      if (hard.length) {
        severity = left <= 0 ? "down" : "degraded";
        const onlyMoves = hard.every((h) => h.fate === "moves");
        reason = left <= 0 ? onlyMoves ? "no endpoints left until its pods start elsewhere" : "no endpoints left" : `${plural(left, "endpoint")} left`;
      } else if (hits.some((h) => h.fate === "fragile")) {
        severity = "restart";
        reason = "its endpoints fail the next time they start";
      } else continue;
      const ref = { kind: "services", namespace: ns, name: svc.metadata.name };
      const node = b.node(ref, 3, severity, reason, `${hard.length || hits.length} of ${plural(selected.length, "endpoint")}`);
      for (const hit of hits) b.edge(drawnUnder.get(podKey(hit.pod)) ?? b.target.id, node.id);
      out.set(`${ns}/${svc.metadata.name}`, { severity, id: node.id });
    }
    return out;
  }
  function entryPoints(b, services) {
    if (!services.size) return;
    for (const ing of b.idx.snap.ingresses) {
      const ns = ing.metadata.namespace ?? "";
      const names = /* @__PURE__ */ new Set();
      if (ing.spec?.defaultBackend?.service?.name) names.add(ing.spec.defaultBackend.service.name);
      for (const rule of ing.spec?.rules ?? []) {
        for (const path of rule.http?.paths ?? []) if (path.backend?.service?.name) names.add(path.backend.service.name);
      }
      const hosts = (ing.spec?.rules ?? []).map((r) => r.host).filter((h) => !!h);
      judgeEntry(b, { kind: "ingresses", namespace: ns, name: ing.metadata.name }, [...names].map((n) => `${ns}/${n}`), services, hosts);
    }
    for (const route of b.idx.snap.httproutes) {
      const ns = route.metadata.namespace ?? "";
      const keys = /* @__PURE__ */ new Set();
      for (const rule of route.spec?.rules ?? []) {
        for (const ref of rule.backendRefs ?? []) {
          if ((ref.kind ?? "Service") !== "Service" || (ref.group ?? "") !== "") continue;
          keys.add(`${ref.namespace ?? ns}/${ref.name}`);
        }
      }
      judgeEntry(b, { kind: HTTPROUTES, namespace: ns, name: route.metadata.name }, [...keys], services, route.spec?.hostnames ?? []);
    }
  }
  function judgeEntry(b, ref, backends, services, hosts) {
    const hurt = backends.map((k) => services.get(k)).filter((h) => !!h);
    if (!hurt.length) return;
    const down = hurt.filter((h) => h.severity === "down").length;
    let severity;
    let reason;
    const where = hosts.length ? ` for ${hosts.slice(0, 2).join(", ")}${hosts.length > 2 ? " …" : ""}` : "";
    if (down && down === backends.length) {
      severity = "down";
      reason = `stops answering${where}`;
    } else if (down) {
      severity = "degraded";
      reason = `${plural(down, "backend")} of ${backends.length} down${where}`;
    } else {
      severity = hurt.map((h) => h.severity).reduce(worst);
      reason = `its backends ${severity === "restart" ? "break on their next restart" : "lose capacity"}${where}`;
    }
    const node = b.node(ref, 4, severity, reason, `${hurt.length} of ${plural(backends.length, "backend")}`);
    for (const h of hurt) b.edge(h.id, node.id);
  }
  function verdict(nodes) {
    if (!nodes.length) return { severity: null, text: "Nothing that this plugin can see depends on it." };
    const severity = nodes.map((n) => n.severity).reduce(worst);
    const count = (column, sev) => nodes.filter((n) => n.column === column && n.severity === sev).length;
    const parts = [];
    const say = (n, one, many) => {
      if (n) parts.push(`${n} ${n === 1 ? one : many}`);
    };
    say(count(2, "down"), "workload goes down", "workloads go down");
    say(count(2, "stuck"), "workload cannot bring back all its pods", "workloads cannot bring back all their pods");
    say(count(2, "degraded"), "workload loses capacity", "workloads lose capacity");
    say(count(2, "restart"), "workload breaks on its next restart", "workloads break on their next restart");
    say(count(3, "down"), "Service loses every endpoint", "Services lose every endpoint");
    say(count(4, "down"), "entry point stops answering", "entry points stop answering");
    say(count(4, "degraded"), "entry point is partly down", "entry points are partly down");
    say(count(1, "stuck"), "claim stays Pending", "claims stay Pending");
    if (!parts.length) return { severity, text: "It is used, but nothing breaks." };
    const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    return { severity, text: text.charAt(0).toUpperCase() + text.slice(1) + "." };
  }
  function hotspots(snap2, limit = 12) {
    const idx = new Index(snap2);
    const kinds = ["nodes", "persistentvolumeclaims", "configmaps", "secrets", "services", "storageclasses"];
    const out = [];
    for (const kind of kinds) {
      for (const ref of candidates(snap2, kind)) {
        if (kind === "configmaps" && ref.name === "kube-root-ca.crt") continue;
        const impact = blastRadius(snap2, ref, idx);
        if (impact.score > 0) out.push(impact);
      }
    }
    return out.sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id)).slice(0, limit);
  }

  // src/model/overview.ts
  var SURVEY_KINDS = ["nodes", "persistentvolumeclaims", "storageclasses", "configmaps", "secrets", "services"];
  function consequences(impact) {
    const out = { down: 0, stuck: 0, degraded: 0, restart: 0, info: 0 };
    for (const n of impact.nodes) if (n.column >= 2) out[n.severity]++;
    return out;
  }
  function stats(impacts) {
    const workloads = /* @__PURE__ */ new Set();
    const services = /* @__PURE__ */ new Set();
    const entries = /* @__PURE__ */ new Set();
    const bySeverity2 = { down: 0, stuck: 0, degraded: 0, restart: 0, info: 0 };
    let spof = 0;
    for (const impact of impacts) {
      const sev = impact.verdict.severity;
      if (sev) bySeverity2[sev]++;
      let downstreamDown = false;
      for (const n of impact.nodes) {
        if (n.column === 2 && (n.severity === "down" || n.severity === "stuck")) workloads.add(n.id);
        if (n.column === 3 && n.severity === "down") services.add(n.id);
        if (n.column === 4 && n.severity === "down") entries.add(n.id);
        if (n.column >= 2 && n.severity === "down") downstreamDown = true;
      }
      if (downstreamDown) spof++;
    }
    return {
      risky: impacts.length,
      spof,
      workloadsAtRisk: workloads.size,
      servicesAtRisk: services.size,
      entriesAtRisk: entries.size,
      bySeverity: bySeverity2
    };
  }
  var RINGS = [
    { severity: "down", inner: 0.1, outer: 0.34 },
    { severity: "stuck", inner: 0.34, outer: 0.56 },
    { severity: "degraded", inner: 0.56, outer: 0.78 },
    { severity: "restart", inner: 0.78, outer: 0.96 }
  ];
  var TOP_GAP = 0.36;
  function radarLayout(impacts, maxDots = 80) {
    const shown = [...impacts].sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id)).slice(0, maxDots);
    const order = (kind) => {
      const i = SURVEY_KINDS.indexOf(kind);
      return i < 0 ? SURVEY_KINDS.length : i;
    };
    const byKind = /* @__PURE__ */ new Map();
    for (const impact of shown) {
      const kind = impact.target.ref.kind;
      const list = byKind.get(kind);
      if (list) list.push(impact);
      else byKind.set(kind, [impact]);
    }
    const kinds = [...byKind.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    const total = shown.length;
    const maxScore = Math.max(1, ...shown.map((i) => i.score));
    const sectors = [];
    const dots = [];
    const minShare = kinds.length ? Math.min(1 / kinds.length, 0.08) : 0;
    const raw = kinds.map((k) => Math.max(minShare, Math.sqrt(byKind.get(k).length / Math.max(1, total))));
    const sum = raw.reduce((a, b) => a + b, 0) || 1;
    const room = Math.PI * 2 - TOP_GAP;
    let angle = TOP_GAP / 2;
    kinds.forEach((kind, k) => {
      const span = raw[k] / sum * room;
      const list = byKind.get(kind);
      sectors.push({ kind, start: angle, end: angle + span, count: list.length });
      const pad = Math.min(span * 0.08, 0.06);
      const usable = span - pad * 2;
      const lanes = list.length > 5 ? 3 : 1;
      list.forEach((impact, i) => {
        const sev = ringOf(impact.verdict.severity);
        const ring = RINGS.find((r) => r.severity === sev) ?? RINGS[RINGS.length - 1];
        const depth = 1 - impact.score / maxScore;
        const lane = lanes === 1 ? 0 : i % lanes - 1;
        const t = clamp(0.5 + lane * 0.32 + (depth - 0.5) * (lanes === 1 ? 0.6 : 0.15), 0.1, 0.9);
        const radius = ring.inner + (ring.outer - ring.inner) * t;
        const a = angle + pad + (list.length === 1 ? usable / 2 : usable * (i + 0.5) / list.length);
        dots.push({
          id: impact.target.id,
          ref: impact.target.ref,
          severity: sev,
          score: impact.score,
          x: Math.sin(a) * radius,
          y: -Math.cos(a) * radius,
          size: 0.016 + 0.03 * Math.sqrt(impact.score / maxScore)
        });
      });
      angle += span;
    });
    return { sectors, dots, hidden: Math.max(0, impacts.length - shown.length) };
  }
  function ringOf(sev) {
    if (!sev || sev === "info") return "restart";
    return SEVERITIES.includes(sev) ? sev : "restart";
  }
  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  // src/ui/common.ts
  function message(err) {
    return err instanceof Error ? err.message : String(err);
  }
  function showError(err) {
    const node = document.getElementById("error");
    if (!node) return;
    node.textContent = message(err);
    node.hidden = false;
  }
  function clearError() {
    const node = document.getElementById("error");
    if (node) node.hidden = true;
  }
  function readHash() {
    const out = {};
    for (const pair of location.hash.replace(/^#/, "").split("&")) {
      const cut = pair.indexOf("=");
      if (cut <= 0) continue;
      try {
        out[pair.slice(0, cut)] = decodeURIComponent(pair.slice(cut + 1));
      } catch {
      }
    }
    return out;
  }
  function writeHash(values) {
    const text = Object.entries(values).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    try {
      history.replaceState(null, "", text ? "#" + text : location.pathname);
    } catch {
      try {
        location.hash = text;
      } catch {
      }
    }
  }
  var FOCUS_KEY = "focus";
  async function takeHandOver() {
    const store = k8sdockside.storage;
    if (!store) return null;
    try {
      const ref = await store.get(FOCUS_KEY);
      if (ref) await store.remove(FOCUS_KEY);
      return ref && typeof ref.kind === "string" && typeof ref.name === "string" ? { kind: ref.kind, namespace: ref.namespace ?? "", name: ref.name } : null;
    } catch {
      return null;
    }
  }
  function chip(severity, text = SEVERITY_LABEL[severity]) {
    return el("span", { class: `chip sev-${severity}` }, text);
  }
  function refLabel(ref) {
    return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
  }
  function kindTag(kind) {
    return el("span", { class: "kind" }, kindLabel(kind));
  }
  function open(ref) {
    void k8sdockside.open({ kind: ref.kind, namespace: ref.namespace || void 0, name: ref.name }).catch(showError);
  }
  function when() {
    const now = /* @__PURE__ */ new Date();
    return k8sdockside.format?.time(now) ?? now.toLocaleTimeString();
  }
  var LOGO = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".35"/><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".65"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>`;

  // src/ui/load.ts
  var KINDS = [
    ["pods", "pods"],
    ["replicasets", "replicasets"],
    ["deployments", "deployments"],
    ["statefulsets", "statefulsets"],
    ["daemonsets", "daemonsets"],
    ["jobs", "jobs"],
    ["cronjobs", "cronjobs"],
    ["services", "services"],
    ["ingresses", "ingresses"],
    ["httproutes", HTTPROUTES],
    ["pvcs", "persistentvolumeclaims"],
    ["pvs", "persistentvolumes"],
    ["storageclasses", "storageclasses"],
    ["configmaps", "configmaps"],
    ["nodes", "nodes"],
    ["pdbs", "poddisruptionbudgets"],
    ["serviceaccounts", "serviceaccounts"]
  ];
  async function loadSnapshot() {
    const snap2 = emptySnapshot();
    const missing = [];
    await Promise.all(
      KINDS.map(async ([field, kind]) => {
        try {
          snap2[field] = await k8sdockside.list({ kind });
        } catch (err) {
          if (field === "pods") throw err;
          if (kind !== HTTPROUTES) missing.push(kind);
        }
      })
    );
    return { snap: snap2, missing };
  }

  // src/pages/radius.ts
  var snap = null;
  var index = null;
  var target = null;
  var pickKind = "nodes";
  var pickNs = "";
  var stopResize = null;
  var showQuiet = false;
  var survey = null;
  var hotKind = "";
  var kindSel = byId("kind");
  var nsSel = byId("namespace");
  var nameSel = byId("name");
  var main = byId("main");
  async function start() {
    const ctx = await k8sdockside.ready();
    byId("logo").append(svg(LOGO, "mark"));
    byId("where").textContent = ctx.contextName;
    for (const kind of TARGET_KINDS) kindSel.append(el("option", { value: kind }, kindLabel(kind)));
    kindSel.addEventListener("change", () => {
      pickKind = kindSel.value;
      pickNs = "";
      target = null;
      fillPickers();
      render();
    });
    nsSel.addEventListener("change", () => {
      pickNs = nsSel.value;
      target = null;
      fillPickers();
      render();
    });
    nameSel.addEventListener("change", () => {
      const name = nameSel.value;
      target = name ? { kind: pickKind, namespace: CLUSTER_SCOPED.has(pickKind) ? "" : pickNs, name } : null;
      render();
    });
    byId("clear").addEventListener("click", () => {
      target = null;
      fillPickers();
      render();
    });
    byId("refresh").addEventListener("click", () => void refresh());
    const hash = readHash();
    const handed = await takeHandOver();
    if (handed) target = handed;
    else if (hash.kind && hash.name) target = { kind: hash.kind, namespace: hash.ns ?? "", name: hash.name };
    if (target) {
      pickKind = target.kind;
      pickNs = target.namespace;
    } else if (hash.kind) pickKind = hash.kind;
    await refresh();
  }
  async function refresh() {
    try {
      const loaded = await loadSnapshot();
      snap = loaded.snap;
      index = new Index(snap);
      survey = null;
      clearError();
      const missing = byId("missing");
      missing.hidden = !loaded.missing.length;
      missing.textContent = loaded.missing.length ? `Could not read ${loaded.missing.join(", ")}; what depends on them is left out.` : "";
      byId("where").textContent = `${(await k8sdockside.ready()).contextName} · read at ${when()}`;
      fillPickers();
      render();
    } catch (err) {
      showError(err);
    }
  }
  function fillPickers() {
    if (!snap) return;
    kindSel.value = pickKind;
    const all = candidates(snap, pickKind);
    const scoped = !CLUSTER_SCOPED.has(pickKind);
    byId("ns-wrap").hidden = !scoped;
    if (scoped) {
      const namespaces = [...new Set(all.map((r) => r.namespace))].sort();
      if (!namespaces.includes(pickNs)) pickNs = namespaces.includes("default") ? "default" : namespaces[0] ?? "";
      replace(nsSel, ...namespaces.map((ns) => el("option", { value: ns }, ns)));
      nsSel.value = pickNs;
    }
    const names = all.filter((r) => !scoped || r.namespace === pickNs).map((r) => r.name).sort();
    replace(nameSel, el("option", { value: "" }, names.length ? `Pick one of ${names.length}…` : "None here"), ...names.map((n) => el("option", { value: n }, n)));
    nameSel.value = target && target.kind === pickKind && names.includes(target.name) ? target.name : "";
  }
  function pick(ref) {
    target = ref;
    pickKind = ref.kind;
    pickNs = ref.namespace;
    fillPickers();
    render();
    main.scrollTo?.({ top: 0 });
    window.scrollTo({ top: 0 });
  }
  function render() {
    stopResize?.();
    stopResize = null;
    if (!snap || !index) return;
    writeHash(target ? { kind: target.kind, ns: target.namespace, name: target.name } : { kind: pickKind });
    if (!target) return renderHotspots();
    const full = blastRadius(snap, target, index);
    const quiet = full.nodes.filter((n) => n.severity === "info").length;
    const shown = showQuiet ? full : trimQuiet(full);
    const toggle = el("label", { class: "toggle small" }, el("input", { type: "checkbox" }), `Show ${quiet} touched but unaffected`);
    const box = toggle.querySelector("input");
    box.checked = showQuiet;
    box.addEventListener("change", () => {
      showQuiet = box.checked;
      render();
    });
    replace(main, verdictCard(full), quiet ? toggle : null, graph(shown), notes(full), table(shown));
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs = {}, text) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text !== void 0) node.textContent = text;
    return node;
  }
  var R = 100;
  function renderHotspots() {
    survey ??= hotspots(snap, Infinity);
    const all = survey;
    if (hotKind && !all.some((i) => i.target.ref.kind === hotKind)) hotKind = "";
    const st = stats(all);
    const radar = radarLayout(all);
    const shown = all.filter((i) => !hotKind || i.target.ref.kind === hotKind).slice(0, 24);
    const dots = /* @__PURE__ */ new Map();
    const cards = /* @__PURE__ */ new Map();
    const byTarget = new Map(all.map((i) => [i.target.id, i]));
    const readout = el("div", { class: "readout" });
    const idleReadout = () => replace(
      readout,
      el("div", { class: "readout-title" }, all.length ? "Pick a dot" : "All clear"),
      el("div", { class: "dim small" }, all.length ? "Each dot is one object imagined gone. The nearer the bullseye and the bigger, the more breaks with it." : "No single node, claim, ConfigMap, Secret, Service or StorageClass takes anything down with it.")
    );
    const focus = (id) => {
      for (const [key, g] of dots) g.classList.toggle("lit", key === id);
      for (const [key, c2] of cards) c2.classList.toggle("lit", key === id);
      radarBox.classList.toggle("focusing", id !== null && dots.has(id));
      const impact = id ? byTarget.get(id) : void 0;
      if (!impact) return idleReadout();
      const c = consequences(impact);
      replace(
        readout,
        el("div", { class: "readout-head" }, kindTag(impact.target.ref.kind), el("span", { class: `score sev-${impact.verdict.severity ?? "info"}` }, `impact ${impact.score}`)),
        el("div", { class: "readout-title" }, refLabel(impact.target.ref)),
        el("div", { class: "dim small" }, impact.verdict.text),
        severityBar(c),
        el("div", { class: "faint small" }, "Click to see the whole blast")
      );
    };
    const chart = s("svg", { viewBox: `${-R * 1.66} ${-R * 1.22} ${R * 3.32} ${R * 2.44}`, class: "radar", role: "img" });
    chart.append(s("title", {}, `Radar of ${all.length} objects whose loss would break something`));
    for (const ring of [...RINGS].reverse()) {
      chart.append(s("circle", { r: ring.outer * R, class: `ring sev-${ring.severity}` }));
    }
    chart.append(s("circle", { r: RINGS[0].inner * R, class: "bullseye" }));
    for (const sector of radar.sectors) {
      for (const a of sector === radar.sectors.at(-1) ? [sector.start, sector.end] : [sector.start]) {
        const edge = polar(a, R * 0.98);
        chart.append(s("line", { x1: 0, y1: 0, x2: edge.x, y2: edge.y, class: "spoke" }));
      }
      const mid = (sector.start + sector.end) / 2;
      const at = polar(mid, R * 1.1);
      const anchor = Math.abs(at.x) < R * 0.2 ? "middle" : at.x > 0 ? "start" : "end";
      const label = s("text", { x: at.x, y: at.y, "text-anchor": anchor, "dominant-baseline": "middle", class: `sector-label${hotKind === sector.kind ? " on" : ""}` }, `${kindLabel(sector.kind)} · ${sector.count}`);
      label.addEventListener("click", () => setHotKind(hotKind === sector.kind ? "" : sector.kind));
      chart.append(label);
    }
    for (const ring of RINGS) {
      chart.append(s("text", { x: 0, y: -ring.outer * R + 6.5, "text-anchor": "middle", class: "ring-label" }, SEVERITY_LABEL[ring.severity]));
    }
    for (const dot of radar.dots) chart.append(dotMark(dot, dots, focus));
    if (!all.length) {
      chart.classList.add("clear");
      chart.append(s("path", { d: "M-9,0 L-3,6 L9,-6", class: "all-clear" }));
    }
    const radarBox = el("div", { class: "radar-box" }, el("div", { class: "sweep", "aria-hidden": "true" }));
    radarBox.append(chart);
    radarBox.addEventListener("mouseleave", () => focus(null));
    const tiles = el(
      "div",
      { class: "tiles" },
      tile(st.spof, "Single points of failure", "objects whose loss takes a workload, Service or entry point fully down"),
      tile(st.workloadsAtRisk, "Workloads exposed", "go down or cannot come back after one loss"),
      tile(st.servicesAtRisk, "Services exposed", "left with no endpoints after one loss"),
      tile(st.entriesAtRisk, "Entry points exposed", "Ingresses and HTTPRoutes that stop answering")
    );
    const legend = el(
      "div",
      { class: "legend" },
      el("div", { class: "faint small legend-title" }, `${all.length} ${all.length === 1 ? "object" : "objects"} would break something · worst loss`),
      severityBar(st.bySeverity, true),
      el("div", { class: "chips" }, ...SEVERITIES.filter((sv) => sv !== "info" && st.bySeverity[sv] > 0).map((sv) => chip(sv, `${st.bySeverity[sv]} · ${SEVERITY_LABEL[sv]}`)))
    );
    const steps = el(
      "ol",
      { class: "steps small" },
      el("li", {}, el("b", {}, "Pick"), " a dot, a card, or any object in the pickers above"),
      el("li", {}, el("b", {}, "See"), " what breaks, from the object to the front door"),
      el("li", {}, el("b", {}, "Follow"), " the chain: anything it reaches can be the next target")
    );
    idleReadout();
    const hero = el(
      "section",
      { class: "hero" },
      el("div", { class: "hero-radar" }, radarBox, readout, radar.hidden ? el("div", { class: "faint small" }, `${radar.hidden} smaller ones are left off the radar.`) : null),
      el(
        "div",
        { class: "hero-side" },
        el("div", {}, el("h2", {}, "Where it would hurt most"), el("p", { class: "dim intro-text" }, "Every node, claim, ConfigMap, Secret, Service and StorageClass, imagined gone one at a time.")),
        tiles,
        all.length ? legend : null,
        steps
      )
    );
    const counts = /* @__PURE__ */ new Map();
    for (const i of all) counts.set(i.target.ref.kind, (counts.get(i.target.ref.kind) ?? 0) + 1);
    const filter = el(
      "div",
      { class: "filter" },
      filterChip("", `All · ${all.length}`),
      ...SURVEY_KINDS.filter((k) => counts.has(k)).map((k) => filterChip(k, `${kindLabel(k)} · ${counts.get(k)}`))
    );
    const max = Math.max(1, ...all.map((i) => i.score));
    const list = all.length ? el(
      "section",
      { class: "ranked" },
      el("div", { class: "ranked-head" }, el("h3", {}, "Ranked by impact"), filter),
      el("div", { class: "hot-grid" }, ...shown.map((impact) => hotCard(impact, all.indexOf(impact) + 1, max, cards, focus)))
    ) : null;
    replace(main, hero, list);
  }
  function setHotKind(kind) {
    hotKind = kind;
    renderHotspots();
  }
  function filterChip(kind, text) {
    const b = button(text, () => setHotKind(kind), { class: `pill${hotKind === kind ? " on" : ""}` });
    b.setAttribute("aria-pressed", String(hotKind === kind));
    return b;
  }
  function polar(angle, radius) {
    return { x: Math.sin(angle) * radius, y: -Math.cos(angle) * radius };
  }
  function dotMark(dot, dots, focus) {
    const g = s("g", { class: `dot sev-${dot.severity}`, tabindex: 0, role: "button", transform: `translate(${(dot.x * R).toFixed(2)},${(dot.y * R).toFixed(2)})` });
    g.setAttribute("aria-label", `${kindLabel(dot.ref.kind)} ${refLabel(dot.ref)}, impact ${dot.score}`);
    g.append(s("title", {}, `${kindLabel(dot.ref.kind)} ${refLabel(dot.ref)} · impact ${dot.score}`));
    const r = dot.size * R;
    g.append(s("circle", { r: r * 1.9, class: "halo" }), s("circle", { r, class: "core" }));
    g.addEventListener("mouseenter", () => focus(dot.id));
    g.addEventListener("focus", () => focus(dot.id));
    g.addEventListener("click", () => pick(dot.ref));
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick(dot.ref);
      }
    });
    dots.set(dot.id, g);
    return g;
  }
  function tile(n, label, hint) {
    return el(
      "div",
      { class: `tile ${n ? "bad" : "good"}` },
      el("div", { class: "tile-n" }, String(n)),
      el("div", { class: "tile-label" }, label),
      el("div", { class: "faint small" }, n ? hint : "none — nice")
    );
  }
  function severityBar(counts, tall = false) {
    const parts = SEVERITIES.filter((sv) => sv !== "info" && counts[sv] > 0);
    const bar = el("div", { class: `sevbar${tall ? " tall" : ""}` });
    for (const sv of parts) {
      const seg = el("span", { class: `sev-${sv}`, title: `${counts[sv]} · ${SEVERITY_LABEL[sv]}` });
      seg.style.flexGrow = String(counts[sv]);
      bar.append(seg);
    }
    if (!parts.length) bar.append(el("span", { class: "sev-info" }));
    return bar;
  }
  function hotCard(impact, rank, max, cards, focus) {
    const t = impact.target;
    const c = consequences(impact);
    const counts = SEVERITIES.filter((sv) => sv !== "info" && c[sv] > 0);
    const meter = el("div", { class: "meter", title: "How much would break, weighted by how badly" }, el("span", {}));
    meter.firstChild.style.width = `${Math.max(4, impact.score / max * 100)}%`;
    const card = el(
      "button",
      { type: "button", class: `hot sev-${impact.verdict.severity ?? "info"}` },
      el(
        "div",
        { class: "hot-head" },
        el("span", { class: "rank" }, `#${rank}`),
        kindTag(t.ref.kind),
        el("span", { class: "grow" }),
        el("span", { class: "score", title: "How much would break, weighted by how badly" }, String(impact.score))
      ),
      el("div", { class: "hot-name" }, refLabel(t.ref)),
      meter,
      el("div", { class: "hot-text dim" }, impact.verdict.text),
      counts.length ? severityBar(c) : null,
      el("div", { class: "chips" }, ...counts.map((sv) => chip(sv, `${c[sv]} · ${SEVERITY_LABEL[sv]}`)))
    );
    card.addEventListener("click", () => pick(t.ref));
    card.addEventListener("mouseenter", () => focus(t.id));
    card.addEventListener("mouseleave", () => focus(null));
    cards.set(t.id, card);
    return card;
  }
  function verdictCard(impact) {
    const t = impact.target.ref;
    const sev = impact.verdict.severity;
    const actions = el("div", { class: "actions" });
    if (impact.target.openable) actions.append(button("Open", () => open(t), { class: "ghost" }));
    return el(
      "section",
      { class: `verdict sev-${sev ?? "none"}` },
      el(
        "div",
        { class: "verdict-main" },
        el("div", { class: "scenario" }, impact.scenario),
        el("div", { class: "verdict-text" }, impact.found ? impact.verdict.text : `${kindLabel(t.kind)} ${refLabel(t)} is not in the cluster.`),
        el(
          "div",
          { class: "chips" },
          ...SEVERITIES.map((s2) => [s2, impact.nodes.filter((n) => n.severity === s2).length]).filter(([, n]) => n > 0).map(([s2, n]) => chip(s2, `${n} · ${SEVERITY_LABEL[s2]}`))
        )
      ),
      actions
    );
  }
  function graph(impact) {
    const wrap = el("section", { class: "graph-wrap" });
    if (!impact.nodes.length) return wrap;
    const columns = [.../* @__PURE__ */ new Set([0, ...impact.nodes.map((n) => n.column)])].sort();
    const grid = el("div", { class: "graph" });
    grid.style.gridTemplateColumns = `repeat(${columns.length}, minmax(200px, 1fr))`;
    const cards = /* @__PURE__ */ new Map();
    const byId2 = new Map([[impact.target.id, impact.target], ...impact.nodes.map((n) => [n.id, n])]);
    for (const col of columns) {
      const inCol = col === 0 ? [impact.target] : impact.nodes.filter((n) => n.column === col).sort(bySeverity);
      const column = el("div", { class: "col" }, el("div", { class: "col-head faint small" }, `${COLUMN_LABEL[col]} · ${inCol.length}`));
      for (const node of inCol) {
        const card = nodeCard(node, node === impact.target);
        cards.set(node.id, card);
        column.append(card);
      }
      grid.append(column);
    }
    const lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    lines.setAttribute("class", "edges");
    wrap.append(lines, grid);
    const draw = () => {
      const box = wrap.getBoundingClientRect();
      lines.setAttribute("width", String(wrap.scrollWidth));
      lines.setAttribute("height", String(wrap.scrollHeight));
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
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
        path.setAttribute("class", `edge sev-${byId2.get(edge.to)?.severity ?? "info"}`);
        path.dataset.from = edge.from;
        path.dataset.to = edge.to;
        lines.append(path);
      }
    };
    const related = (id) => {
      const seen = /* @__PURE__ */ new Set([id]);
      const walk = (key, other) => {
        const queue = [id];
        while (queue.length) {
          const at = queue.pop();
          for (const e of impact.edges) {
            if (e[key] === at && !seen.has(e[other])) {
              seen.add(e[other]);
              queue.push(e[other]);
            }
          }
        }
      };
      walk("from", "to");
      walk("to", "from");
      return seen;
    };
    for (const [id, card] of cards) {
      card.addEventListener("mouseenter", () => {
        const lit = related(id);
        wrap.classList.add("focusing");
        for (const [other, c] of cards) c.classList.toggle("lit", lit.has(other));
        for (const p of lines.querySelectorAll("path")) {
          const path = p;
          path.classList.toggle("lit", lit.has(path.dataset.from ?? "") && lit.has(path.dataset.to ?? ""));
        }
      });
      card.addEventListener("mouseleave", () => wrap.classList.remove("focusing"));
    }
    requestAnimationFrame(draw);
    const observer = new ResizeObserver(() => draw());
    observer.observe(wrap);
    wrap.addEventListener("scroll", draw, { passive: true });
    stopResize = () => observer.disconnect();
    return wrap;
  }
  function trimQuiet(impact) {
    const keep = /* @__PURE__ */ new Set([impact.target.id, ...impact.nodes.filter((n) => n.severity !== "info").map((n) => n.id)]);
    return { ...impact, nodes: impact.nodes.filter((n) => keep.has(n.id)), edges: impact.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
  }
  function bySeverity(a, b) {
    return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || refLabel(a.ref).localeCompare(refLabel(b.ref));
  }
  function nodeCard(node, isTarget) {
    const card = el(
      "div",
      { class: `node sev-${isTarget ? "target" : node.severity}`, tabindex: "0" },
      el("div", { class: "node-head" }, kindTag(node.ref.kind), node.detail ? el("span", { class: "faint small" }, node.detail) : null),
      el("div", { class: "node-name", title: refLabel(node.ref) }, isTarget || !node.ref.namespace ? node.ref.name : refLabel(node.ref)),
      node.reason ? el("div", { class: "node-reason" }, node.reason) : null
    );
    const foot = el("div", { class: "node-foot" });
    if (!isTarget && node.targetable) foot.append(button("Its blast radius", () => pick(node.ref), { class: "link" }));
    if (node.openable) foot.append(button("Open", () => open(node.ref), { class: "link" }));
    if (foot.childElementCount) card.append(foot);
    return card;
  }
  function notes(impact) {
    if (!impact.notes.length) return null;
    return el("section", { class: "notes" }, el("h3", {}, "Worth knowing"), el("ul", {}, ...impact.notes.map((n) => el("li", {}, n))));
  }
  function table(impact) {
    if (!impact.nodes.length) return null;
    const rows = [...impact.nodes].sort(bySeverity).map((n) => {
      const name = n.openable ? button(refLabel(n.ref), () => open(n.ref), { class: "link" }) : el("span", {}, refLabel(n.ref));
      return el("tr", {}, el("td", {}, chip(n.severity)), el("td", {}, kindTag(n.ref.kind)), el("td", {}, name), el("td", { class: "faint" }, n.detail), el("td", { class: "dim" }, n.reason));
    });
    return el(
      "section",
      { class: "list" },
      el("h3", {}, "Everything it reaches"),
      el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Effect"), el("th", {}, "Kind"), el("th", {}, "Object"), el("th", {}, ""), el("th", {}, "Why"))), el("tbody", {}, ...rows))
    );
  }
  start().catch(showError);
})();
