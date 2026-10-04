// Evaluator for Firebase Realtime Database security rules (the JSON files
// rtdb-rules.json / rtdb-social-rules.json from the ReKindle repo).
//
// Rule expressions are JavaScript-like, so they are compiled with
// `new Function`. They come from the repository, never from users.

import { UPSTREAM_ADMIN_EMAIL } from './config.js';

// String helpers the rules language has but JavaScript does not.
function defineStringHelper(name, fn) {
    if (!Object.prototype.hasOwnProperty.call(String.prototype, name)) {
        Object.defineProperty(String.prototype, name, { value: fn, writable: true, configurable: true, enumerable: false });
    }
}
defineStringHelper('beginsWith', function (s) { return String(this).startsWith(s); });
defineStringHelper('contains', function (s) { return String(this).includes(s); });
defineStringHelper('matches', function (re) { return (re instanceof RegExp ? re : new RegExp(re)).test(String(this)); });

export function splitPath(p) {
    return String(p || '').split('/').filter(Boolean);
}

export function getIn(tree, parts) {
    let cur = tree;
    for (const k of parts) {
        if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, k)) return null;
        cur = cur[k];
    }
    return cur === undefined ? null : cur;
}

class RuleSnap {
    constructor(root, parts) {
        this._root = root;
        this._parts = parts;
    }
    val() { return getIn(this._root, this._parts); }
    child(p) { return new RuleSnap(this._root, this._parts.concat(splitPath(p))); }
    parent() { return new RuleSnap(this._root, this._parts.slice(0, -1)); }
    exists() { return this.val() !== null; }
    hasChild(p) { return this.child(p).exists(); }
    hasChildren(list) {
        const v = this.val();
        if (v === null || typeof v !== 'object') return false;
        if (!list) return Object.keys(v).length > 0;
        return list.every((k) => this.child(k).exists());
    }
    isString() { return typeof this.val() === 'string'; }
    isNumber() { return typeof this.val() === 'number'; }
    isBoolean() { return typeof this.val() === 'boolean'; }
    getPriority() { return null; }
}

function compileExpr(src, vars) {
    if (typeof src === 'boolean') return () => src;
    let code = String(src);
    // The upstream rules hard-code the original developer's account; point it at this server's admin.
    code = code.split(`'${UPSTREAM_ADMIN_EMAIL}'`).join('__adminEmail').split(`"${UPSTREAM_ADMIN_EMAIL}"`).join('__adminEmail');
    let fn;
    try {
        fn = new Function('auth', 'root', 'data', 'newData', 'now', '__adminEmail', ...vars, `return (${code});`);
    } catch (e) {
        console.warn(`[rules] could not compile expression, treating as false: ${src} (${e.message})`);
        return () => false;
    }
    return (ctx) => {
        try {
            const args = vars.map((v) => ctx.vars[v]);
            return fn(ctx.auth, ctx.root, ctx.data, ctx.newData, Date.now(), ctx.adminEmail, ...args) === true;
        } catch {
            return false;
        }
    };
}

function compileNode(obj, vars) {
    const node = { read: null, write: null, validate: null, children: Object.create(null), wildcard: null };
    if (!obj || typeof obj !== 'object') return node;
    for (const [key, val] of Object.entries(obj)) {
        if (key === '.read') node.read = compileExpr(val, vars);
        else if (key === '.write') node.write = compileExpr(val, vars);
        else if (key === '.validate') node.validate = compileExpr(val, vars);
        else if (key.startsWith('.')) continue; // .indexOn etc.
        else if (key.startsWith('$')) node.wildcard = { name: key, node: compileNode(val, [...vars, key]) };
        else node.children[key] = compileNode(val, vars);
    }
    return node;
}

export function compileRules(json) {
    const rules = (json && json.rules) || {};
    return compileNode(rules, []);
}

// Nodes that apply at each depth along `parts`, with wildcard bindings.
function nodesAlong(rootNode, parts) {
    const out = [{ node: rootNode, depth: 0, vars: {} }];
    let cur = rootNode;
    let vars = {};
    for (let i = 0; i < parts.length; i++) {
        let next = cur.children[parts[i]];
        if (!next && cur.wildcard) {
            vars = { ...vars, [cur.wildcard.name]: parts[i] };
            next = cur.wildcard.node;
        }
        if (!next) break;
        cur = next;
        out.push({ node: cur, depth: i + 1, vars });
    }
    return out;
}

function childNode(node, key, vars) {
    if (node.children[key]) return { node: node.children[key], vars };
    if (node.wildcard) return { node: node.wildcard.node, vars: { ...vars, [node.wildcard.name]: key } };
    return null;
}

export function canRead(rules, auth, adminEmail, root, path) {
    const parts = splitPath(path);
    const rootSnap = new RuleSnap(root, []);
    for (const { node, depth, vars } of nodesAlong(rules, parts)) {
        if (!node.read) continue;
        const ctx = { auth, root: rootSnap, data: new RuleSnap(root, parts.slice(0, depth)), newData: undefined, vars, adminEmail };
        if (node.read(ctx)) return true;
    }
    return false;
}

export function canWrite(rules, auth, adminEmail, oldRoot, newRoot, path) {
    const parts = splitPath(path);
    const rootSnap = new RuleSnap(oldRoot, []);
    let granted = false;
    const along = nodesAlong(rules, parts);
    for (const { node, depth, vars } of along) {
        if (!node.write) continue;
        const p = parts.slice(0, depth);
        const ctx = { auth, root: rootSnap, data: new RuleSnap(oldRoot, p), newData: new RuleSnap(newRoot, p), vars, adminEmail };
        if (node.write(ctx)) { granted = true; break; }
    }
    if (!granted) return false;

    // .validate on ancestors whose new value is non-null.
    for (const { node, depth, vars } of along) {
        if (depth >= parts.length || !node.validate) continue;
        const p = parts.slice(0, depth);
        if (getIn(newRoot, p) === null) continue;
        const ctx = { auth, root: rootSnap, data: new RuleSnap(oldRoot, p), newData: new RuleSnap(newRoot, p), vars, adminEmail };
        if (!node.validate(ctx)) return false;
    }

    // .validate at the written location and everything below it.
    const last = along[along.length - 1];
    if (last.depth !== parts.length) return true; // no rules this deep
    return validateTree(last.node, last.vars, parts);

    function validateTree(node, vars, p) {
        const nv = getIn(newRoot, p);
        if (nv === null) return true;
        if (node.validate) {
            const ctx = { auth, root: rootSnap, data: new RuleSnap(oldRoot, p), newData: new RuleSnap(newRoot, p), vars, adminEmail };
            if (!node.validate(ctx)) return false;
        }
        if (typeof nv === 'object') {
            for (const key of Object.keys(nv)) {
                const c = childNode(node, key, vars);
                if (c && !validateTree(c.node, c.vars, p.concat(key))) return false;
            }
        }
        return true;
    }
}
