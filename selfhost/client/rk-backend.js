/*
 * ReKindle self-hosted backend client.
 *
 * Drop-in replacement for the Firebase "compat" SDK scripts
 * (firebase-app / auth / firestore / database / functions / storage).
 * Exposes the same global `firebase` object, but every call goes to the
 * ReKindle server this page was loaded from (under /__rk/) instead of Google.
 *
 * Written in plain ES5 + Promise so it runs on old e-ink browsers (the lite and
 * legacy builds transpile/polyfill it further). Realtime updates use HTTP
 * long-polling, which every browser supports.
 */
(function (global) {
    'use strict';

    if (global.firebase && global.firebase.__rk) return;

    var API = '/__rk';
    // Every app (including the old "social" one) shares one data space on this server.
    var DEFAULT_NS = 'rekindle-dd1fa';

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    function noop() { }

    function later(fn) { setTimeout(fn, 0); }

    function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

    function isPlainObject(v) {
        if (v === null || typeof v !== 'object') return false;
        var proto = Object.getPrototypeOf(v);
        return proto === Object.prototype || proto === null;
    }

    function clone(v) {
        if (v === null || v === undefined || typeof v !== 'object') return v;
        return JSON.parse(JSON.stringify(v));
    }

    function makeError(code, message, details) {
        var e = new Error(message || code);
        e.code = code;
        e.name = 'FirebaseError';
        if (details !== undefined) e.details = details;
        return e;
    }

    function randomId(len, chars) {
        chars = chars || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        var out = '';
        var buf = null;
        try {
            var c = global.crypto || global.msCrypto;
            if (c && c.getRandomValues) { buf = new Uint8Array(len); c.getRandomValues(buf); }
        } catch (e) { buf = null; }
        for (var i = 0; i < len; i++) {
            var r = buf ? buf[i] : Math.floor(Math.random() * 256);
            out += chars.charAt(r % chars.length);
        }
        return out;
    }

    function storageGet(key) {
        try { return global.localStorage.getItem(key); } catch (e) { return null; }
    }
    function storageSet(key, val) {
        try {
            if (val === null) global.localStorage.removeItem(key);
            else global.localStorage.setItem(key, val);
        } catch (e) { }
    }

    function normPath(p) {
        if (p === undefined || p === null) return '';
        return String(p).split('/').filter(function (s) { return s.length > 0; }).join('/');
    }

    function joinPath(a, b) {
        var na = normPath(a), nb = normPath(b);
        if (!na) return nb;
        if (!nb) return na;
        return na + '/' + nb;
    }

    function lastSegment(p) {
        var parts = normPath(p).split('/');
        return parts[parts.length - 1] || null;
    }

    function parentPath(p) {
        var parts = normPath(p).split('/');
        parts.pop();
        return parts.join('/');
    }

    // ------------------------------------------------------------------
    // HTTP
    // ------------------------------------------------------------------

    var serverTimeOffset = 0;

    function request(method, url, body, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            if (opts.timeout) xhr.timeout = opts.timeout;
            var headers = opts.headers || {};
            for (var h in headers) if (hasOwn(headers, h) && headers[h] !== undefined && headers[h] !== null) xhr.setRequestHeader(h, headers[h]);
            var payload = null;
            if (body !== undefined && body !== null) {
                if (opts.raw) {
                    payload = body;
                } else {
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    payload = JSON.stringify(body);
                }
            }
            if (opts.onProgress && xhr.upload) {
                xhr.upload.onprogress = function (ev) { opts.onProgress(ev.loaded, ev.total); };
            }
            if (opts.xhrRef) opts.xhrRef(xhr);
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 0) {
                    reject(makeError(opts.aborted ? 'aborted' : 'unavailable', 'Network request failed'));
                    return;
                }
                var t = xhr.getResponseHeader('X-RK-Time');
                if (t) serverTimeOffset = parseInt(t, 10) - Date.now();
                var data = null;
                var text = xhr.responseText;
                if (text) {
                    try { data = JSON.parse(text); } catch (e) { data = null; }
                }
                if (xhr.status >= 200 && xhr.status < 300 && !(data && data.error)) {
                    Hub.setConnected(true);
                    resolve(data || {});
                } else {
                    var err = (data && data.error) || {};
                    reject(makeError(err.code || ('http-' + xhr.status), err.message || ('Request failed (' + xhr.status + ')'), err.details));
                }
            };
            xhr.send(payload);
        });
    }

    // Authenticated JSON call. `auth` may be null (anonymous).
    function call(auth, path, body) {
        var tokenP = auth ? auth._getToken() : Promise.resolve(null);
        return tokenP.then(function (token) {
            var headers = {};
            if (token) headers.Authorization = 'Bearer ' + token;
            return request('POST', API + path, body, { headers: headers });
        });
    }

    // ------------------------------------------------------------------
    // Realtime hub: one long-poll per page carrying every active watch.
    // ------------------------------------------------------------------

    var Hub = {
        cid: randomId(20),
        since: null,
        watches: {},
        nextId: 1,
        xhr: null,
        running: false,
        offline: false,
        keepAlive: 0,
        connected: false,
        connListeners: [],
        backoff: 0,
        restartTimer: null,

        add: function (spec, onChange) {
            var id = 'w' + (this.nextId++);
            this.watches[id] = { spec: spec, cb: onChange };
            this.scheduleRestart();
            return id;
        },

        remove: function (id) {
            if (hasOwn(this.watches, id)) {
                delete this.watches[id];
                this.scheduleRestart();
            }
        },

        // A fetch that was answered at server sequence `seq`: make sure the
        // poll covers every change after it.
        observed: function (seq) {
            if (typeof seq !== 'number') return;
            if (this.since === null || seq < this.since) {
                this.since = seq;
                this.scheduleRestart();
            }
        },

        hasWork: function () {
            for (var k in this.watches) if (hasOwn(this.watches, k)) return true;
            return this.keepAlive > 0 || this.connListeners.length > 0;
        },

        scheduleRestart: function () {
            var self = this;
            if (this.restartTimer) return;
            this.restartTimer = setTimeout(function () {
                self.restartTimer = null;
                self.restart();
            }, 30);
        },

        restart: function () {
            if (this.xhr) {
                var x = this.xhr;
                this.xhr = null;
                x._rkAborted = true;
                try { x.abort(); } catch (e) { }
            }
            this.running = false;
            if (!this.offline && this.hasWork()) this.poll();
        },

        poll: function () {
            var self = this;
            if (this.running) return;
            this.running = true;
            var list = [];
            for (var id in this.watches) {
                if (!hasOwn(this.watches, id)) continue;
                var s = this.watches[id].spec;
                list.push([id, s.k, s.ns, s.path]);
            }
            var myXhr = null;
            var body = { cid: this.cid, since: this.since, w: list };
            request('POST', API + '/poll', body, {
                timeout: 40000,
                xhrRef: function (x) { myXhr = x; self.xhr = x; }
            }).then(function (res) {
                if (self.xhr !== myXhr) return; // superseded
                self.xhr = null;
                self.running = false;
                self.backoff = 0;
                self.setConnected(true);
                if (typeof res.seq === 'number') self.since = res.seq;
                var hits = res.hits || [];
                for (var i = 0; i < hits.length; i++) {
                    var w = self.watches[hits[i]];
                    if (w) { try { w.cb(); } catch (e) { logError(e); } }
                }
                if (!self.offline && self.hasWork()) self.poll();
            }, function () {
                if (myXhr && myXhr._rkAborted) return;
                if (self.xhr !== myXhr) return;
                self.xhr = null;
                self.running = false;
                self.setConnected(false);
                self.backoff = Math.min(self.backoff ? self.backoff * 2 : 1000, 15000);
                setTimeout(function () {
                    if (!self.running && !self.offline && self.hasWork()) self.poll();
                }, self.backoff);
            });
        },

        // A write made by this page: refresh matching listeners right away.
        localChange: function (k, ns, path) {
            for (var id in this.watches) {
                if (!hasOwn(this.watches, id)) continue;
                var w = this.watches[id];
                if (w.spec.k === k && w.spec.ns === ns && specMatches(w.spec, path)) {
                    (function (cb) { later(function () { try { cb(); } catch (e) { logError(e); } }); })(w.cb);
                }
            }
        },

        setConnected: function (v) {
            if (this.connected === v) return;
            this.connected = v;
            var ls = this.connListeners.slice();
            for (var i = 0; i < ls.length; i++) { try { ls[i](v); } catch (e) { logError(e); } }
        },

        goOffline: function () {
            this.offline = true;
            this.restart();
            this.bye();
            this.setConnected(false);
        },

        goOnline: function () {
            if (!this.offline) return;
            this.offline = false;
            this.cid = randomId(20);
            this.restart();
        },

        bye: function () {
            var url = API + '/bye?cid=' + encodeURIComponent(this.cid);
            try {
                if (global.navigator && global.navigator.sendBeacon) { global.navigator.sendBeacon(url, ''); return; }
            } catch (e) { }
            try {
                var x = new XMLHttpRequest();
                x.open('POST', url, false);
                x.send('');
            } catch (e2) { }
        }
    };

    function specMatches(spec, changedPath) {
        if (spec.k === 'db') {
            var a = spec.path, b = changedPath;
            if (!a || !b || a === b) return true;
            return b.indexOf(a + '/') === 0 || a.indexOf(b + '/') === 0;
        }
        // Firestore: doc watch matches the doc; collection watch matches direct children.
        if (spec.path.indexOf('group:') === 0) {
            var parts = changedPath.split('/');
            return parts.length >= 2 && parts[parts.length - 2] === spec.path.substring(6);
        }
        var segs = spec.path.split('/').length;
        if (segs % 2 === 0) return spec.path === changedPath;
        return parentPath(changedPath) === spec.path;
    }

    function logError(e) {
        if (global.console && global.console.error) global.console.error(e);
    }

    if (global.addEventListener) {
        global.addEventListener('pagehide', function () { Hub.bye(); });
        global.addEventListener('beforeunload', function () { Hub.bye(); });
    }

    // ------------------------------------------------------------------
    // Apps
    // ------------------------------------------------------------------

    var appList = [];
    var appMap = {};

    function App(options, name) {
        this.name = name;
        this.options = options || {};
        this.automaticDataCollectionEnabled = false;
        this._ns = DEFAULT_NS;
        this._services = {};
    }
    App.prototype._service = function (key, factory) {
        if (!this._services[key]) this._services[key] = factory();
        return this._services[key];
    };
    App.prototype.auth = function () {
        var app = this;
        return this._service('auth', function () { return new Auth(app); });
    };
    App.prototype.firestore = function () {
        var app = this;
        return this._service('firestore', function () { return new Firestore(app); });
    };
    App.prototype.database = function () {
        var app = this;
        return this._service('database', function () { return new Database(app, app._ns); });
    };
    App.prototype.functions = function () {
        var app = this;
        return this._service('functions', function () { return new Functions(app); });
    };
    App.prototype.storage = function () {
        var app = this;
        return this._service('storage', function () { return new Storage(app); });
    };
    App.prototype['delete'] = function () {
        var idx = appList.indexOf(this);
        if (idx !== -1) appList.splice(idx, 1);
        delete appMap[this.name];
        return Promise.resolve();
    };

    function initializeApp(options, name) {
        name = (typeof name === 'string' && name) ? name : (name && name.name) || '[DEFAULT]';
        if (appMap[name]) {
            throw makeError('app/duplicate-app', 'Firebase App named \'' + name + '\' already exists (app/duplicate-app).');
        }
        var app = new App(options, name);
        appMap[name] = app;
        appList.push(app);
        return app;
    }

    function getApp(name) {
        name = name || '[DEFAULT]';
        if (!appMap[name]) {
            throw makeError('app/no-app', 'No Firebase App \'' + name + '\' has been created - call Firebase App.initializeApp() (app/no-app).');
        }
        return appMap[name];
    }

    // ------------------------------------------------------------------
    // Auth
    // ------------------------------------------------------------------

    function decodeJwt(token) {
        try {
            var part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            while (part.length % 4) part += '=';
            var json = decodeURIComponent(Array.prototype.map.call(atob(part), function (c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));
            return JSON.parse(json);
        } catch (e) { return {}; }
    }

    function User(auth, info) {
        this._auth = auth;
        this._apply(info);
        this.isAnonymous = false;
        this.emailVerified = true;
        this.phoneNumber = null;
        this.tenantId = null;
        this.providerId = 'firebase';
    }
    User.prototype._apply = function (info) {
        this.uid = info.uid;
        this.email = info.email || null;
        this.displayName = info.displayName || null;
        this.photoURL = info.photoURL || null;
        this.metadata = {
            creationTime: info.createdAt ? new Date(info.createdAt).toUTCString() : null,
            lastSignInTime: info.lastLoginAt ? new Date(info.lastLoginAt).toUTCString() : null
        };
        this.providerData = [{
            providerId: 'password', uid: this.email, email: this.email,
            displayName: this.displayName, photoURL: this.photoURL, phoneNumber: null
        }];
    };
    User.prototype.getIdToken = function (forceRefresh) {
        return this._auth._getToken(!!forceRefresh);
    };
    User.prototype.getIdTokenResult = function (forceRefresh) {
        return this._auth._getToken(!!forceRefresh).then(function (token) {
            var c = decodeJwt(token);
            return {
                token: token,
                claims: c,
                authTime: c.auth_time ? new Date(c.auth_time * 1000).toUTCString() : null,
                issuedAtTime: c.iat ? new Date(c.iat * 1000).toUTCString() : null,
                expirationTime: c.exp ? new Date(c.exp * 1000).toUTCString() : null,
                signInProvider: (c.firebase && c.firebase.sign_in_provider) || 'password',
                signInSecondFactor: null
            };
        });
    };
    User.prototype.reload = function () {
        var self = this;
        return this._auth._getToken(true).then(function () { return undefined; }, function () { return undefined; }).then(function () { return self._auth._refreshProfile(); });
    };
    User.prototype.updatePassword = function (pw) {
        return this._auth._update({ password: pw });
    };
    User.prototype.updateEmail = function () {
        return Promise.reject(makeError('auth/operation-not-allowed', 'Changing the username is not supported on this server.'));
    };
    User.prototype.updateProfile = function (p) {
        p = p || {};
        return this._auth._update({ displayName: p.displayName, photoURL: p.photoURL });
    };
    User.prototype.reauthenticateWithCredential = function (cred) {
        var auth = this._auth;
        return request('POST', API + '/auth/signin', { email: cred.email, password: cred.password, ns: auth._ns }).then(function (res) {
            auth._setSession(res);
            return { user: auth.currentUser, credential: null, operationType: 'reauthenticate', additionalUserInfo: { isNewUser: false, providerId: 'password' } };
        }, translateAuthError);
    };
    User.prototype.reauthenticateAndRetrieveDataWithCredential = User.prototype.reauthenticateWithCredential;
    User.prototype.sendEmailVerification = function () { return Promise.resolve(); };
    User.prototype['delete'] = function () {
        var auth = this._auth;
        return call(auth, '/auth/delete', { ns: auth._ns }).then(function () { auth._clear(); });
    };
    User.prototype.toJSON = function () {
        return { uid: this.uid, email: this.email, displayName: this.displayName, photoURL: this.photoURL };
    };

    function translateAuthError(e) {
        throw e;
    }

    // ReKindle's js/i18n.js rewrites every [data-i18n] element (including the
    // "Guest Mode" label) once its locale file loads. With Firebase the first
    // auth callback usually came later than that; keep that order here.
    function afterTranslations(cb) {
        var doc = global.document;
        var hasI18n = doc && doc.querySelector && doc.querySelector('script[src*="i18n.js"]');
        // i18n.js publishes an empty object first and swaps in the loaded strings later.
        var loaded = function () {
            var t = global.rekindleTranslations;
            if (!t || typeof t !== 'object') return false;
            for (var k in t) if (hasOwn(t, k)) return true;
            return false;
        };
        if (!hasI18n || loaded()) { cb(); return; }
        var waited = 0;
        (function check() {
            if (loaded() || waited >= 1500) { cb(); return; }
            waited += 50;
            setTimeout(check, 50);
        })();
    }

    function Auth(app) {
        var self = this;
        this.app = app;
        this._ns = app._ns;
        this._key = 'rk_auth:' + app.name;
        this._listeners = [];
        this._tokenListeners = [];
        this.currentUser = null;
        this.languageCode = null;
        this.tenantId = null;
        this.settings = { appVerificationDisabledForTesting: false };
        this._session = null;
        this._refreshing = null;
        this._initialized = false;
        var raw = storageGet(this._key);
        if (raw) {
            try {
                var s = JSON.parse(raw);
                if (s && s.refreshToken && s.user) this._session = s;
            } catch (e) { }
        }
        // Like Firebase, confirm a saved sign-in with the server before reporting
        // it; pages rely on the first auth callback arriving after that round trip.
        var finishInit = function () {
            afterTranslations(function () {
                self._initialized = true;
                self._notify();
            });
        };
        if (this._session) {
            var saved = this._session;
            this._refreshing = request('POST', API + '/auth/refresh', { refreshToken: saved.refreshToken, ns: this._ns }).then(function (res) {
                self._refreshing = null;
                self._applySession(res);
                return res.idToken;
            }, function (e) {
                self._refreshing = null;
                if (e.code && e.code.indexOf('auth/') === 0) {
                    self._session = null;
                    storageSet(self._key, null);
                    return null;
                }
                // Offline: keep the saved session.
                self.currentUser = new User(self, saved.user);
                return saved.idToken || null;
            });
            this._refreshing.then(finishInit, finishInit);
        } else {
            later(finishInit);
        }
        // Mirror sign-in/out from other tabs.
        if (global.addEventListener) {
            global.addEventListener('storage', function (ev) {
                if (ev.key !== self._key || !self._initialized) return;
                var before = self.currentUser ? self.currentUser.uid : null;
                var s2 = null;
                try { s2 = ev.newValue ? JSON.parse(ev.newValue) : null; } catch (e) { s2 = null; }
                self._session = s2;
                if (s2 && s2.user) {
                    if (self.currentUser && self.currentUser.uid === s2.user.uid) self.currentUser._apply(s2.user);
                    else self.currentUser = new User(self, s2.user);
                } else {
                    self.currentUser = null;
                }
                var after = self.currentUser ? self.currentUser.uid : null;
                if (before !== after) self._notify();
            });
        }
    }

    Auth.prototype._notify = function () {
        if (!this._initialized) return;
        var user = this.currentUser;
        var ls = this._listeners.slice();
        for (var i = 0; i < ls.length; i++) { try { ls[i](user); } catch (e) { logError(e); } }
        var ts = this._tokenListeners.slice();
        for (var j = 0; j < ts.length; j++) { try { ts[j](user); } catch (e2) { logError(e2); } }
    };

    // Store a session returned by the server; returns true if the signed-in user changed.
    Auth.prototype._applySession = function (res) {
        var before = this.currentUser ? this.currentUser.uid : null;
        var s = {
            idToken: res.idToken,
            refreshToken: res.refreshToken || (this._session && this._session.refreshToken),
            exp: (decodeJwt(res.idToken).exp || 0) * 1000,
            user: res.user
        };
        this._session = s;
        storageSet(this._key, JSON.stringify(s));
        if (this.currentUser && this.currentUser.uid === res.user.uid) this.currentUser._apply(res.user);
        else this.currentUser = new User(this, res.user);
        return before !== res.user.uid;
    };

    Auth.prototype._setSession = function (res) {
        var changed = this._applySession(res);
        if (!this._initialized) return;
        if (changed) {
            this._notify();
        } else {
            var ts = this._tokenListeners.slice();
            for (var j = 0; j < ts.length; j++) { try { ts[j](this.currentUser); } catch (e) { logError(e); } }
        }
    };

    Auth.prototype._clear = function () {
        var had = !!this.currentUser;
        this._session = null;
        this.currentUser = null;
        storageSet(this._key, null);
        if (had) this._notify();
    };

    Auth.prototype._getToken = function (force) {
        var self = this;
        var s = this._session;
        if (!s) return Promise.resolve(null);
        if (!force && s.idToken && s.exp - 120000 > Date.now() + serverTimeOffset) return Promise.resolve(s.idToken);
        if (this._refreshing) return this._refreshing;
        this._refreshing = request('POST', API + '/auth/refresh', { refreshToken: s.refreshToken, ns: this._ns }).then(function (res) {
            self._refreshing = null;
            self._setSession(res);
            return res.idToken;
        }, function (e) {
            self._refreshing = null;
            if (e.code && e.code.indexOf('auth/') === 0) {
                // Session revoked, user disabled or deleted.
                self._clear();
                return null;
            }
            // Offline: keep using the stored token if we have one.
            return s.idToken || null;
        });
        return this._refreshing;
    };

    Auth.prototype._refreshProfile = function () {
        return undefined;
    };

    Auth.prototype._update = function (fields) {
        var self = this;
        fields.ns = this._ns;
        return call(this, '/auth/update', fields).then(function (res) {
            if (res.idToken) self._setSession(res);
            return undefined;
        });
    };

    Auth.prototype._credential = function (res, isNew, provider) {
        return {
            user: this.currentUser,
            credential: null,
            operationType: 'signIn',
            additionalUserInfo: { isNewUser: !!isNew, providerId: provider || 'password', profile: {} }
        };
    };

    Auth.prototype.onAuthStateChanged = function (next, error, completed) {
        var self = this;
        var fn = typeof next === 'function' ? next : (next && next.next ? function (u) { next.next(u); } : noop);
        this._listeners.push(fn);
        // Before initialization finishes, the first callback comes from finishInit.
        if (this._initialized) {
            later(function () {
                if (self._listeners.indexOf(fn) !== -1) { try { fn(self.currentUser); } catch (e) { logError(e); } }
            });
        }
        return function () {
            var i = self._listeners.indexOf(fn);
            if (i !== -1) self._listeners.splice(i, 1);
        };
    };

    Auth.prototype.onIdTokenChanged = function (next) {
        var self = this;
        var fn = typeof next === 'function' ? next : (next && next.next ? function (u) { next.next(u); } : noop);
        this._tokenListeners.push(fn);
        if (this._initialized) {
            later(function () {
                if (self._tokenListeners.indexOf(fn) !== -1) { try { fn(self.currentUser); } catch (e) { logError(e); } }
            });
        }
        return function () {
            var i = self._tokenListeners.indexOf(fn);
            if (i !== -1) self._tokenListeners.splice(i, 1);
        };
    };

    Auth.prototype.signInWithEmailAndPassword = function (email, password) {
        var self = this;
        return request('POST', API + '/auth/signin', { email: email, password: password, ns: this._ns }).then(function (res) {
            self._setSession(res);
            return self._credential(res, false, 'password');
        });
    };

    Auth.prototype.createUserWithEmailAndPassword = function (email, password) {
        var self = this;
        return request('POST', API + '/auth/signup', { email: email, password: password, ns: this._ns }).then(function (res) {
            self._setSession(res);
            return self._credential(res, true, 'password');
        });
    };

    Auth.prototype.signInWithCustomToken = function (token) {
        var self = this;
        return request('POST', API + '/auth/custom', { token: token, ns: this._ns }).then(function (res) {
            self._setSession(res);
            return self._credential(res, false, 'custom');
        });
    };

    Auth.prototype.signInWithCredential = function (cred) {
        if (cred && cred.providerId === 'password') return this.signInWithEmailAndPassword(cred.email, cred.password);
        return Promise.reject(makeError('auth/operation-not-allowed', 'This sign-in method is not available on this server.'));
    };
    Auth.prototype.signInAndRetrieveDataWithCredential = Auth.prototype.signInWithCredential;

    Auth.prototype.signInAnonymously = function () {
        return Promise.reject(makeError('auth/operation-not-allowed', 'Anonymous sign-in is not available on this server.'));
    };
    Auth.prototype.signInWithPopup = function () {
        return Promise.reject(makeError('auth/operation-not-allowed', 'Popup sign-in is not available on this server.'));
    };
    Auth.prototype.signInWithRedirect = Auth.prototype.signInWithPopup;
    Auth.prototype.getRedirectResult = function () {
        return Promise.resolve({ user: null, credential: null, operationType: null, additionalUserInfo: null });
    };
    Auth.prototype.sendPasswordResetEmail = function () {
        return Promise.reject(makeError('auth/operation-not-allowed', 'Password reset emails are not available on this server. Ask the server admin to reset your password.'));
    };
    Auth.prototype.fetchSignInMethodsForEmail = function () { return Promise.resolve(['password']); };
    Auth.prototype.setPersistence = function () { return Promise.resolve(); };
    Auth.prototype.useDeviceLanguage = noop;
    Auth.prototype.useEmulator = noop;
    Auth.prototype.updateCurrentUser = function () { return Promise.resolve(); };

    Auth.prototype.signOut = function () {
        var s = this._session;
        this._clear();
        if (s && s.refreshToken) {
            return request('POST', API + '/auth/signout', { refreshToken: s.refreshToken }).then(noop, noop);
        }
        return Promise.resolve();
    };

    // ------------------------------------------------------------------
    // Firestore
    // ------------------------------------------------------------------

    function Timestamp(seconds, nanoseconds) {
        this.seconds = seconds;
        this.nanoseconds = nanoseconds || 0;
    }
    Timestamp.now = function () { return Timestamp.fromMillis(Date.now()); };
    Timestamp.fromDate = function (d) { return Timestamp.fromMillis(d.getTime()); };
    Timestamp.fromMillis = function (ms) {
        var s = Math.floor(ms / 1000);
        return new Timestamp(s, Math.round((ms - s * 1000) * 1e6));
    };
    Timestamp.prototype.toMillis = function () { return this.seconds * 1000 + this.nanoseconds / 1e6; };
    Timestamp.prototype.toDate = function () { return new Date(this.toMillis()); };
    Timestamp.prototype.isEqual = function (o) { return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; };
    Timestamp.prototype.toString = function () { return 'Timestamp(seconds=' + this.seconds + ', nanoseconds=' + this.nanoseconds + ')'; };
    Timestamp.prototype.toJSON = function () { return { seconds: this.seconds, nanoseconds: this.nanoseconds }; };
    Timestamp.prototype.valueOf = function () {
        // Same encoding as the Firebase SDK so <, > comparisons work.
        var adj = this.seconds - -62135596800;
        return String(adj).padStart ? String(adj).padStart(12, '0') + '.' + String(this.nanoseconds).padStart(9, '0')
            : ('000000000000' + adj).slice(-12) + '.' + ('000000000' + this.nanoseconds).slice(-9);
    };

    function GeoPoint(lat, lng) { this.latitude = lat; this.longitude = lng; }
    GeoPoint.prototype.isEqual = function (o) { return o instanceof GeoPoint && o.latitude === this.latitude && o.longitude === this.longitude; };
    GeoPoint.prototype.toJSON = function () { return { latitude: this.latitude, longitude: this.longitude }; };

    function FieldValue(kind, payload) { this._kind = kind; this._payload = payload; }
    FieldValue.serverTimestamp = function () { return new FieldValue('serverTimestamp'); };
    FieldValue['delete'] = function () { return new FieldValue('delete'); };
    FieldValue.increment = function (n) { return new FieldValue('increment', n); };
    FieldValue.arrayUnion = function () { return new FieldValue('arrayUnion', Array.prototype.slice.call(arguments)); };
    FieldValue.arrayRemove = function () { return new FieldValue('arrayRemove', Array.prototype.slice.call(arguments)); };
    FieldValue.prototype.isEqual = function (o) { return o instanceof FieldValue && o._kind === this._kind && JSON.stringify(o._payload) === JSON.stringify(this._payload); };

    function FieldPath() {
        this._segments = Array.prototype.slice.call(arguments);
    }
    FieldPath.documentId = function () { return new FieldPath('__name__'); };
    FieldPath.prototype.toString = function () { return this._segments.join('.'); };
    FieldPath.prototype.isEqual = function (o) { return o instanceof FieldPath && o.toString() === this.toString(); };

    function fieldPathString(f) {
        if (f instanceof FieldPath) return f.toString();
        return String(f);
    }

    function encodeValue(v, inArray) {
        if (v === null || v === undefined) return null;
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
        if (v instanceof Date) { var t = Timestamp.fromDate(v); return { $ts: [t.seconds, t.nanoseconds] }; }
        if (v instanceof Timestamp) return { $ts: [v.seconds, v.nanoseconds] };
        if (v instanceof GeoPoint) return { $geo: [v.latitude, v.longitude] };
        if (v instanceof DocumentReference) return { $ref: v.path };
        if (v instanceof FieldValue) {
            if (inArray) throw makeError('invalid-argument', 'FieldValue.' + v._kind + '() is not supported inside arrays');
            var o = { $fv: v._kind };
            if (v._kind === 'increment') o.n = v._payload;
            if (v._kind === 'arrayUnion' || v._kind === 'arrayRemove') o.v = v._payload.map(function (x) { return encodeValue(x, true); });
            return o;
        }
        if (Object.prototype.toString.call(v) === '[object Array]') {
            return v.map(function (x) { return encodeValue(x, true); });
        }
        if (typeof v === 'object') {
            if (typeof v.toDate === 'function' && typeof v.seconds === 'number') return { $ts: [v.seconds, v.nanoseconds || 0] };
            var out = {};
            for (var k in v) {
                if (!hasOwn(v, k) || v[k] === undefined) continue;
                out[k] = encodeValue(v[k], false);
            }
            return out;
        }
        return null;
    }

    function decodeValue(fs, v) {
        if (v === null || typeof v !== 'object') return v;
        if (Object.prototype.toString.call(v) === '[object Array]') {
            return v.map(function (x) { return decodeValue(fs, x); });
        }
        if (v.$ts) return new Timestamp(v.$ts[0], v.$ts[1]);
        if (v.$geo) return new GeoPoint(v.$geo[0], v.$geo[1]);
        if (v.$ref) return new DocumentReference(fs, v.$ref);
        var out = {};
        for (var k in v) if (hasOwn(v, k)) out[k] = decodeValue(fs, v[k]);
        return out;
    }

    function getField(obj, path) {
        if (path === '__name__') return undefined;
        var parts = path.split('.');
        var cur = obj;
        for (var i = 0; i < parts.length; i++) {
            if (cur === null || typeof cur !== 'object' || !hasOwn(cur, parts[i])) return undefined;
            cur = cur[parts[i]];
        }
        return cur;
    }

    function Firestore(app) {
        this.app = app;
        this._ns = app._ns;
        this._auth = app.auth();
    }
    Firestore.prototype.collection = function (path) {
        var p = normPath(path);
        if (p.split('/').length % 2 !== 1) throw makeError('invalid-argument', 'Invalid collection reference: ' + path);
        return new CollectionReference(this, p);
    };
    Firestore.prototype.doc = function (path) {
        var p = normPath(path);
        if (p.split('/').length % 2 !== 0) throw makeError('invalid-argument', 'Invalid document reference: ' + path);
        return new DocumentReference(this, p);
    };
    Firestore.prototype.collectionGroup = function (id) {
        return new Query(this, 'group:' + id, {});
    };
    Firestore.prototype.batch = function () { return new WriteBatch(this); };
    Firestore.prototype.runTransaction = function (fn) { return runTransaction(this, fn, 0); };
    Firestore.prototype.enablePersistence = function () { return Promise.resolve(); };
    Firestore.prototype.clearPersistence = function () { return Promise.resolve(); };
    Firestore.prototype.enableNetwork = function () { return Promise.resolve(); };
    Firestore.prototype.disableNetwork = function () { return Promise.resolve(); };
    Firestore.prototype.waitForPendingWrites = function () { return Promise.resolve(); };
    Firestore.prototype.terminate = function () { return Promise.resolve(); };
    Firestore.prototype.settings = noop;
    Firestore.prototype.useEmulator = noop;
    Firestore.prototype.onSnapshotsInSync = function () { return noop; };

    Firestore.prototype._call = function (body) {
        body.ns = this._ns;
        return call(this._auth, '/fs', body).then(function (res) {
            Hub.observed(res.s);
            return res;
        });
    };

    Firestore.prototype._commit = function (writes, reads) {
        var self = this;
        return this._call({ op: 'commit', writes: writes, reads: reads || [] }).then(function (res) {
            var seen = {};
            for (var i = 0; i < writes.length; i++) {
                if (!seen[writes[i].path]) { seen[writes[i].path] = 1; Hub.localChange('fs', self._ns, writes[i].path); }
            }
            return res;
        });
    };

    function DocumentReference(fs, path) {
        this.firestore = fs;
        this.path = path;
        this.id = lastSegment(path);
    }
    Object.defineProperty(DocumentReference.prototype, 'parent', {
        get: function () { return new CollectionReference(this.firestore, parentPath(this.path)); }
    });
    DocumentReference.prototype.collection = function (sub) {
        return new CollectionReference(this.firestore, joinPath(this.path, sub));
    };
    DocumentReference.prototype.isEqual = function (o) { return o instanceof DocumentReference && o.path === this.path && o.firestore === this.firestore; };
    DocumentReference.prototype.get = function () {
        var self = this;
        return this.firestore._call({ op: 'get', path: this.path }).then(function (res) {
            return new DocumentSnapshot(self.firestore, self.path, res.doc);
        });
    };
    DocumentReference.prototype.set = function (data, options) {
        return this.firestore._commit([setWrite(this.path, data, options)]).then(noop);
    };
    DocumentReference.prototype.update = function () {
        return this.firestore._commit([updateWrite(this.path, arguments)]).then(noop);
    };
    DocumentReference.prototype['delete'] = function () {
        return this.firestore._commit([{ type: 'delete', path: this.path }]).then(noop);
    };
    DocumentReference.prototype.onSnapshot = function () {
        var h = parseSnapshotArgs(arguments);
        return listenFs(this.firestore, this.path, { doc: true, path: this.path }, h);
    };
    DocumentReference.prototype.withConverter = function () { return this; };

    function setWrite(path, data, options) {
        var w = { type: 'set', path: path, data: encodeValue(data || {}, false) };
        if (options) {
            if (options.merge) w.merge = true;
            if (options.mergeFields) w.mergeFields = options.mergeFields.map(fieldPathString);
        }
        return w;
    }

    function updateWrite(path, args) {
        var fields = {};
        if (args.length === 1 && args[0] && typeof args[0] === 'object' && !(args[0] instanceof FieldPath)) {
            var d = args[0];
            for (var k in d) if (hasOwn(d, k) && d[k] !== undefined) fields[k] = encodeValue(d[k], false);
        } else {
            for (var i = 0; i + 1 < args.length; i += 2) {
                fields[fieldPathString(args[i])] = encodeValue(args[i + 1], false);
            }
        }
        return { type: 'update', path: path, fields: fields };
    }

    function Query(fs, path, q) {
        this.firestore = fs;
        this._path = path;
        this._q = q || {};
    }
    Query.prototype._with = function (patch) {
        var q = {};
        for (var k in this._q) if (hasOwn(this._q, k)) q[k] = this._q[k];
        for (var k2 in patch) if (hasOwn(patch, k2)) q[k2] = patch[k2];
        return new Query(this.firestore, this._path, q);
    };
    Query.prototype.where = function (field, op, value) {
        var f = (this._q.where || []).slice();
        var enc;
        if (fieldPathString(field) === '__name__') {
            var toId = function (x) { return x instanceof DocumentReference ? x.id : String(x).split('/').pop(); };
            enc = (op === 'in' || op === 'not-in') ? value.map(toId) : toId(value);
        } else {
            enc = encodeValue(value, true);
        }
        f.push([fieldPathString(field), op, enc]);
        return this._with({ where: f });
    };
    Query.prototype.orderBy = function (field, dir) {
        var o = (this._q.orderBy || []).slice();
        o.push([fieldPathString(field), dir === 'desc' ? 'desc' : 'asc']);
        return this._with({ orderBy: o });
    };
    Query.prototype.limit = function (n) { return this._with({ limit: n, limitToLast: null }); };
    Query.prototype.limitToLast = function (n) { return this._with({ limitToLast: n, limit: null }); };
    Query.prototype.offset = function (n) { return this._with({ offset: n }); };
    Query.prototype._cursor = function (args, inclusive) {
        var vals;
        if (args.length === 1 && args[0] instanceof DocumentSnapshot) {
            var snap = args[0];
            var orders = this._q.orderBy || [];
            vals = orders.map(function (o) { return o[0] === '__name__' ? snap.id : encodeValue(snap.get(o[0]), true); });
            return { values: vals, id: snap.id, inclusive: inclusive };
        }
        vals = Array.prototype.slice.call(args).map(function (v) { return encodeValue(v, true); });
        return { values: vals, inclusive: inclusive };
    };
    Query.prototype.startAt = function () { return this._with({ start: this._cursor(arguments, true) }); };
    Query.prototype.startAfter = function () { return this._with({ start: this._cursor(arguments, false) }); };
    Query.prototype.endAt = function () { return this._with({ end: this._cursor(arguments, true) }); };
    Query.prototype.endBefore = function () { return this._with({ end: this._cursor(arguments, false) }); };
    Query.prototype.get = function () {
        var self = this;
        return this.firestore._call({ op: 'query', path: this._path, q: this._q }).then(function (res) {
            return new QuerySnapshot(self, res.docs || [], null);
        });
    };
    Query.prototype.onSnapshot = function () {
        var h = parseSnapshotArgs(arguments);
        return listenFs(this.firestore, this._path, { doc: false, query: this }, h);
    };
    Query.prototype.isEqual = function (o) { return o instanceof Query && o._path === this._path && JSON.stringify(o._q) === JSON.stringify(this._q); };
    Query.prototype.withConverter = function () { return this; };
    Query.prototype.count = function () {
        var self = this;
        return { get: function () { return self.get().then(function (s) { return { data: function () { return { count: s.size }; } }; }); } };
    };

    function CollectionReference(fs, path) {
        Query.call(this, fs, path, {});
        this.path = path;
        this.id = lastSegment(path);
    }
    CollectionReference.prototype = Object.create(Query.prototype);
    CollectionReference.prototype.constructor = CollectionReference;
    Object.defineProperty(CollectionReference.prototype, 'parent', {
        get: function () {
            var p = parentPath(this.path);
            return p ? new DocumentReference(this.firestore, p) : null;
        }
    });
    CollectionReference.prototype.doc = function (id) {
        if (id === undefined || id === null || id === '') id = randomId(20);
        return new DocumentReference(this.firestore, joinPath(this.path, id));
    };
    CollectionReference.prototype.add = function (data) {
        var ref = this.doc();
        return ref.set(data).then(function () { return ref; });
    };
    CollectionReference.prototype.isEqual = function (o) { return o instanceof CollectionReference && o.path === this.path; };

    function DocumentSnapshot(fs, path, raw) {
        raw = raw || {};
        this._fs = fs;
        this._raw = raw;
        this.id = lastSegment(path);
        this.ref = new DocumentReference(fs, path);
        this.exists = !!raw.exists;
        this.metadata = { hasPendingWrites: false, fromCache: false, isEqual: function (o) { return !!o; } };
        this.createTime = raw.ct ? Timestamp.fromMillis(raw.ct) : undefined;
        this.updateTime = raw.ut ? Timestamp.fromMillis(raw.ut) : undefined;
        this.readTime = Timestamp.now();
    }
    DocumentSnapshot.prototype.data = function () {
        if (!this.exists) return undefined;
        return decodeValue(this._fs, this._raw.data || {});
    };
    DocumentSnapshot.prototype.get = function (field) {
        if (!this.exists) return undefined;
        var p = fieldPathString(field);
        if (p === '__name__') return this.id;
        return decodeValue(this._fs, getField(this._raw.data || {}, p));
    };
    DocumentSnapshot.prototype.isEqual = function (o) {
        return o instanceof DocumentSnapshot && o.ref.path === this.ref.path && JSON.stringify(o._raw) === JSON.stringify(this._raw);
    };

    function QuerySnapshot(query, rawDocs, prev) {
        var fs = query.firestore;
        this.query = query;
        this.docs = rawDocs.map(function (d) { return new DocumentSnapshot(fs, d.path, d); });
        this.size = this.docs.length;
        this.empty = this.docs.length === 0;
        this.metadata = { hasPendingWrites: false, fromCache: false, isEqual: function (o) { return !!o; } };
        this._changes = computeDocChanges(prev, this.docs);
    }
    QuerySnapshot.prototype.forEach = function (cb, thisArg) {
        for (var i = 0; i < this.docs.length; i++) cb.call(thisArg, this.docs[i]);
    };
    QuerySnapshot.prototype.docChanges = function () { return this._changes; };
    QuerySnapshot.prototype.isEqual = function (o) {
        return o instanceof QuerySnapshot && JSON.stringify(o.docs.map(function (d) { return d._raw; })) === JSON.stringify(this.docs.map(function (d) { return d._raw; }));
    };

    function computeDocChanges(prevDocs, docs) {
        var changes = [];
        var prev = prevDocs || [];
        var prevIdx = {};
        var i;
        for (i = 0; i < prev.length; i++) prevIdx[prev[i].ref.path] = i;
        var nowIdx = {};
        for (i = 0; i < docs.length; i++) nowIdx[docs[i].ref.path] = i;
        // Removals first, using indices from the old list.
        var shift = 0;
        for (i = 0; i < prev.length; i++) {
            if (!hasOwn(nowIdx, prev[i].ref.path)) {
                changes.push({ type: 'removed', doc: prev[i], oldIndex: i - shift, newIndex: -1 });
                shift++;
            }
        }
        for (i = 0; i < docs.length; i++) {
            var p = docs[i].ref.path;
            if (!hasOwn(prevIdx, p)) {
                changes.push({ type: 'added', doc: docs[i], oldIndex: -1, newIndex: i });
            } else if (JSON.stringify(prev[prevIdx[p]]._raw.data) !== JSON.stringify(docs[i]._raw.data)) {
                changes.push({ type: 'modified', doc: docs[i], oldIndex: prevIdx[p], newIndex: i });
            }
        }
        return changes;
    }

    function parseSnapshotArgs(args) {
        var a = Array.prototype.slice.call(args);
        if (a.length && a[0] && typeof a[0] === 'object' && typeof a[0].next !== 'function' && typeof a[0] !== 'function'
            && (hasOwn(a[0], 'includeMetadataChanges') || hasOwn(a[0], 'source'))) {
            a.shift();
        }
        if (a[0] && typeof a[0] === 'object' && typeof a[0] !== 'function') {
            var obs = a[0];
            return {
                next: obs.next ? function (x) { obs.next(x); } : noop,
                error: obs.error ? function (e) { obs.error(e); } : null
            };
        }
        return { next: a[0] || noop, error: typeof a[1] === 'function' ? a[1] : null };
    }

    function listenFs(fs, watchPath, target, handlers) {
        var active = true;
        var lastKey = null;
        var lastDocs = null;
        var inFlight = false;
        var dirty = false;
        var watchId = null;

        function deliverError(e) {
            if (!active) return;
            active = false;
            if (watchId) Hub.remove(watchId);
            if (handlers.error) { try { handlers.error(e); } catch (x) { logError(x); } }
            else logError(e);
        }

        function refetch() {
            if (!active) return;
            if (inFlight) { dirty = true; return; }
            inFlight = true;
            var p = target.doc
                ? fs._call({ op: 'get', path: target.path })
                : fs._call({ op: 'query', path: target.query._path, q: target.query._q });
            p.then(function (res) {
                inFlight = false;
                if (!active) return;
                var key = JSON.stringify(target.doc ? res.doc : res.docs);
                if (key !== lastKey) {
                    lastKey = key;
                    var snap;
                    if (target.doc) {
                        snap = new DocumentSnapshot(fs, target.path, res.doc);
                    } else {
                        snap = new QuerySnapshot(target.query, res.docs || [], lastDocs);
                        lastDocs = snap.docs;
                    }
                    try { handlers.next(snap); } catch (e) { logError(e); }
                }
                if (dirty) { dirty = false; refetch(); }
            }, function (e) {
                inFlight = false;
                if (e.code === 'permission-denied' || e.code === 'invalid-argument' || e.code === 'failed-precondition') {
                    deliverError(e);
                } else if (dirty) {
                    dirty = false;
                    setTimeout(refetch, 1000);
                }
            });
        }

        watchId = Hub.add({ k: 'fs', ns: fs._ns, path: watchPath }, refetch);
        refetch();
        return function () {
            if (!active) return;
            active = false;
            Hub.remove(watchId);
        };
    }

    function WriteBatch(fs) {
        this._fs = fs;
        this._writes = [];
    }
    WriteBatch.prototype.set = function (ref, data, options) { this._writes.push(setWrite(ref.path, data, options)); return this; };
    WriteBatch.prototype.update = function (ref) {
        this._writes.push(updateWrite(ref.path, Array.prototype.slice.call(arguments, 1)));
        return this;
    };
    WriteBatch.prototype['delete'] = function (ref) { this._writes.push({ type: 'delete', path: ref.path }); return this; };
    WriteBatch.prototype.commit = function () {
        if (!this._writes.length) return Promise.resolve();
        return this._fs._commit(this._writes).then(noop);
    };

    function Transaction(fs) {
        this._fs = fs;
        this._reads = [];
        this._writes = [];
    }
    Transaction.prototype.get = function (ref) {
        var self = this;
        return this._fs._call({ op: 'get', path: ref.path }).then(function (res) {
            self._reads.push({ path: ref.path, ut: (res.doc && res.doc.ut) || 0 });
            return new DocumentSnapshot(self._fs, ref.path, res.doc);
        });
    };
    Transaction.prototype.set = WriteBatch.prototype.set;
    Transaction.prototype.update = WriteBatch.prototype.update;
    Transaction.prototype['delete'] = WriteBatch.prototype['delete'];

    function runTransaction(fs, fn, attempt) {
        var tx = new Transaction(fs);
        var result;
        return Promise.resolve().then(function () { return fn(tx); }).then(function (r) {
            result = r;
            if (!tx._writes.length) return null;
            return fs._commit(tx._writes, tx._reads);
        }).then(function () { return result; }, function (e) {
            if (e && e.code === 'aborted' && attempt < 5) return runTransaction(fs, fn, attempt + 1);
            throw e;
        });
    }

    // ------------------------------------------------------------------
    // Realtime Database
    // ------------------------------------------------------------------

    var PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
    var lastPushTime = 0;
    var lastRandChars = [];
    function pushId() {
        var now = Date.now() + serverTimeOffset;
        var dup = now === lastPushTime;
        lastPushTime = now;
        var timeChars = new Array(8);
        for (var i = 7; i >= 0; i--) { timeChars[i] = PUSH_CHARS.charAt(now % 64); now = Math.floor(now / 64); }
        var id = timeChars.join('');
        if (!dup) {
            for (i = 0; i < 12; i++) lastRandChars[i] = Math.floor(Math.random() * 64);
        } else {
            for (i = 11; i >= 0 && lastRandChars[i] === 63; i--) lastRandChars[i] = 0;
            if (i >= 0) lastRandChars[i]++;
        }
        for (i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRandChars[i]);
        return id;
    }

    var INT_KEY = /^-?(0|[1-9][0-9]*)$/;
    function isIntKey(k) {
        if (!INT_KEY.test(k)) return false;
        var n = parseInt(k, 10);
        return n >= -2147483648 && n <= 2147483647;
    }
    function keyCompare(a, b) {
        if (a === b) return 0;
        var ai = isIntKey(a), bi = isIntKey(b);
        if (ai && bi) return parseInt(a, 10) - parseInt(b, 10);
        if (ai) return -1;
        if (bi) return 1;
        return a < b ? -1 : 1;
    }
    function rank(v) {
        if (v === null || v === undefined) return 0;
        if (v === false) return 1;
        if (v === true) return 2;
        if (typeof v === 'number') return 3;
        if (typeof v === 'string') return 4;
        return 5;
    }
    function valueCompare(a, b) {
        var ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (ra === 3) return a - b;
        if (ra === 4) return a < b ? -1 : (a > b ? 1 : 0);
        return 0;
    }

    function childVal(v, path) {
        if (!path) return v;
        var parts = path.split('/');
        var cur = v;
        for (var i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            if (cur === null || typeof cur !== 'object' || !hasOwn(cur, parts[i])) return null;
            cur = cur[parts[i]];
        }
        return cur === undefined ? null : cur;
    }

    function orderedKeys(v, q) {
        if (v === null || typeof v !== 'object') return [];
        var keys = Object.keys(v);
        var ob = q && q.orderBy;
        if (ob === 'child' || ob === 'value') {
            keys.sort(function (a, b) {
                var va = ob === 'value' ? v[a] : childVal(v[a], q.child);
                var vb = ob === 'value' ? v[b] : childVal(v[b], q.child);
                return valueCompare(va, vb) || keyCompare(a, b);
            });
        } else {
            keys.sort(keyCompare);
        }
        return keys;
    }

    function Database(app, ns) {
        this.app = app;
        this._ns = ns;
        this._auth = app.auth();
        this._groups = {};
    }
    Database.prototype.ref = function (path) { return new Reference(this, normPath(path), null); };
    Database.prototype.refFromURL = function (url) {
        var m = String(url).match(/^https?:\/\/[^\/]+\/?(.*)$/);
        return this.ref(m ? decodeURIComponent(m[1].split('?')[0]) : '');
    };
    Database.prototype.goOffline = function () { Hub.goOffline(); };
    Database.prototype.goOnline = function () { Hub.goOnline(); };
    Database.prototype.useEmulator = noop;
    Database.prototype._call = function (body) {
        body.ns = this._ns;
        return call(this._auth, '/db', body).then(function (res) {
            Hub.observed(res.s);
            return res;
        });
    };
    Database.prototype._write = function (body, path) {
        var self = this;
        return this._call(body).then(function (res) {
            Hub.localChange('db', self._ns, path);
            return res;
        });
    };

    function withCallback(p, cb) {
        if (typeof cb === 'function') {
            p.then(function () { cb(null); }, function (e) { cb(e); });
        }
        return p;
    }

    function Reference(db, path, query) {
        this.database = db;
        this._path = path;
        this._query = query; // null for a plain reference
        this.key = path ? lastSegment(path) : null;
    }
    Object.defineProperty(Reference.prototype, 'ref', {
        get: function () { return this._query ? new Reference(this.database, this._path, null) : this; }
    });
    Object.defineProperty(Reference.prototype, 'parent', {
        get: function () { return this._path ? new Reference(this.database, parentPath(this._path), null) : null; }
    });
    Object.defineProperty(Reference.prototype, 'root', {
        get: function () { return new Reference(this.database, '', null); }
    });
    Reference.prototype.child = function (p) { return new Reference(this.database, joinPath(this._path, p), null); };
    Reference.prototype.toString = function () {
        return (global.location ? global.location.origin : '') + '/' + this._path;
    };
    Reference.prototype.toJSON = Reference.prototype.toString;
    Reference.prototype.isEqual = function (o) {
        return o instanceof Reference && o._path === this._path && JSON.stringify(o._query) === JSON.stringify(this._query);
    };

    Reference.prototype.set = function (value, onComplete) {
        return withCallback(this.database._write({ op: 'set', path: this._path, value: value === undefined ? null : value }, this._path).then(noop), onComplete);
    };
    Reference.prototype.setWithPriority = function (value, priority, onComplete) { return this.set(value, onComplete); };
    Reference.prototype.setPriority = function (p, onComplete) { return withCallback(Promise.resolve(), onComplete); };
    Reference.prototype.update = function (values, onComplete) {
        return withCallback(this.database._write({ op: 'update', path: this._path, values: values || {} }, this._path).then(noop), onComplete);
    };
    Reference.prototype.remove = function (onComplete) {
        return withCallback(this.database._write({ op: 'set', path: this._path, value: null }, this._path).then(noop), onComplete);
    };
    Reference.prototype.push = function (value, onComplete) {
        var ref = this.child(pushId());
        var p;
        if (value !== undefined && value !== null) {
            p = ref.set(value, onComplete).then(function () { return ref; });
        } else {
            p = Promise.resolve(ref);
        }
        ref.then = function (a, b) { return p.then(a, b); };
        ref['catch'] = function (b) { return p.then(null, b); };
        return ref;
    };

    Reference.prototype.transaction = function (updateFn, onComplete, applyLocally) {
        var self = this;
        var db = this.database;
        function attempt(n) {
            return db._call({ op: 'get', path: self._path, hash: true }).then(function (res) {
                var current = res.val === undefined ? null : res.val;
                var next;
                try { next = updateFn(clone(current)); } catch (e) { return Promise.reject(e); }
                if (next === undefined) {
                    return { committed: false, snapshot: new DataSnapshot(self.ref, current, null) };
                }
                return db._write({ op: 'tx', path: self._path, expect: res.hash, value: next }, self._path).then(function (r) {
                    if (r.ok) return { committed: true, snapshot: new DataSnapshot(self.ref, r.val === undefined ? null : r.val, null) };
                    if (n >= 25) throw makeError('maxretry', 'Transaction had too many retries');
                    return attempt(n + 1);
                });
            });
        }
        var p = attempt(0);
        if (typeof onComplete === 'function') {
            p.then(function (r) { onComplete(null, r.committed, r.snapshot); }, function (e) { onComplete(e, false, null); });
        }
        return p;
    };

    Reference.prototype.onDisconnect = function () { return new OnDisconnect(this); };

    // --- queries ---
    Reference.prototype._q = function (patch) {
        var q = {};
        var cur = this._query || {};
        for (var k in cur) if (hasOwn(cur, k)) q[k] = cur[k];
        for (var k2 in patch) if (hasOwn(patch, k2)) q[k2] = patch[k2];
        return new Reference(this.database, this._path, q);
    };
    Reference.prototype.orderByChild = function (path) { return this._q({ orderBy: 'child', child: normPath(path) }); };
    Reference.prototype.orderByKey = function () { return this._q({ orderBy: 'key' }); };
    Reference.prototype.orderByValue = function () { return this._q({ orderBy: 'value' }); };
    Reference.prototype.orderByPriority = function () { return this._q({ orderBy: 'key' }); };
    Reference.prototype.limitToFirst = function (n) { return this._q({ limitToFirst: n }); };
    Reference.prototype.limitToLast = function (n) { return this._q({ limitToLast: n }); };
    function bound(value, key) { return key === undefined ? [value === undefined ? null : value] : [value === undefined ? null : value, key]; }
    Reference.prototype.startAt = function (v, k) { return this._q({ startAt: bound(v, k) }); };
    Reference.prototype.startAfter = function (v, k) { return this._q({ startAfter: bound(v, k) }); };
    Reference.prototype.endAt = function (v, k) { return this._q({ endAt: bound(v, k) }); };
    Reference.prototype.endBefore = function (v, k) { return this._q({ endBefore: bound(v, k) }); };
    Reference.prototype.equalTo = function (v, k) { return this._q({ equalTo: bound(v, k) }); };

    // --- reads ---
    Reference.prototype._fetch = function () {
        var self = this;
        var special = specialValue(this._path);
        if (special !== undefined) return Promise.resolve(special);
        return this.database._call({ op: 'get', path: this._path, q: this._query }).then(function (res) {
            return res.val === undefined ? null : res.val;
        });
    };
    Reference.prototype.get = function () {
        var self = this;
        return this._fetch().then(function (v) { return new DataSnapshot(self.ref, v, self._query); });
    };

    Reference.prototype.once = function (eventType, success, failure, context) {
        var self = this;
        if (typeof failure === 'object' && failure !== null) { context = failure; failure = null; }
        eventType = eventType || 'value';
        if (eventType === 'value') {
            var p = this.get();
            p.then(function (snap) { if (success) success.call(context, snap); }, function (e) { if (failure) failure.call(context, e); });
            return p;
        }
        return new Promise(function (resolve, reject) {
            var fired = false;
            var handler = function (snap, prev) {
                if (fired) return;
                fired = true;
                later(function () { self.off(eventType, handler); });
                if (success) success.call(context, snap, prev);
                resolve(snap);
            };
            self.on(eventType, handler, function (e) {
                if (failure) failure.call(context, e);
                reject(e);
            });
        });
    };

    Reference.prototype.on = function (eventType, callback, cancelCallback, context) {
        if (typeof cancelCallback === 'object' && cancelCallback !== null) { context = cancelCallback; cancelCallback = null; }
        var group = getGroup(this);
        group.add(eventType, callback, cancelCallback, context);
        return callback;
    };

    Reference.prototype.off = function (eventType, callback, context) {
        var db = this.database;
        var key = groupKey(this);
        var groups = [];
        if (this._query === null && !eventType && !callback) {
            // off() on a plain ref removes every listener at this location, query or not.
            for (var k in db._groups) if (hasOwn(db._groups, k) && db._groups[k].path === this._path) groups.push(db._groups[k]);
        } else if (db._groups[key]) {
            groups.push(db._groups[key]);
        }
        for (var i = 0; i < groups.length; i++) groups[i].remove(eventType, callback, context);
    };

    function specialValue(path) {
        if (path === '.info/connected') return Hub.connected;
        if (path === '.info/serverTimeOffset') return serverTimeOffset;
        return undefined;
    }

    function groupKey(ref) { return ref._path + '|' + JSON.stringify(ref._query || null); }

    function getGroup(ref) {
        var db = ref.database;
        var key = groupKey(ref);
        if (!db._groups[key]) db._groups[key] = new ListenGroup(ref, key);
        return db._groups[key];
    }

    function ListenGroup(ref, key) {
        this.ref = ref;
        this.db = ref.database;
        this.key = key;
        this.path = ref._path;
        this.query = ref._query;
        this.cbs = [];
        this.value = undefined; // undefined = not loaded yet
        this.loaded = false;
        this.watchId = null;
        this.connFn = null;
        this.inFlight = false;
        this.dirty = false;
    }

    ListenGroup.prototype.add = function (type, cb, cancel, ctx) {
        var entry = { type: type, cb: cb, cancel: cancel, ctx: ctx };
        this.cbs.push(entry);
        var self = this;
        if (this.path === '.info/connected' || this.path === '.info/serverTimeOffset') {
            if (!this.connFn) {
                this.connFn = function () { self.applyValue(specialValue(self.path)); };
                Hub.connListeners.push(this.connFn);
                Hub.scheduleRestart();
            }
            later(function () {
                if (self.cbs.indexOf(entry) === -1) return;
                if (!self.loaded) { self.applyValue(specialValue(self.path)); }
                else self.fireInitial(entry);
            });
            return;
        }
        if (!this.watchId) {
            this.watchId = Hub.add({ k: 'db', ns: this.db._ns, path: this.path }, function () { self.refetch(); });
            this.refetch();
        } else if (this.loaded) {
            later(function () { if (self.cbs.indexOf(entry) !== -1) self.fireInitial(entry); });
        }
    };

    ListenGroup.prototype.remove = function (type, cb, ctx) {
        this.cbs = this.cbs.filter(function (e) {
            if (type && e.type !== type) return true;
            if (cb && e.cb !== cb) return true;
            if (ctx !== undefined && cb && e.ctx !== ctx) return true;
            return false;
        });
        if (!this.cbs.length) this.dispose();
    };

    ListenGroup.prototype.dispose = function () {
        if (this.watchId) { Hub.remove(this.watchId); this.watchId = null; }
        if (this.connFn) {
            var i = Hub.connListeners.indexOf(this.connFn);
            if (i !== -1) Hub.connListeners.splice(i, 1);
            this.connFn = null;
        }
        delete this.db._groups[this.key];
    };

    ListenGroup.prototype.refetch = function () {
        var self = this;
        if (!this.watchId) return;
        if (this.inFlight) { this.dirty = true; return; }
        this.inFlight = true;
        this.db._call({ op: 'get', path: this.path, q: this.query }).then(function (res) {
            self.inFlight = false;
            if (!self.watchId) return;
            self.applyValue(res.val === undefined ? null : res.val);
            if (self.dirty) { self.dirty = false; self.refetch(); }
        }, function (e) {
            self.inFlight = false;
            if (e.code === 'permission-denied' || e.code === 'PERMISSION_DENIED') {
                var cbs = self.cbs.slice();
                self.cbs = [];
                self.dispose();
                var err = makeError('PERMISSION_DENIED', 'permission_denied at /' + self.path + ': Client doesn\'t have permission to access the desired data.');
                for (var i = 0; i < cbs.length; i++) {
                    if (cbs[i].cancel) { try { cbs[i].cancel.call(cbs[i].ctx, err); } catch (x) { logError(x); } }
                }
                if (!cbs.some(function (c) { return !!c.cancel; })) logError(err);
            } else if (self.dirty) {
                self.dirty = false;
                setTimeout(function () { self.refetch(); }, 1000);
            }
        });
    };

    ListenGroup.prototype.snap = function (v) { return new DataSnapshot(this.ref.ref, v, this.query); };

    ListenGroup.prototype.childSnap = function (v, k) {
        return new DataSnapshot(this.ref.ref.child(k), (v && typeof v === 'object' && hasOwn(v, k)) ? v[k] : null, null);
    };

    ListenGroup.prototype.fireInitial = function (entry) {
        var v = this.value;
        if (entry.type === 'value') {
            safeCall(entry, this.snap(v));
        } else if (entry.type === 'child_added') {
            var keys = orderedKeys(v, this.query);
            for (var i = 0; i < keys.length; i++) safeCall(entry, this.childSnap(v, keys[i]), i > 0 ? keys[i - 1] : null);
        }
    };

    ListenGroup.prototype.applyValue = function (nv) {
        var first = !this.loaded;
        var ov = this.value;
        if (!first && JSON.stringify(ov) === JSON.stringify(nv)) return;
        this.loaded = true;
        this.value = nv;
        var entries = this.cbs.slice();
        if (first) {
            for (var i = 0; i < entries.length; i++) this.fireInitial(entries[i]);
            return;
        }
        var oldKeys = orderedKeys(ov, this.query);
        var newKeys = orderedKeys(nv, this.query);
        var oldSet = {}, newSet = {};
        var j;
        for (j = 0; j < oldKeys.length; j++) oldSet[oldKeys[j]] = j;
        for (j = 0; j < newKeys.length; j++) newSet[newKeys[j]] = j;
        var events = [];
        for (j = 0; j < oldKeys.length; j++) {
            if (!hasOwn(newSet, oldKeys[j])) events.push(['child_removed', this.childSnap(ov, oldKeys[j]), null]);
        }
        for (j = 0; j < newKeys.length; j++) {
            var k = newKeys[j];
            var prevKey = j > 0 ? newKeys[j - 1] : null;
            if (!hasOwn(oldSet, k)) {
                events.push(['child_added', this.childSnap(nv, k), prevKey]);
            } else if (JSON.stringify(ov[k]) !== JSON.stringify(nv[k])) {
                events.push(['child_changed', this.childSnap(nv, k), prevKey]);
            }
        }
        for (var e = 0; e < events.length; e++) {
            for (var c = 0; c < entries.length; c++) {
                if (entries[c].type === events[e][0] && this.cbs.indexOf(entries[c]) !== -1) safeCall(entries[c], events[e][1], events[e][2]);
            }
        }
        for (var c2 = 0; c2 < entries.length; c2++) {
            if (entries[c2].type === 'value' && this.cbs.indexOf(entries[c2]) !== -1) safeCall(entries[c2], this.snap(nv));
        }
    };

    function safeCall(entry, snap, prevKey) {
        try { entry.cb.call(entry.ctx, snap, prevKey); } catch (e) { logError(e); }
    }

    function DataSnapshot(ref, value, query) {
        this.ref = ref;
        this.key = ref.key;
        this._v = value === undefined ? null : value;
        this._query = query;
    }
    DataSnapshot.prototype.val = function () { return clone(this._v); };
    DataSnapshot.prototype.exportVal = DataSnapshot.prototype.val;
    DataSnapshot.prototype.toJSON = DataSnapshot.prototype.val;
    DataSnapshot.prototype.exists = function () { return this._v !== null; };
    DataSnapshot.prototype.child = function (path) {
        return new DataSnapshot(this.ref.child(path), childVal(this._v, normPath(path)), null);
    };
    DataSnapshot.prototype.hasChild = function (path) { return childVal(this._v, normPath(path)) !== null; };
    DataSnapshot.prototype.hasChildren = function () {
        return this._v !== null && typeof this._v === 'object' && Object.keys(this._v).length > 0;
    };
    DataSnapshot.prototype.numChildren = function () {
        return (this._v !== null && typeof this._v === 'object') ? Object.keys(this._v).length : 0;
    };
    Object.defineProperty(DataSnapshot.prototype, 'size', { get: function () { return this.numChildren(); } });
    DataSnapshot.prototype.forEach = function (action) {
        var v = this._v;
        var keys = orderedKeys(v, this._query);
        for (var i = 0; i < keys.length; i++) {
            if (action(new DataSnapshot(this.ref.child(keys[i]), v[keys[i]], null)) === true) return true;
        }
        return false;
    };
    DataSnapshot.prototype.getPriority = function () { return null; };

    function OnDisconnect(ref) { this._ref = ref; }
    OnDisconnect.prototype._send = function (action, value, cb) {
        var ref = this._ref;
        Hub.keepAlive++;
        Hub.scheduleRestart();
        var body = { op: 'od', cid: Hub.cid, path: ref._path, action: action };
        if (value !== undefined) body.value = value;
        return withCallback(ref.database._call(body).then(noop), cb);
    };
    OnDisconnect.prototype.set = function (v, cb) { return this._send('set', v === undefined ? null : v, cb); };
    OnDisconnect.prototype.setWithPriority = function (v, p, cb) { return this.set(v, cb); };
    OnDisconnect.prototype.update = function (v, cb) { return this._send('update', v || {}, cb); };
    OnDisconnect.prototype.remove = function (cb) { return this._send('set', null, cb); };
    OnDisconnect.prototype.cancel = function (cb) {
        var ref = this._ref;
        return withCallback(ref.database._call({ op: 'odcancel', cid: Hub.cid, path: ref._path }).then(noop), cb);
    };

    // ------------------------------------------------------------------
    // Cloud Functions (callable)
    // ------------------------------------------------------------------

    function Functions(app) { this.app = app; }
    Functions.prototype.httpsCallable = function (name) {
        var app = this.app;
        return function (data) {
            var auth = app.auth();
            return call(auth, '/fn/' + encodeURIComponent(name), { data: data === undefined ? null : data, ns: app._ns }).then(function (res) {
                return { data: res.result };
            }, function (e) {
                var code = e.code || 'internal';
                if (code.indexOf('functions/') !== 0) code = 'functions/' + code;
                throw makeError(code, e.message, e.details);
            });
        };
    };
    Functions.prototype.useEmulator = noop;
    Functions.prototype.useFunctionsEmulator = noop;

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    function Storage(app) { this.app = app; this._ns = app._ns; this.maxUploadRetryTime = 0; this.maxOperationRetryTime = 0; }
    Storage.prototype.ref = function (path) { return new StorageRef(this, normPath(path)); };
    Storage.prototype.refFromURL = function (url) {
        var m = String(url).match(/\/__rk\/st\/dl\/([^?]+)/);
        if (m) return this.ref(decodeURIComponent(m[1]));
        m = String(url).match(/\/o\/([^?]+)/);
        return this.ref(m ? decodeURIComponent(m[1]) : '');
    };
    Storage.prototype.useEmulator = noop;
    Storage.prototype.setMaxUploadRetryTime = noop;
    Storage.prototype.setMaxOperationRetryTime = noop;
    Storage.prototype._call = function (path, body) {
        body.ns = this._ns;
        return call(this.app.auth(), path, body);
    };

    function StorageRef(storage, path) {
        this.storage = storage;
        this.fullPath = path;
        this.name = lastSegment(path) || '';
        this.bucket = storage.app.options.storageBucket || 'local';
    }
    Object.defineProperty(StorageRef.prototype, 'parent', {
        get: function () { return this.fullPath ? new StorageRef(this.storage, parentPath(this.fullPath)) : null; }
    });
    Object.defineProperty(StorageRef.prototype, 'root', {
        get: function () { return new StorageRef(this.storage, ''); }
    });
    StorageRef.prototype.child = function (p) { return new StorageRef(this.storage, joinPath(this.fullPath, p)); };
    StorageRef.prototype.toString = function () { return 'gs://' + this.bucket + '/' + this.fullPath; };

    StorageRef.prototype.put = function (blob, metadata) {
        return new UploadTask(this, blob, metadata || {});
    };
    StorageRef.prototype.putString = function (str, format, metadata) {
        format = format || 'raw';
        metadata = metadata || {};
        var bytes, type = metadata.contentType;
        if (format === 'raw') {
            return this.put(new Blob([str], { type: type || 'text/plain' }), metadata);
        }
        var b64 = str;
        if (format === 'data_url') {
            var m = str.match(/^data:([^;,]*)(;base64)?,(.*)$/);
            if (!m) throw makeError('storage/invalid-format', 'Invalid data URL');
            type = type || m[1];
            if (!m[2]) return this.put(new Blob([decodeURIComponent(m[3])], { type: type }), metadata);
            b64 = m[3];
        }
        if (format === 'base64url') b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
        var bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (!metadata.contentType) metadata.contentType = type;
        return this.put(new Blob([bytes], { type: type || 'application/octet-stream' }), metadata);
    };
    StorageRef.prototype.getMetadata = function () {
        return this.storage._call('/st/meta', { path: this.fullPath }).then(function (r) { return r.meta; });
    };
    StorageRef.prototype.updateMetadata = function (m) {
        return this.storage._call('/st/meta', { path: this.fullPath, update: m || {} }).then(function (r) { return r.meta; });
    };
    StorageRef.prototype.getDownloadURL = function () {
        return this.storage._call('/st/meta', { path: this.fullPath }).then(function (r) { return r.url; });
    };
    StorageRef.prototype['delete'] = function () {
        return this.storage._call('/st/delete', { path: this.fullPath }).then(noop);
    };
    StorageRef.prototype.list = function (opts) {
        var self = this;
        opts = opts || {};
        return this.storage._call('/st/list', { path: this.fullPath, max: opts.maxResults || null, page: opts.pageToken || null }).then(function (r) {
            return {
                items: (r.items || []).map(function (p) { return new StorageRef(self.storage, p); }),
                prefixes: (r.prefixes || []).map(function (p) { return new StorageRef(self.storage, p); }),
                nextPageToken: r.next || null
            };
        });
    };
    StorageRef.prototype.listAll = function () { return this.list({}); };

    function UploadTask(ref, blob, metadata) {
        var self = this;
        this._observers = [];
        this.snapshot = {
            bytesTransferred: 0, totalBytes: blob.size || 0, state: 'running',
            metadata: metadata, ref: ref, task: this
        };
        var headers = {
            'X-RK-NS': ref.storage._ns,
            'X-RK-Path': encodeURIComponent(ref.fullPath),
            'X-RK-Meta': encodeURIComponent(JSON.stringify({
                contentType: metadata.contentType || blob.type || null,
                customMetadata: metadata.customMetadata || null,
                cacheControl: metadata.cacheControl || null,
                contentDisposition: metadata.contentDisposition || null
            }))
        };
        this._promise = ref.storage.app.auth()._getToken().then(function (token) {
            if (token) headers.Authorization = 'Bearer ' + token;
            return request('POST', API + '/st/upload', blob, {
                raw: true,
                headers: headers,
                xhrRef: function (x) { self._xhr = x; },
                onProgress: function (loaded, total) {
                    self.snapshot.bytesTransferred = loaded;
                    self.snapshot.totalBytes = total;
                    self._emit('next');
                }
            });
        }).then(function (r) {
            self.snapshot.state = 'success';
            self.snapshot.bytesTransferred = self.snapshot.totalBytes;
            self.snapshot.metadata = r.meta;
            self._emit('next');
            self._emit('complete');
            return self.snapshot;
        }, function (e) {
            self.snapshot.state = 'error';
            var err = makeError(e.code && e.code.indexOf('storage/') === 0 ? e.code : 'storage/' + (e.code === 'permission-denied' ? 'unauthorized' : 'unknown'), e.message);
            self._emit('error', err);
            throw err;
        });
        this._promise.then(noop, noop);
    }
    UploadTask.prototype._emit = function (kind, arg) {
        var obs = this._observers.slice();
        for (var i = 0; i < obs.length; i++) {
            var o = obs[i];
            try {
                if (kind === 'next' && o.next) o.next(this.snapshot);
                else if (kind === 'error' && o.error) o.error(arg);
                else if (kind === 'complete' && o.complete) o.complete();
            } catch (e) { logError(e); }
        }
    };
    UploadTask.prototype.on = function (event, next, error, complete) {
        var o = (next && typeof next === 'object') ? next : { next: next, error: error, complete: complete };
        this._observers.push(o);
        var self = this;
        return function () { var i = self._observers.indexOf(o); if (i !== -1) self._observers.splice(i, 1); };
    };
    UploadTask.prototype.then = function (a, b) { return this._promise.then(a, b); };
    UploadTask.prototype['catch'] = function (b) { return this._promise.then(null, b); };
    UploadTask.prototype.cancel = function () {
        if (this._xhr) { try { this._xhr.abort(); } catch (e) { } }
        return true;
    };
    UploadTask.prototype.pause = function () { return false; };
    UploadTask.prototype.resume = function () { return false; };

    // ------------------------------------------------------------------
    // Global namespace
    // ------------------------------------------------------------------

    function serviceAccessor(name) {
        return function (app) {
            var a = app || getApp();
            return a[name]();
        };
    }

    var firebase = {
        __rk: true,
        SDK_VERSION: '9.6.1-rekindle-selfhost',
        initializeApp: initializeApp,
        app: getApp,
        apps: appList,
        setLogLevel: noop,
        onLog: noop,
        registerVersion: noop
    };

    firebase.auth = serviceAccessor('auth');
    firebase.auth.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session', NONE: 'none' } };
    firebase.auth.EmailAuthProvider = {
        PROVIDER_ID: 'password',
        EMAIL_PASSWORD_SIGN_IN_METHOD: 'password',
        credential: function (email, password) { return { providerId: 'password', signInMethod: 'password', email: email, password: password }; }
    };
    function UnsupportedProvider(id) { this.providerId = id; }
    UnsupportedProvider.prototype.addScope = function () { return this; };
    UnsupportedProvider.prototype.setCustomParameters = function () { return this; };
    firebase.auth.GoogleAuthProvider = function () { return new UnsupportedProvider('google.com'); };
    firebase.auth.GoogleAuthProvider.PROVIDER_ID = 'google.com';
    firebase.auth.GoogleAuthProvider.credential = function () { return { providerId: 'google.com' }; };

    firebase.firestore = serviceAccessor('firestore');
    firebase.firestore.FieldValue = FieldValue;
    firebase.firestore.Timestamp = Timestamp;
    firebase.firestore.GeoPoint = GeoPoint;
    firebase.firestore.FieldPath = FieldPath;
    firebase.firestore.Firestore = Firestore;
    firebase.firestore.DocumentReference = DocumentReference;
    firebase.firestore.CollectionReference = CollectionReference;
    firebase.firestore.Query = Query;
    firebase.firestore.DocumentSnapshot = DocumentSnapshot;
    firebase.firestore.QuerySnapshot = QuerySnapshot;
    firebase.firestore.CACHE_SIZE_UNLIMITED = -1;
    firebase.firestore.setLogLevel = noop;

    firebase.database = function (app, url) {
        if (typeof app === 'string') { url = app; app = null; }
        return (app || getApp()).database(url);
    };
    firebase.database.ServerValue = {
        TIMESTAMP: { '.sv': 'timestamp' },
        increment: function (n) { return { '.sv': { increment: n } }; }
    };
    firebase.database.enableLogging = noop;
    firebase.database.Reference = Reference;
    firebase.database.DataSnapshot = DataSnapshot;

    firebase.functions = function (app) {
        if (app && typeof app === 'object' && app.functions) return app.functions();
        return getApp().functions();
    };
    firebase.storage = serviceAccessor('storage');
    firebase.storage.TaskEvent = { STATE_CHANGED: 'state_changed' };
    firebase.storage.TaskState = { RUNNING: 'running', PAUSED: 'paused', SUCCESS: 'success', CANCELED: 'canceled', ERROR: 'error' };
    firebase.storage.StringFormat = { RAW: 'raw', BASE64: 'base64', BASE64URL: 'base64url', DATA_URL: 'data_url' };

    firebase.analytics = function () { return { logEvent: noop, setUserId: noop, setUserProperties: noop, setCurrentScreen: noop }; };
    firebase.performance = function () { return { trace: function () { return { start: noop, stop: noop }; } }; };
    firebase.messaging = function () { return { getToken: function () { return Promise.reject(makeError('messaging/unsupported-browser', 'Not supported')); }, onMessage: noop }; };
    firebase.messaging.isSupported = function () { return false; };

    global.firebase = firebase;
})(typeof window !== 'undefined' ? window : this);
