// Change feed for realtime listeners.
//
// Every write to the document store or the realtime database is recorded as
// (seq, kind, ns, path). Browsers long-poll /__rk/poll with the paths they are
// watching and the last sequence number they have seen; the poll returns as
// soon as something they watch changes. The page then re-reads that data.

const RING_SIZE = 20000;
const ring = [];
let seq = 0;
const waiters = new Set();

export function currentSeq() {
    return seq;
}

function parentPath(p) {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
}

export function watchMatches(kind, wns, wpath, ev) {
    if (ev.k !== kind || ev.ns !== wns) return false;
    if (kind === 'db') {
        const a = wpath || '';
        const b = ev.path || '';
        if (!a || !b || a === b) return true;
        return b.startsWith(a + '/') || a.startsWith(b + '/');
    }
    if (wpath.startsWith('group:')) {
        const parts = ev.path.split('/');
        return parts.length >= 2 && parts[parts.length - 2] === wpath.slice(6);
    }
    const segs = wpath.split('/').length;
    if (segs % 2 === 0) return wpath === ev.path;
    return parentPath(ev.path) === wpath;
}

function hitsSince(since, watches) {
    const hits = new Set();
    const oldest = ring.length ? ring[0].seq : seq + 1;
    if (since < oldest - 1) {
        // Too far behind: tell the client to refresh everything.
        for (const w of watches) hits.add(w[0]);
        return [...hits];
    }
    for (let i = ring.length - 1; i >= 0; i--) {
        const ev = ring[i];
        if (ev.seq <= since) break;
        for (const w of watches) {
            if (!hits.has(w[0]) && watchMatches(w[1], w[2], w[3], ev)) hits.add(w[0]);
        }
    }
    return [...hits];
}

export function emit(k, ns, path) {
    seq++;
    const ev = { seq, k, ns, path };
    ring.push(ev);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
    for (const w of [...waiters]) {
        for (const watch of w.watches) {
            if (watchMatches(watch[1], watch[2], watch[3], ev)) {
                w.wake();
                break;
            }
        }
    }
}

// Resolves with { seq, hits } as soon as a watched path changes, or after `timeoutMs`.
export function waitForChanges(since, watches, timeoutMs, onAbort) {
    return new Promise((resolve) => {
        if (since === null || since === undefined || typeof since !== 'number') {
            resolve({ seq, hits: [] });
            return;
        }
        const now = hitsSince(since, watches);
        if (now.length || since > seq) {
            resolve({ seq, hits: now });
            return;
        }
        let done = false;
        const w = {
            watches,
            wake: () => {
                // Let writes that arrive together settle into one response.
                setTimeout(finish, 15);
            }
        };
        function finish() {
            if (done) return;
            done = true;
            clearTimeout(timer);
            waiters.delete(w);
            resolve({ seq, hits: hitsSince(since, watches) });
        }
        const timer = setTimeout(finish, timeoutMs);
        waiters.add(w);
        onAbort(() => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            waiters.delete(w);
        });
    });
}

export function activeWaiters() {
    return waiters.size;
}
