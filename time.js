(function () {
    // --- SHARED TIMEZONE HELPERS ---
    // Single source of truth for "Mixed Browser Timezone" fix

    function getGlobalTimeZone() {
        try {
            const globalLoc = JSON.parse(localStorage.getItem('rekindle_location_manual'));
            return globalLoc && globalLoc.zone ? globalLoc.zone : (typeof Intl !== 'undefined' && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC');
        } catch (e) {
            return 'UTC';
        }
    }

    // Lazy timezone prompt — shows once per page when local time is actually requested
    function maybeCheckTimezone() {
        if (window._rekindleTzPromptShown) return;
        window._rekindleTzPromptShown = true;
        setTimeout(function () {
            checkTimezoneOffset();
        }, 0);
    }

    function getDateInZone(date = new Date(), zone) {
        // PRIORITY: Check for robust Manual Offset (Automatic or User Set)
        // BUT ONLY if we are requesting the "Local" time or the "Manual Location's" time.
        // Otherwise, we break other timezones in Clocks app.
        // Lazy prompt: only trigger when requesting local/user time (no explicit zone)
        if (!zone) {
            maybeCheckTimezone();
        }
        const manualLocStr = localStorage.getItem('rekindle_location_manual');
        let manualZone = null;
        let offsetHours = null;

        // Primary source: utc_offset inside rekindle_location_manual (backwards compatible)
        if (manualLocStr) {
            try {
                const loc = JSON.parse(manualLocStr);
                manualZone = loc.zone || null;
                if (typeof loc.utc_offset === 'number') {
                    offsetHours = loc.utc_offset;
                }
            } catch (e) { }
        }

        // Fallback: separate rekindle_timezone_offset key (legacy)
        if (offsetHours === null) {
            const offsetStr = localStorage.getItem('rekindle_timezone_offset');
            if (offsetStr) {
                offsetHours = parseFloat(offsetStr);
                if (isNaN(offsetHours)) offsetHours = null;
            }
        }

        const isTargetingUserZone = !zone || (manualZone && zone === manualZone);

        // If we have an explicit IANA zone string for the user's location, we can use Intl 
        // to handle Daylight Saving Time automatically (circumvents Kindle's broken system timezone issue).
        if (isTargetingUserZone && manualZone) {
            try {
                const options = {
                    timeZone: manualZone,
                    year: 'numeric', month: 'numeric', day: 'numeric',
                    hour: 'numeric', minute: 'numeric', second: 'numeric',
                    hour12: false
                };
                const s = date.toLocaleString('en-US', options);
                const [datePart, timePart] = s.split(', ');
                const [m, d, y] = datePart.split('/').map(Number);
                const [h, min, sec] = timePart.split(':').map(Number);
                if (!isNaN(y) && !isNaN(h)) {
                    return new Date(y, m - 1, d, h, min, sec);
                }
            } catch (e) {
                // If the zone string is unsupported by this browser version, fall back below.
            }
        }

        // STATIC FALLBACK: use manual UTC offset if Intl isn't an option (with manual DST switch support)
        if (offsetHours !== null && isTargetingUserZone) {
            if (!isNaN(offsetHours)) {
                let dstOffsetHours = localStorage.getItem('rekindle_dst_active') === 'true' ? 1 : 0;
                // Calculate wall clock components:
                // 1. Get UTC milliseconds from the input date
                const utcMs = date.getTime();
                // 2. Create a temp Date at the UTC time PLUS the offset
                const shifted = new Date(utcMs + ((offsetHours + dstOffsetHours) * 3600000));
                // 3. Extract UTC components (which now represent wall-clock time in target zone)
                const y = shifted.getUTCFullYear();
                const mo = shifted.getUTCMonth();
                const d = shifted.getUTCDate();
                const h = shifted.getUTCHours();
                const mi = shifted.getUTCMinutes();
                const s = shifted.getUTCSeconds();
                // 4. Construct a new Date from these components as LOCAL values
                //    The Date's .get*() methods will return wall-clock values
                return new Date(y, mo, d, h, mi, s);
            }
        }

        if (!zone) zone = getGlobalTimeZone();
        try {
            const options = {
                timeZone: zone,
                year: 'numeric', month: 'numeric', day: 'numeric',
                hour: 'numeric', minute: 'numeric', second: 'numeric',
                hour12: false
            };
            const s = date.toLocaleString('en-US', options);
            // "M/D/YYYY, HH:mm:ss"
            const [datePart, timePart] = s.split(', ');
            const [m, d, y] = datePart.split('/').map(Number);
            const [h, min, sec] = timePart.split(':').map(Number);

            // Return wall-clock date object (local components match target zone)
            return new Date(y, m - 1, d, h, min, sec);
        } catch (e) {
            console.error("Shared Timezone Error", e);
            return date;
        }
    }

    function getZonedDate(date = new Date()) {
        maybeCheckTimezone();
        return getDateInZone(date, getGlobalTimeZone());
    }

    // Format a date object (which acts as source timestamp) into a specific format string relative to Global Zone
    function formatGlobalTime(date, options = {}) {
        // Unified Logic: Convert to Wall Date first, then format "as is"
        // This ensures consistent behavior between calculations and display
        maybeCheckTimezone();
        const wallDate = getDateInZone(date);
        return formatWallDate(wallDate, options);
    }

    // Get the logical locale based on location settings
    function getUserLocale() {
        try {
            // Get language preference
            let lang = localStorage.getItem('rekindle_language');
            if (!lang || lang === 'auto') {
                if (document.documentElement && document.documentElement.lang) {
                    lang = document.documentElement.lang;
                } else if (typeof navigator !== 'undefined' && navigator.language) {
                    lang = navigator.language.split('-')[0];
                } else {
                    lang = 'en';
                }
            }

            // Get country code from location settings
            let country = null;
            const manualLocStr = localStorage.getItem('rekindle_location_manual');
            if (manualLocStr) {
                const loc = JSON.parse(manualLocStr);
                if (loc.country_code) {
                    country = loc.country_code.toUpperCase();
                }
            }
            
            if (country) {
                return `${lang}-${country}`;
            } else {
                return typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
            }
        } catch (e) {
            return 'en-US';
        }
    }

    // Format a "Wall Date" (a Date where .get*() methods return wall-clock values)
    function formatWallDate(wallDate, options = {}) {
        // Just format the Date's local representation - the Date was constructed
        // so that its local components match the desired wall-clock time
        const locale = getUserLocale();
        try {
            return wallDate.toLocaleString(locale, options);
        } catch (e) {
            try {
                return wallDate.toLocaleString('en-US', options);
            } catch (e2) {
                return wallDate.toString();
            }
        }
    }

    // --- TIMEZONE AUTO-DETECTION ---
    // True when the browser reports a real time zone that agrees with its own clock.
    // Kindle browsers report UTC whatever the device is set to (see AGENTS.md), so
    // UTC-like zones are not trusted.
    function browserTimeZoneLooksReal() {
        try {
            if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) return false;
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (!zone || /^(UTC|GMT|Etc\/|Universal|Zulu)/i.test(zone)) return false;
            const now = new Date();
            const opts = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false };
            const inZone = now.toLocaleString('en-US', Object.assign({ timeZone: zone }, opts));
            return inZone === now.toLocaleString('en-US', opts);
        } catch (e) {
            return false;
        }
    }

    // Use the browser's time zone when it can be trusted; otherwise look it up from
    // the connection's IP address. Calls onFail() if neither works.
    function autoDetectTimezone(onFail) {
        if (browserTimeZoneLooksReal()) return; // getDateInZone() falls back to the browser zone
        if (typeof fetch === 'undefined') { onFail(); return; }

        fetch('https://get.geojs.io/v1/ip/geo.json')
            .then(function (res) { return res.json(); })
            .then(function (geo) {
                const lat = parseFloat(geo.latitude);
                const lon = parseFloat(geo.longitude);
                if (isNaN(lat) || isNaN(lon)) throw new Error('No location for this connection');
                // Same offset lookup as the manual city picker below.
                return fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current_weather=true&timezone=auto')
                    .then(function (res) { return res.json(); })
                    .then(function (data) {
                        if (typeof data.utc_offset_seconds !== 'number') throw new Error('No UTC offset returned');
                        const offsetHours = data.utc_offset_seconds / 3600;
                        const locData = {
                            name: geo.city || 'Auto-detected',
                            lat: lat,
                            lon: lon,
                            zone: data.timezone || geo.timezone || null,
                            country_code: null, // left out on purpose: i18n.js would switch the app language from it
                            utc_offset: offsetHours,
                            auto: true
                        };
                        localStorage.setItem('rekindle_timezone_offset', offsetHours);
                        localStorage.setItem('rekindle_location_manual', JSON.stringify(locData));
                        // Reload so times already on screen use the new zone (only if the save stuck).
                        if (localStorage.getItem('rekindle_location_manual')) window.location.reload();
                    });
            })
            .catch(function (e) {
                console.warn('Timezone auto-detection failed:', e);
                onFail();
            });
    }

    // --- TIMEZONE OFFSET WARNING ---
    // Displays a modal if the user has not configured their timezone offset.
    function checkTimezoneOffset() {
        // Check for offset in rekindle_location_manual (primary) or rekindle_timezone_offset (legacy)
        const manualLocStr = localStorage.getItem('rekindle_location_manual');
        if (manualLocStr) {
            try {
                const loc = JSON.parse(manualLocStr);
                if (typeof loc.utc_offset === 'number') {
                    return; // Offset found in location data, no action needed.
                }
            } catch (e) { }
        }

        // Fallback check for legacy key
        const offsetStr = localStorage.getItem('rekindle_timezone_offset');
        if (offsetStr !== null && offsetStr !== '') {
            return; // Legacy offset is set, no action needed.
        }

        // Try to work the time zone out automatically before asking.
        if (!window._rekindleTzAutoTried) {
            window._rekindleTzAutoTried = true;
            autoDetectTimezone(checkTimezoneOffset);
            return;
        }

        // Check if modal already exists (prevent duplicates)
        if (document.getElementById('tz-warning-overlay')) {
            return;
        }

        // Inject Modal Styles
        const style = document.createElement('style');
        style.id = 'tz-modal-style';
        style.textContent = `
            :root {
                --stripe-pattern: repeating-linear-gradient(0deg, transparent, transparent 2px, #000 3px, #000 4px);
                --shadow: 4px 4px 0px #000000;
            }
            .tz-modal-window {
                background: white;
                border: 2px solid black;
                box-shadow: var(--shadow);
                width: 95%;
                max-width: 420px;
                display: flex;
                flex-direction: column;
                font-family: "Geneva", "Verdana", sans-serif;
            }
            .tz-modal-window .title-bar {
                height: 35px;
                border-bottom: 2px solid black;
                display: flex;
                align-items: center;
                justify-content: center;
                background: white;
                position: relative;
            }
            .tz-modal-window .title-stripes {
                position: absolute;
                top: 4px; bottom: 4px; left: 4px; right: 4px;
                background-image: var(--stripe-pattern);
                z-index: 0;
            }
            .tz-modal-window .title-text {
                background: white;
                padding: 0 15px;
                font-weight: bold;
                font-size: 1.1rem;
                z-index: 1;
                font-family: "Geneva", "Verdana", sans-serif;
                border: none;
                display: inline-flex;
                align-items: center;
                height: 100%;
                box-sizing: border-box;
            }
            .tz-modal-content { padding: 15px; text-align: center; }
            .tz-modal-content p { font-size: 0.9rem; margin: 0 0 15px 0; }
            .tz-modal-content input {
                width: 100%;
                border: 2px solid black;
                border-radius: 0;
                padding: 8px;
                font-family: inherit;
                box-sizing: border-box;
                font-size: 1rem;
                background: white;
            }
            #tz-search-results {
                max-height: 120px;
                overflow-y: auto;
                text-align: left;
                border: 2px solid black;
                margin-top: 5px;
                display: none;
                background: white;
            }
            .tz-result-item { padding: 8px; border-bottom: 1px solid #ccc; cursor: pointer; font-size: 0.9rem; }
            .tz-result-item:last-child { border-bottom: none; }
            #tz-search-status { font-size: 0.8rem; margin-top: 5px; min-height: 1.2em; }
        `;
        document.head.appendChild(style);

        // Inject Modal HTML
        const overlay = document.createElement('div');
        overlay.id = 'tz-warning-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';

        overlay.innerHTML = `
            <div class="tz-modal-window">
                <div class="title-bar">
                    <div class="title-stripes"></div>
                    <span class="title-text">Timezone Not Set</span>
                </div>
                <div class="tz-modal-content">
                    <p>Times may be incorrect. Search for your city below:</p>
                    <input type="text" id="tz-city-search" placeholder="Search city..." autocomplete="off">
                    <div id="tz-search-results"></div>
                    <div id="tz-search-status"></div>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        const searchInput = document.getElementById('tz-city-search');
        const resultsContainer = document.getElementById('tz-search-results');
        const statusLabel = document.getElementById('tz-search-status');
        let searchTimeout = null;

        function clearResults() {
            resultsContainer.style.display = 'none';
            resultsContainer.innerHTML = '';
        }

        function showStatus(msg) {
            statusLabel.textContent = msg || '';
        }

        function escapeHtml(text) {
            if (!text) return '';
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function handleSearchInput(query) {
            clearTimeout(searchTimeout);
            clearResults();
            showStatus('');

            if (query.length < 2) {
                return;
            }

            resultsContainer.style.display = 'block';
            resultsContainer.innerHTML = '<div class="tz-result-item" style="color:#666;">Searching...</div>';

            searchTimeout = setTimeout(function () {
                fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(query) + '&count=5&language=en&format=json')
                    .then(function (res) { return res.json(); })
                    .then(function (data) {
                        renderSearchResults(data.results || []);
                    })
                    .catch(function () {
                        resultsContainer.innerHTML = '<div class="tz-result-item" style="color:#666;">Error searching</div>';
                    });
            }, 500);
        }

        function renderSearchResults(results) {
            resultsContainer.innerHTML = '';
            if (results.length === 0) {
                resultsContainer.innerHTML = '<div class="tz-result-item">No results</div>';
                return;
            }

            results.forEach(function (city) {
                const div = document.createElement('div');
                div.className = 'tz-result-item';
                div.innerHTML = '<strong>' + escapeHtml(city.name) + '</strong> <small>' + escapeHtml(city.country || '') + '</small>';
                div.onclick = function () { selectCity(city); };
                resultsContainer.appendChild(div);
            });
        }

        function selectCity(city) {
            searchInput.disabled = true;
            clearResults();
            showStatus('Getting timezone data...');

            fetch('https://api.open-meteo.com/v1/forecast?latitude=' + city.latitude + '&longitude=' + city.longitude + '&current_weather=true&timezone=auto')
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    const offsetSeconds = data.utc_offset_seconds;
                    const offsetHours = offsetSeconds / 3600;
                    console.log('Auto-Detected Offset:', offsetHours);
                    localStorage.setItem('rekindle_timezone_offset', offsetHours);

                    const locData = {
                        name: city.name || 'Unknown',
                        lat: city.latitude || 0,
                        lon: city.longitude || 0,
                        zone: city.timezone || null,
                        country_code: city.country_code || null,
                        utc_offset: offsetHours
                    };
                    localStorage.setItem('rekindle_location_manual', JSON.stringify(locData));

                    showStatus('Timezone set to UTC' + (offsetHours >= 0 ? '+' : '') + offsetHours);
                    setTimeout(function () {
                        window.location.reload();
                    }, 800);
                })
                .catch(function (e) {
                    console.error('Timezone Fetch Error', e);
                    searchInput.disabled = false;
                    showStatus('Failed to fetch timezone. Try again.');
                });
        }

        searchInput.addEventListener('input', function () {
            handleSearchInput(this.value);
        });

        // Dismiss button removed — user must set timezone or leave the popup open
    }

    // NOTE: checkTimezoneOffset() is no longer auto-run.
    // Call window.rekindleCheckTimezoneOffset() manually on pages that need it.

    // --- DAYLIGHT SAVING COMPONENT ---
    // Injects a UI toggle to enable/disable Daylight Saving Time (+1 hr)
    function renderDSTToggle(parentElement) {
        const container = document.createElement('div');
        container.style.cssText = 'display:flex; align-items:center; margin-top:10px; font-family:"Geneva","Verdana",sans-serif;';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = 'rekindle-dst-toggle';
        checkbox.checked = localStorage.getItem('rekindle_dst_active') === 'true';
        
        const label = document.createElement('label');
        label.htmlFor = 'rekindle-dst-toggle';
        label.innerText = (window.t ? window.t('time.dst_active', 'Daylight Saving Time (+1 hr)') : 'Daylight Saving Time (+1 hr)');
        
        checkbox.addEventListener('change', function() {
            localStorage.setItem('rekindle_dst_active', this.checked);
            document.dispatchEvent(new Event('rekindle:time:dst_changed'));
            // If the user is on a page that needs immediate refresh, they can listen to this event.
        });
        
        container.appendChild(checkbox);
        container.appendChild(label);
        label.style.marginLeft = '10px';
        
        if (parentElement) {
            parentElement.appendChild(container);
        }
        return container;
    }

    // Timezone Exports
    window.rekindleGetGlobalTimeZone = getGlobalTimeZone;
    window.rekindleGetZonedDate = getZonedDate;
    window.rekindleGetDateInZone = getDateInZone;
    window.rekindleFormatTime = formatGlobalTime;
    window.rekindleFormatWallDate = formatWallDate;
    window.rekindleGetUserLocale = getUserLocale;
    window.rekindleCheckTimezoneOffset = checkTimezoneOffset;
    window.rekindleRenderDSTToggle = renderDSTToggle;

})();
