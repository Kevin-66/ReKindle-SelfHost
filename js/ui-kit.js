/**
 * ReKindle shared empty/auth state helper.
 *
 * Usage (after this script has loaded):
 *   el.innerHTML = window.rekindleEmptyState(
 *       window.t('notes.empty', 'No notes. Tap "+ New".'),
 *       { icon: 'notes' }
 *   );
 *
 * Messages are inserted as HTML because several existing locale strings
 * contain <br>. Only pass trusted, app-owned strings.
 */
(function () {
    var ICONS = {
        inbox: '<path d="M4 16l4-9h16l4 9v10H4z"/><path d="M4 16h7l2 4h6l2-4h7"/>',
        list: '<path d="M6 8h20M6 16h20M6 24h14"/>',
        check: '<rect x="5" y="5" width="22" height="22"/><path d="M10 16l4 4 8-8"/>',
        clock: '<circle cx="16" cy="16" r="11"/><path d="M16 9v7l5 3"/>',
        book: '<path d="M5 6h10v21H5zM17 6h10v21H17z"/><path d="M5 6c3-2 7-2 10 0M17 6c3-2 7-2 10 0"/>',
        film: '<rect x="4" y="7" width="24" height="18"/><path d="M9 7v18M23 7v18M4 13h5M23 13h5M4 19h5M23 19h5"/>',
        rss: '<path d="M6 25a2 2 0 0 1 2-2"/><path d="M6 17a10 10 0 0 1 10 10"/><path d="M6 9a18 18 0 0 1 18 18"/>',
        calendar: '<rect x="4" y="6" width="24" height="22"/><path d="M4 12h24M10 4v4M22 4v4"/>',
        music: '<path d="M13 24V8l13-3v16"/><circle cx="9" cy="24" r="4"/><circle cx="22" cy="21" r="4"/>',
        search: '<circle cx="14" cy="14" r="8"/><path d="M20 20l7 7"/>',
        bookmark: '<path d="M9 4h14v24l-7-5-7 5z"/>',
        contacts: '<circle cx="16" cy="10" r="5"/><path d="M5 27c1-7 5-10 11-10s10 3 11 10"/>',
        cards: '<rect x="7" y="4" width="18" height="24"/><path d="M11 10h10M11 15h10M11 20h6"/>',
        chat: '<path d="M5 6h22v16H12l-7 6z"/><path d="M10 12h12M10 17h8"/>',
        habit: '<rect x="5" y="7" width="22" height="20"/><path d="M5 13h22M11 4v6M21 4v6"/><path d="M10 20l3 3 6-6"/>'
    };

    var STYLE_ID = 'rk-empty-styles';

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
            '.rk-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;',
            'text-align:center;height:100%;min-height:220px;padding:28px 18px;box-sizing:border-box;',
            'font-family:"Geneva","Verdana",sans-serif;color:#000;}',
            '.rk-empty-compact{min-height:140px;padding:18px;}',
            '.rk-empty-icon{display:block;width:44px;height:44px;margin-bottom:10px;flex:none;}',
            '.rk-empty-text{font-size:0.95rem;font-weight:bold;line-height:1.35;max-width:300px;margin:0;}',
            '.rk-empty-hint{font-size:0.78rem;line-height:1.35;color:#555;max-width:300px;margin:6px 0 0;}',
            '.rk-empty-action{margin-top:14px;}',
            '.rk-empty-btn{min-height:48px;padding:8px 16px;border:2px solid #000;border-radius:0;',
            'background:#fff;color:#000;box-shadow:2px 2px 0 #000;font-family:inherit;font-size:0.9rem;',
            'font-weight:bold;cursor:pointer;}',
            '.rk-empty-btn:active{background:#000;color:#fff;box-shadow:none;transform:translate(2px,2px);}',
            '.rk-empty-card{height:auto;width:100%;max-width:340px;margin:auto;background:#fff;',
            'border:2px solid #000;box-shadow:4px 4px 0 #000;}',
            '.rk-empty-grid{grid-column:1/-1;height:auto;min-height:180px;}'
        ].join('');
        (document.head || document.documentElement).appendChild(style);
    }

    window.rekindleEmptyState = function (message, opts) {
        opts = opts || {};
        ensureStyles();
        var icon = ICONS[opts.icon || 'inbox'] || ICONS.inbox;
        var classes = 'rk-empty';
        if (opts.card) classes += ' rk-empty-card';
        if (opts.compact) classes += ' rk-empty-compact';
        if (opts.className) classes += ' ' + opts.className;

        var html = '<div class="' + classes + '">';
        html += '<svg class="rk-empty-icon" viewBox="0 0 32 32" aria-hidden="true" fill="none" ' +
            'stroke="black" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">' + icon + '</svg>';
        html += '<p class="rk-empty-text">' + message + '</p>';
        if (opts.hint) html += '<p class="rk-empty-hint">' + opts.hint + '</p>';
        if (opts.action) html += '<div class="rk-empty-action">' + opts.action + '</div>';
        html += '</div>';
        return html;
    };
})();
