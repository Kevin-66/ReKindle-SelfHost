// Document values travel and are stored as JSON with a few tagged objects:
//   { $ts: [seconds, nanos] }   Timestamp
//   { $geo: [lat, lng] }        GeoPoint
//   { $ref: "coll/doc" }        DocumentReference
//   { $fv: "serverTimestamp" | "increment" | "delete" | "arrayUnion" | "arrayRemove", n?, v? }
//                               FieldValue sentinels (writes only)

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function isTagged(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v)
        && (hasOwn(v, '$ts') || hasOwn(v, '$geo') || hasOwn(v, '$ref') || hasOwn(v, '$fv') || hasOwn(v, '$bytes'));
}

export function isMap(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v) && !isTagged(v);
}

export function tsFromMillis(ms) {
    const s = Math.floor(ms / 1000);
    return { $ts: [s, Math.round((ms - s * 1000) * 1e6)] };
}

export function tsToMillis(v) {
    return v.$ts[0] * 1000 + v.$ts[1] / 1e6;
}

function typeOrder(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'boolean') return 1;
    if (typeof v === 'number') return 2;
    if (typeof v === 'string') return 4;
    if (Array.isArray(v)) return 8;
    if (hasOwn(v, '$ts')) return 3;
    if (hasOwn(v, '$bytes')) return 5;
    if (hasOwn(v, '$ref')) return 6;
    if (hasOwn(v, '$geo')) return 7;
    return 9;
}

export function compareValues(a, b) {
    const ta = typeOrder(a), tb = typeOrder(b);
    if (ta !== tb) return ta - tb;
    switch (ta) {
        case 0: return 0;
        case 1: return a === b ? 0 : (a ? 1 : -1);
        case 2:
            if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : -1;
            if (Number.isNaN(b)) return 1;
            return a < b ? -1 : (a > b ? 1 : 0);
        case 3: return (a.$ts[0] - b.$ts[0]) || (a.$ts[1] - b.$ts[1]);
        case 4: return a < b ? -1 : (a > b ? 1 : 0);
        case 5: return a.$bytes < b.$bytes ? -1 : (a.$bytes > b.$bytes ? 1 : 0);
        case 6: {
            const pa = String(a.$ref).split('/'), pb = String(b.$ref).split('/');
            for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
                if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
            }
            return pa.length - pb.length;
        }
        case 7: return (a.$geo[0] - b.$geo[0]) || (a.$geo[1] - b.$geo[1]);
        case 8: {
            for (let i = 0; i < Math.min(a.length, b.length); i++) {
                const c = compareValues(a[i], b[i]);
                if (c) return c;
            }
            return a.length - b.length;
        }
        default: {
            const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
            for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
                if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
                const c = compareValues(a[ka[i]], b[kb[i]]);
                if (c) return c;
            }
            return ka.length - kb.length;
        }
    }
}

export function valuesEqual(a, b) {
    return typeOrder(a) === typeOrder(b) && compareValues(a, b) === 0;
}

export function sameTypeClass(a, b) {
    return typeOrder(a) === typeOrder(b);
}

export function splitField(path) {
    return String(path).split('.');
}

export function getField(data, path) {
    let cur = data;
    for (const seg of splitField(path)) {
        if (!isMap(cur) || !hasOwn(cur, seg)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

// Resolve FieldValue sentinels in `value` (which will be stored at `old`'s position).
export function resolveValue(value, old, now) {
    if (value === null || value === undefined) return value === undefined ? undefined : null;
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, undefined, now));
    if (typeof value !== 'object') return value;
    if (hasOwn(value, '$fv')) {
        switch (value.$fv) {
            case 'serverTimestamp': return tsFromMillis(now);
            case 'delete': return undefined;
            case 'increment': {
                const n = Number(value.n) || 0;
                return (typeof old === 'number' ? old : 0) + n;
            }
            case 'arrayUnion': {
                const arr = Array.isArray(old) ? old.slice() : [];
                for (const el of value.v || []) if (!arr.some((x) => valuesEqual(x, el))) arr.push(el);
                return arr;
            }
            case 'arrayRemove': {
                const arr = Array.isArray(old) ? old : [];
                return arr.filter((x) => !(value.v || []).some((el) => valuesEqual(x, el)));
            }
            default: return null;
        }
    }
    if (isTagged(value)) return value;
    const out = {};
    for (const k of Object.keys(value)) {
        const r = resolveValue(value[k], isMap(old) ? old[k] : undefined, now);
        if (r !== undefined) out[k] = r;
    }
    return out;
}

// set(..., { merge: true }): maps merge recursively, everything else replaces.
export function deepMerge(old, patch, now) {
    const out = isMap(old) ? { ...old } : {};
    for (const k of Object.keys(patch)) {
        const pv = patch[k];
        if (isMap(pv) && !hasOwn(pv, '$fv')) {
            out[k] = deepMerge(out[k], pv, now);
        } else {
            const r = resolveValue(pv, out[k], now);
            if (r === undefined) delete out[k];
            else out[k] = r;
        }
    }
    return out;
}

// Write `value` at a dotted field path, creating intermediate maps.
export function setField(data, path, value, now) {
    const segs = splitField(path);
    const root = isMap(data) ? { ...data } : {};
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
        const next = isMap(cur[segs[i]]) ? { ...cur[segs[i]] } : {};
        cur[segs[i]] = next;
        cur = next;
    }
    const last = segs[segs.length - 1];
    const r = resolveValue(value, cur[last], now);
    if (r === undefined) delete cur[last];
    else cur[last] = r;
    return root;
}

// Top-level keys whose values differ between two documents.
export function affectedKeys(oldData, newData) {
    const keys = new Set([...Object.keys(oldData || {}), ...Object.keys(newData || {})]);
    const out = [];
    for (const k of keys) {
        const a = oldData ? oldData[k] : undefined;
        const b = newData ? newData[k] : undefined;
        if (a === undefined || b === undefined) {
            if (a !== b) out.push(k);
        } else if (!valuesEqual(a, b)) {
            out.push(k);
        }
    }
    return out;
}
