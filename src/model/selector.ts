// Label selectors, as the API server matches them.

export type Labels = Record<string, string>;

export interface LabelSelectorRequirement {
    key: string;
    operator: string;
    values?: string[];
}

export interface LabelSelector {
    matchLabels?: Labels;
    matchExpressions?: LabelSelectorRequirement[];
}

/**
 * Whether `labels` satisfy a LabelSelector. An empty selector matches
 * everything; a missing one (`undefined`) matches nothing, which is how a
 * PodDisruptionBudget or a Service without one behaves.
 */
export function matches(selector: LabelSelector | undefined | null, labels: Labels | undefined): boolean {
    if (!selector) return false;
    const have = labels ?? {};
    for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
        if (have[key] !== value) return false;
    }
    for (const req of selector.matchExpressions ?? []) {
        const present = Object.prototype.hasOwnProperty.call(have, req.key);
        const values = req.values ?? [];
        switch (req.operator) {
            case 'In':
                if (!present || !values.includes(have[req.key] as string)) return false;
                break;
            case 'NotIn':
                if (present && values.includes(have[req.key] as string)) return false;
                break;
            case 'Exists':
                if (!present) return false;
                break;
            case 'DoesNotExist':
                if (present) return false;
                break;
            default:
                // An operator the API server would have refused: match nothing
                // rather than everything.
                return false;
        }
    }
    return true;
}

/** A Service's selector: a plain map, where an empty or missing one selects no pods. */
export function matchesMap(selector: Labels | undefined, labels: Labels | undefined): boolean {
    if (!selector || Object.keys(selector).length === 0) return false;
    return matches({ matchLabels: selector }, labels);
}
