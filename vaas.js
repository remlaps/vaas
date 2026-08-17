/* ============================================================
 * VAAS (Visibility as a Service) — Drop-in video/ad-space widget
 *
 * A self-contained, dependency-free port of the VAAS selection
 * logic shared by steemometer-web and phoenix-prime
 * (specified in VAAS_SELECTION_LOGIC.md).
 *
 * PLUG INTO ANY PROJECT
 *   <link rel="stylesheet" href="vaas.css">
 *   <script src="vaas.js"></script>
 *   <div id="vaas"></div>
 *   <script> VAAS.init().mount('#vaas'); </script>
 *
 * The widget generates its own scoped DOM inside the mount
 * container (no host element IDs required) and adopts the host
 * project's look & feel through CSS var() fallback chains
 * (see vaas.css) plus optional theme overrides.
 * ============================================================ */
(function () {
    'use strict';

    // ------------------------------------------------------------
    // Defaults (all overridable via init()/mount() config)
    // ------------------------------------------------------------
    var DEFAULTS = {
        nodeUrl: 'https://api.steemit.com',
        urlLeft: 'https://steemit.com',
        interval: 30,          // blocks between content refresh
        halflifeBlocks: 1200,  // weight halves this often (~1 hour)
        maxlifeBlocks: 28800,  // item expiry (~1 day)
        minRep: 45.0,
        minFollowers: 20,
        minMedFollowerRep: 35.0,
        pollMsBehind: 1000,    // fixed poll interval (also used for background tabs)
        displayIntervalMs: 90000, // wall-clock ms between display rotations (~90 s)
        position: 'inline',    // 'inline' (fills its container) | 'fixed' (bottom bar)
        storageKey: null,      // override the auto-namespaced localStorage key when not null
        scope: 'page',         // 'page' (per-page state) | 'origin' (shared across all pages on this host)
        theme: null,           // { bg, text, muted, accent, cardBg, border, radius, heat: [...] }
        onDisplay: null        // callback(displayPayload)
    };

    var config = {};
    function applyConfig(overrides) {
        if (!overrides) return;
        Object.keys(DEFAULTS).forEach(function (k) {
            if (overrides[k] !== undefined) config[k] = overrides[k];
        });
    }
    applyConfig(DEFAULTS);

    // ------------------------------------------------------------
    // Runtime state
    // ------------------------------------------------------------
    var state = {
        postPool: [],          // Pool A — null-beneficiary posts
        memoPool: [],          // Pool B — promo/vanity transfers
        lastDisplayTime: 0,    // epoch ms of the last display rotation (time-gates displayCycle)
        lastBlockChecked: 0,
        lastIrreversibleBlock: 0,
        steemPerSbd: 9.5,      // fallback; updated from feed history
        currentBlock: 0,
        polling: false,
        displayType: null,
        displayData: null,
        mounted: false,
        destroyed: false
    };
    var authorCache = {};
    var META_RETRIES = 5;
    var FOLLOWER_PAGES = 5;

    // DOM references (filled on mount)
    var rootEl = null;
    var els = {};
    var injectedThemeStyle = null;
    var pollTimer = null;

    // ------------------------------------------------------------
    // Heat-scale color table
    // ------------------------------------------------------------
    var HEAT_DEFAULT = [
        'rgb(255,100,0)',   // 0  cool
        'rgb(255,100,0)',   // 1
        'rgb(255,128,64)',  // 2  warm
        'rgb(255,128,64)',  // 3
        'rgb(255,128,64)',  // 4
        'rgb(253,152,0)',   // 5  warmer
        'rgb(253,152,0)',   // 6
        'rgb(253,152,0)',   // 7
        'rgb(0,253,228)',   // 8  hot
        'rgb(0,253,228)',   // 9
        'rgb(50,132,255)'   // 10 hottest
    ];

    function heatColor(index) {
        var palette = (config.theme && Array.isArray(config.theme.heat)) ? config.theme.heat : HEAT_DEFAULT;
        if (index < 0 || index > 10) return 'black';
        return palette[index] || 'black';
    }

    function strokeWidth(index) {
        return 2 + Math.floor((1 + index) / 2);
    }

    // ------------------------------------------------------------
    // repLog10 — Steem raw reputation string -> display score
    // ------------------------------------------------------------
    function repLog10(rep) {
        var repStr = String(rep);
        if (repStr === '0') return 25.0;
        var sign = 1;
        if (repStr.indexOf('-') === 0) { sign = -1; repStr = repStr.substring(1); }
        var leadingDigits = parseInt(repStr.substring(0, Math.min(4, repStr.length)), 10);
        var log = Math.log10(leadingDigits) + 0.00000001;
        var n = repStr.length - 1;
        var logValue = n + (log - Math.floor(log));
        var out = Math.max(logValue - 9, 0) * sign;
        out = out * 9 + 25;
        return Math.round(out * 100) / 100;  // HALF_UP, 2 decimals
    }

    function median(arr) {
        if (!arr || arr.length === 0) return 24.99;
        var sorted = arr.slice().sort(function (a, b) { return a - b; });
        var mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 1) return sorted[mid];
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }

    // ------------------------------------------------------------
    // Steem path / URL extraction
    // ------------------------------------------------------------
    function extractSteemPath(memo) {
        var patterns = [
            /(?:https?:\/\/[^\s\/]+\/)?(?:[^\s\/]+\/)?@([a-z0-9.-]+)\/([^\s]+)/i,
            /(?:https?:\/\/[^\s\/]+\/)?@([a-z0-9.-]+)\/([^\s]+)/i,
            /@([a-z0-9.-]+)\/([^\s]+)/i
        ];
        for (var i = 0; i < patterns.length; i++) {
            var m = memo.match(patterns[i]);
            if (m) {
                var path = m[0];
                var hostMatch = path.match(/^https?:\/\/[^\s\/]+/i);
                if (hostMatch) path = path.substring(hostMatch[0].length);
                if (path.indexOf('/') !== 0) path = '/' + path;
                return path;
            }
        }
        return null;
    }

    function extractURL(memo) {
        var re = /(?:https?|ftp):\/\/[^\s]+/i;
        var m = memo.match(re);
        return m ? m[0] : null;
    }

    function parseSteemPath(path) {
        var m = path.match(/@([a-z0-9.-]+)\/([^\s]+)/i);
        if (!m) return null;
        return { author: m[1], permlink: m[2] };
    }

    // ------------------------------------------------------------
    // Age decay & expiry
    // ------------------------------------------------------------
    function adjustedNullBenWeight(post, block) {
        var adjusted = post.nullBenWeight;
        var tf = block - post.blockNumber;
        while (tf > config.halflifeBlocks) {
            tf -= config.halflifeBlocks;
            adjusted = Math.floor(adjusted / 2);  // integer division
        }
        return adjusted;
    }

    function adjustedPromoWeight(memo, block) {
        var adjusted = memo.xferNormal;
        var tf = block - memo.blockNumber;
        while (tf > config.halflifeBlocks) {
            tf -= config.halflifeBlocks;
            adjusted = adjusted / 2.0;            // floating-point division
        }
        return adjusted;
    }

    function trimExpired() {
        state.postPool = state.postPool.filter(function (p) {
            return (state.currentBlock - p.blockNumber) <= config.maxlifeBlocks;
        });
        state.memoPool = state.memoPool.filter(function (m) {
            return (state.currentBlock - m.blockNumber) <= config.maxlifeBlocks;
        });
    }

    // ------------------------------------------------------------
    // Weighted random selection
    // ------------------------------------------------------------
    function getRandomPost() {
        if (state.postPool.length === 0) return null;
        var totalWeight = 0;
        for (var i = 0; i < state.postPool.length; i++) {
            totalWeight += adjustedNullBenWeight(state.postPool[i], state.currentBlock);
        }
        var randomValue = Math.floor(Math.random() * (totalWeight + 1));
        var postIndex = 0;
        while (randomValue > 0 && postIndex < state.postPool.length) {
            randomValue -= adjustedNullBenWeight(state.postPool[postIndex], state.currentBlock);
            postIndex += 1;
        }
        return state.postPool[Math.max(0, postIndex - 1)];
    }

    function getRandomMemo() {
        if (state.memoPool.length === 0) return null;
        var totalWeight = 0.0;
        for (var i = 0; i < state.memoPool.length; i++) {
            totalWeight += adjustedPromoWeight(state.memoPool[i], state.currentBlock);
        }
        var randomValue = Math.random() * totalWeight;
        var memoIndex = 0;
        while (randomValue > 0.0 && memoIndex < state.memoPool.length) {
            randomValue -= adjustedPromoWeight(state.memoPool[memoIndex], state.currentBlock);
            memoIndex += 1;
        }
        return state.memoPool[Math.max(0, memoIndex - 1)];
    }

    // ------------------------------------------------------------
    // Display-type selection (0 = ben post; 1 & 2 = promo memo)
    // ------------------------------------------------------------
    function selectType() {
        var numTypes = 3;
        var vaasType = Math.floor(Math.random() * numTypes);
        var checkType = vaasType;
        for (var lcv = 0; lcv < numTypes; lcv++) {
            if (checkType === 0) {
                if (state.postPool.length !== 0) return checkType;
                checkType = checkType + 1;
            } else if (checkType === 1 || checkType === 2) {
                if (state.memoPool.length !== 0) return checkType;
                checkType = checkType + 1;
            }
            if (checkType === numTypes) checkType = 0;
        }
        return vaasType;
    }

    // ------------------------------------------------------------
    // API helpers
    // ------------------------------------------------------------
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    async function rpc(method, params) {
        var resp = await fetch(config.nodeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: method, params: params, id: 1 })
        });
        var data = await resp.json();
        if (data && data.error) throw new Error(data.error.message || 'RPC error');
        return data && data.result;
    }

    async function fetchAuthorData(author) {
        if (authorCache[author]) return authorCache[author];
        var result = { reputation: 0, followers: 0, medianRep: 24.99 };
        try {
            var repRes = await rpc('condenser_api.get_account_reputations', [author, 1]);
            if (repRes && repRes.length > 0 && repRes[0].reputation) {
                result.reputation = repLog10(repRes[0].reputation);
            }
            var folRes = await rpc('follow_api.get_follow_count', [author]);
            if (folRes && folRes.follower_count) result.followers = folRes.follower_count;
            var reps = [];
            var start = null;
            for (var page = 0; page < FOLLOWER_PAGES; page++) {
                var params = { account: author, start: start, type: 'blog', limit: 1000 };
                var fol = await rpc('follow_api.get_followers', params);
                if (!fol || fol.length === 0) break;
                for (var f = 0; f < fol.length; f++) {
                    if (typeof fol[f].reputation !== 'undefined') reps.push(parseInt(fol[f].reputation, 10));
                }
                start = fol[fol.length - 1].follower;
                if (fol.length < 1000) break;
            }
            result.medianRep = median(reps);
        } catch (e) {
            console.error('VAAS author data error:', e);
        }
        authorCache[author] = result;
        return result;
    }

    async function fetchPostMetadata(author, permlink) {
        var post = null;
        for (var attempt = 0; attempt < META_RETRIES; attempt++) {
            try {
                post = await rpc('condenser_api.get_content', [author, permlink]);
                if (post) break;
            } catch (e) { /* retry */ }
            await sleep(300);
        }
        if (!post) return null;
        var payoutMatch = String(post.pending_payout_value || '0').match(/^([\d.]+)/);
        return {
            title: post.title || '',
            rootAuthor: post.root_author || '',
            rootTitle: post.root_title || '',
            pendingPayout: payoutMatch ? parseFloat(payoutMatch[1]) : 0,
            netVotes: parseInt(post.net_votes, 10) || 0,
            url: post.url || ('/' + author + '/' + permlink)
        };
    }

    function resolveTitle(meta) {
        if (!meta) return '';
        if (meta.title) return meta.title;
        if (meta.rootTitle) return 'Re: @' + meta.rootAuthor + ': ' + meta.rootTitle;
        return '';
    }

    async function fetchFeedHistory() {
        try {
            var res = await rpc('condenser_api.get_feed_history', []);
            if (res && res.price_history && res.price_history.length > 0) {
                var ratios = [];
                for (var i = 0; i < res.price_history.length; i++) {
                    var q = String(res.price_history[i].quote || '').match(/^([\d.]+)/);
                    var b = String(res.price_history[i].base || '').match(/^([\d.]+)/);
                    if (q && b && parseFloat(b[1]) > 0) ratios.push(parseFloat(q[1]) / parseFloat(b[1]));
                }
                if (ratios.length > 0) state.steemPerSbd = median(ratios);
            }
        } catch (e) { /* keep fallback */ }
    }

    // ------------------------------------------------------------
    // Pool building
    // ------------------------------------------------------------
    async function processBlockOps(ops, blockNum) {
        for (var i = 0; i < ops.length; i++) {
            var opEntry = ops[i];
            var opTuple = opEntry && opEntry.op;
            if (!Array.isArray(opTuple) || opTuple.length < 2) continue;
            var opName = opTuple[0];
            var opData = opTuple[1];
            if (!opData) continue;

            if (opName === 'comment_options') {
                var extensions = opData.extensions;
                if (!Array.isArray(extensions)) continue;
                var nullWeight = -1;
                for (var e = 0; e < extensions.length; e++) {
                    var ext = extensions[e];
                    if (!Array.isArray(ext) || ext.length < 2) continue;
                    var val = ext[1];
                    if (val && Array.isArray(val.beneficiaries)) {
                        for (var b = 0; b < val.beneficiaries.length; b++) {
                            if (val.beneficiaries[b] && val.beneficiaries[b].account === 'null') {
                                nullWeight = parseInt(val.beneficiaries[b].weight, 10) || 0;
                            }
                        }
                    }
                }
                if (nullWeight === -1) continue;
                var authorData = await fetchAuthorData(opData.author);
                if (authorData.reputation <= config.minRep) continue;
                if (authorData.followers <= config.minFollowers) continue;
                if (authorData.medianRep <= config.minMedFollowerRep) continue;
                state.postPool.push({
                    author: opData.author,
                    permlink: opData.permlink,
                    nullBenWeight: nullWeight,
                    blockNumber: blockNum
                });
            } else if (opName === 'transfer') {
                if (opData.to !== 'null') continue;
                var memo = String(opData.memo || '').trim();
                if (memo === '') continue;
                var parts = String(opData.amount || '').split(' ');
                var amount = parseFloat(parts[0]) || 0;
                var type = parts[1] || 'STEEM';
                var normal = amount;
                if (type === 'SBD') normal = amount * state.steemPerSbd;
                state.memoPool.push({
                    xferFrom: opData.from,
                    xferTo: 'null',
                    xferMemo: memo,
                    xferType: type,
                    xferAmount: amount,
                    xferNormal: normal,
                    blockNumber: blockNum,
                    firstURL: extractURL(memo),
                    firstSteemPath: extractSteemPath(memo)
                });
            }
        }
    }

    // ------------------------------------------------------------
    // DOM generation (self-contained; no host IDs required)
    // ------------------------------------------------------------
    function buildDom() {
        function holder(cls, base) {
            return '<div class="' + cls + ' vaas-holder hidden">' +
                '<div class="vaas-heading vaas-' + base + '-heading"></div>' +
                '<div class="vaas-scroll-wrap">' +
                '<div class="vaas-scroll-text vaas-' + base + '-scroll"></div></div>' +
                '<div class="vaas-details vaas-' + base + '-details"></div>' +
                '<a class="vaas-link vaas-' + base + '-link" href="#" target="_blank" rel="noopener"></a>' +
                '</div>';
        }
        var section = document.createElement('div');
        section.className = 'vaas-section' + (config.position === 'fixed' ? ' vaas-fixed' : '');
        section.innerHTML =
            '<div class="vaas-header">' +
            '<div class="vaas-title">VAAS <span class="small">Visibility as a Service</span></div>' +
            '<div class="vaas-status"></div>' +
            '</div>' +
            holder('vaas-ben-holder', 'ben') +
            holder('vaas-promo-holder', 'promo');
        return section;
    }

    // ------------------------------------------------------------
    // Display payload computation
    // ------------------------------------------------------------
    function computeBenDisplay(post, authorData) {
        var nullWeight = post.nullBenWeight / 100.0;
        var colorIndex = Math.floor(nullWeight / 10);
        return {
            type: 'ben',
            heading: '\ud83d\udd25 @null Beneficiary Post \u2014 ' + nullWeight.toFixed(1) + '% burn',
            scrollText: resolveTitle(post) || '(untitled)',
            colorIndex: colorIndex,
            details: [
                { label: 'Author', value: '@' + post.author },
                { label: 'Rep', value: authorData.reputation.toFixed(2) },
                { label: 'Followers', value: authorData.followers.toLocaleString() },
                { label: 'Med Follower Rep', value: authorData.medianRep.toFixed(2) },
                { label: 'Payout', value: post.pendingPayout.toFixed(3) + ' SBD' },
                { label: 'Votes', value: post.netVotes.toLocaleString() }
            ],
            linkText: 'View on Steem \u2192',
            linkHref: config.urlLeft + post.steemURL
        };
    }

    function computePromoDisplay(memo, postMeta, authorData) {
        var burnAmount = 0;
        for (var i = 0; i < state.memoPool.length; i++) {
            if (state.memoPool[i].xferFrom === memo.xferFrom && state.memoPool[i].xferMemo === memo.xferMemo) {
                burnAmount += state.memoPool[i].xferNormal;
            }
        }
        var colorIndex;
        if (burnAmount < 0.001) colorIndex = 0;
        else if (burnAmount < 0.1) colorIndex = 2;
        else if (burnAmount < 10) colorIndex = 5;
        else if (burnAmount < 100) colorIndex = 8;
        else colorIndex = 10;

        var display = { type: 'promo', colorIndex: colorIndex, burnAmount: burnAmount.toFixed(3) };
        var parsed = memo.firstSteemPath ? parseSteemPath(memo.firstSteemPath) : null;
        if (parsed) {
            display.heading = '\ud83d\udce2 Promo: ' + burnAmount.toFixed(3) + ' STEEM';
            display.scrollText = postMeta ? (resolveTitle(postMeta) || '@' + parsed.author) : '@' + parsed.author;
            display.details = [
                { label: 'Author', value: '@' + parsed.author },
                { label: 'Rep', value: authorData ? authorData.reputation.toFixed(2) : '\u2014' },
                { label: 'Followers', value: authorData ? authorData.followers.toLocaleString() : '\u2014' },
                { label: 'Med Follower Rep', value: authorData ? authorData.medianRep.toFixed(2) : '\u2014' },
                { label: 'Payout', value: postMeta ? postMeta.pendingPayout.toFixed(3) + ' SBD' : '\u2014' },
                { label: 'Votes', value: postMeta ? postMeta.netVotes.toLocaleString() : '\u2014' }
            ];
            var path = memo.firstSteemPath;
            if (path.indexOf('/') !== 0) path = '/' + path;
            display.linkText = 'View Promoted Post \u2192';
            display.linkHref = config.urlLeft + path;
        } else {
            display.heading = '\ud83d\udcac @' + memo.xferFrom + ' says:';
            display.scrollText = memo.xferMemo;
            display.details = [
                { label: 'From', value: '@' + memo.xferFrom },
                { label: 'Amount', value: memo.xferAmount.toFixed(3) + ' ' + memo.xferType },
                { label: 'Normalized', value: memo.xferNormal.toFixed(3) + ' STEEM' },
                { label: 'Total Promo', value: burnAmount.toFixed(3) + ' STEEM' }
            ];
            if (memo.firstURL) {
                display.linkText = 'Open URL \u2192';
                display.linkHref = memo.firstURL;
            } else {
                display.linkText = 'View Profile \u2192';
                display.linkHref = config.urlLeft + '/@' + memo.xferFrom;
            }
        }
        return display;
    }

    function setScrollText(el, text) {
        if (!el) return;
        el.textContent = text;
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
    }

    function applyBorder(holderEl, colorIndex) {
        if (!holderEl) return;
        holderEl.style.borderColor = heatColor(colorIndex);
        holderEl.style.borderWidth = strokeWidth(colorIndex) + 'px';
        holderEl.style.boxShadow = '0 0 12px rgba(0,0,0,0.3)';
    }

    function showEmpty() {
        if (els.benHolder) els.benHolder.classList.add('hidden');
        if (els.promoHolder) els.promoHolder.classList.add('hidden');
    }

    function updateStatus() {
        if (!els.status) return;
        var promos = 0, broadcasts = 0;
        for (var i = 0; i < state.memoPool.length; i++) {
            if (state.memoPool[i].firstSteemPath) promos++;
            else broadcasts++;
        }
        els.status.textContent = 'Block #' + state.currentBlock.toLocaleString() +
            ' | Posts: ' + state.postPool.length +
            ' | Promos: ' + promos + ' | Broadcasts: ' + broadcasts;
    }

    function renderDisplay(display) {
        if (!display || !display.type) { showEmpty(); return; }
        if (display.type === 'ben') {
            if (els.promoHolder) els.promoHolder.classList.add('hidden');
            if (els.benHolder) els.benHolder.classList.remove('hidden');
            applyBorder(els.benHolder, display.colorIndex);
            if (els.benHeading) els.benHeading.textContent = display.heading;
            setScrollText(els.benScroll, display.scrollText);
            if (els.benDetails) {
                els.benDetails.innerHTML = display.details.map(function (x) {
                    return '<span>' + x.label + ': <strong>' + x.value + '</strong></span>';
                }).join('');
            }
            if (els.benLink) { els.benLink.href = display.linkHref; els.benLink.textContent = display.linkText; }
            state.displayType = 'ben';
            state.displayData = display;
        } else {
            if (els.benHolder) els.benHolder.classList.add('hidden');
            if (els.promoHolder) els.promoHolder.classList.remove('hidden');
            applyBorder(els.promoHolder, display.colorIndex);
            if (els.promoHeading) els.promoHeading.textContent = display.heading;
            setScrollText(els.promoScroll, display.scrollText);
            if (els.promoDetails) {
                els.promoDetails.innerHTML = display.details.map(function (x) {
                    return '<span>' + x.label + ': <strong>' + x.value + '</strong></span>';
                }).join('');
            }
            if (els.promoLink) { els.promoLink.href = display.linkHref; els.promoLink.textContent = display.linkText; }
            state.displayType = 'promo';
            state.displayData = display;
        }
        if (config.onDisplay) {
            try { config.onDisplay(display); } catch (e) { /* ignore */ }
        }
    }

    // ------------------------------------------------------------
    // Display cycle
    // ------------------------------------------------------------
    async function handleBeneficiaryPost() {
        var post = getRandomPost();
        if (!post) { if (state.postPool.length === 0) showEmpty(); return; }
        var meta = await fetchPostMetadata(post.author, post.permlink);
        if (!meta) { showEmpty(); return; }
        post.title = meta.title;
        post.rootAuthor = meta.rootAuthor;
        post.rootTitle = meta.rootTitle;
        post.pendingPayout = meta.pendingPayout;
        post.netVotes = meta.netVotes;
        post.steemURL = meta.url;
        var authorData = await fetchAuthorData(post.author);
        renderDisplay(computeBenDisplay(post, authorData));
        persistShared();
    }

    async function handlePromoMemo() {
        if (state.memoPool.length === 0) { showEmpty(); return; }
        var memo = getRandomMemo();
        if (!memo) return;
        var postMeta = null, authorData = null;
        if (memo.firstSteemPath) {
            var parsed = parseSteemPath(memo.firstSteemPath);
            if (parsed) {
                postMeta = await fetchPostMetadata(parsed.author, parsed.permlink);
                authorData = await fetchAuthorData(parsed.author);
            }
        }
        renderDisplay(computePromoDisplay(memo, postMeta, authorData));
        persistShared();
    }

    async function displayCycle() {
        // Time-gate the rotation on WALL-CLOCK elapsed time, not on the number of
        // blocks drained. pollBlock()'s while-loop can process hundreds of blocks
        // in a fast burst (e.g. catching up after a hidden tab). Under the old
        // "every `interval` blocks" rule that burst rotated the display far more
        // often than the intended ~90 s. Gating on Date.now() keeps rotations to
        // one per displayIntervalMs no matter how fast we catch up.
        var now = Date.now();
        if (state.lastDisplayTime && (now - state.lastDisplayTime) < config.displayIntervalMs) return;
        state.lastDisplayTime = now;
        trimExpired();
        var type = selectType();
        if (type === 0) await handleBeneficiaryPost();
        else if (type === 1 || type === 2) await handlePromoMemo();
        else showEmpty();
        updateStatus();
    }

    // ------------------------------------------------------------
    // Blockchain polling
    // ------------------------------------------------------------
    async function pollBlock() {
        if (state.polling || !state.mounted || state.destroyed) return;
        state.polling = true;
        try {
            var props = await rpc('condenser_api.get_dynamic_global_properties', []);
            if (!props || !props.last_irreversible_block_num) return;
            var lastIrreversible = props.last_irreversible_block_num;
            state.lastIrreversibleBlock = lastIrreversible;
            trimExpired(); // age out old entries continuously, even when the tab is unfocused
            if (state.lastBlockChecked === 0) {
                state.lastBlockChecked = lastIrreversible;
                state.currentBlock = lastIrreversible;
                updateStatus();
                return;
            }
            // Catch up on every block missed while the tab was hidden or the
            // timer was throttled. Hidden tabs are throttled far harder than 1s
            // today (Chrome "intensive throttling" fires background-tab timers at
            // ~1/minute; some engines pause them entirely), so advancing only ONE
            // block per poll lets currentBlock / lastBlockChecked permanently lag
            // the chain. Draining the whole gap in a single pass guarantees the
            // widget never falls behind, no matter how aggressive the background
            // throttling was between ticks.
            while (state.lastBlockChecked < lastIrreversible) {
                var blockNum = state.lastBlockChecked + 1;
                var ops = await rpc('condenser_api.get_ops_in_block', [blockNum, false]);
                if (ops && Array.isArray(ops)) await processBlockOps(ops, blockNum);
                state.lastBlockChecked = blockNum;
                state.currentBlock = blockNum;
            }
            // Try to rotate the display once per poll pass. displayCycle() is
            // internally time-gated (Date.now() vs lastDisplayTime), so this fires
            // at most once per rotation interval even after a long background
            // catch-up burst, and harmlessly no-ops on passes where < 90 s remain.
            await displayCycle();
            updateStatus();
        } catch (e) {
            console.error('VAAS poll error:', e);
        } finally {
            state.polling = false;
        }
    }

    // Poll on a fixed interval. While the tab is hidden, browsers throttle this
    // timer heavily (some to ~1/minute), so polling alone can't keep currentBlock
    // in lockstep with the chain. pollBlock() therefore drains the entire
    // missed-block gap in one pass on every tick, so even a throttled background
    // poll fully catches up the moment it fires.
    function startPolling() {
        if (state.destroyed || !state.mounted) return;
        pollTimer = setInterval(function () {
            pollBlock();
        }, config.pollMsBehind);
    }

    // When the tab regains focus, catch back up immediately instead of waiting for
    // the next (possibly throttled) interval tick. visibilitychange fires on
    // refocus; pageshow covers bfcache restores. The state.polling guard (set
    // synchronously at the top of pollBlock) prevents overlapping runs.
    function pollNowIfVisible() {
        if (!state.mounted || state.destroyed) return;
        if (document.visibilityState === 'visible' && !state.polling) pollBlock();
    }

    // ------------------------------------------------------------
    // Shared state (localStorage, namespaced per host page)
    // ------------------------------------------------------------
    function storageKey() {
        if (config.storageKey) return config.storageKey;
        var scoped = (config.scope === 'origin') ? location.hostname : (location.hostname + location.pathname);
        var host = scoped.replace(/[^a-zA-Z0-9]/g, '_');
        return 'vaas_state_' + host + '_v1';
    }

    function persistShared() {
        try {
            var data = {
                postPool: state.postPool,
                memoPool: state.memoPool,
                currentBlock: state.currentBlock,
                lastBlockChecked: state.lastBlockChecked,
                displayType: state.displayType,
                displayData: state.displayData,
                timestamp: Date.now()
            };
            localStorage.setItem(storageKey(), JSON.stringify(data));
        } catch (e) { /* storage unavailable */ }
    }

    function restoreShared() {
        try {
            var raw = localStorage.getItem(storageKey());
            if (!raw) return false;
            var data = JSON.parse(raw);
            if (!data || typeof data !== 'object') return false;
            if (Array.isArray(data.postPool)) state.postPool = data.postPool;
            if (Array.isArray(data.memoPool)) state.memoPool = data.memoPool;
            if (typeof data.currentBlock === 'number') state.currentBlock = data.currentBlock;
            if (typeof data.lastBlockChecked === 'number') state.lastBlockChecked = data.lastBlockChecked;
            if (data.displayType) state.displayType = data.displayType;
            if (data.displayData) renderDisplay(data.displayData);
            return true;
        } catch (e) { return false; }
    }

    // ------------------------------------------------------------
    // Theme injection (explicit config.theme overrides everything)
    // ------------------------------------------------------------
    function injectTheme() {
        if (injectedThemeStyle) return;
        var theme = config.theme;
        if (!theme) return;
        var mapping = [
            ['bg', '--vaas-bg'],
            ['text', '--vaas-text'],
            ['muted', '--vaas-muted'],
            ['accent', '--vaas-accent'],
            ['cardBg', '--vaas-card-bg'],
            ['border', '--vaas-border'],
            ['radius', '--vaas-radius']
        ];
        var css = '.vaas-section{';
        for (var i = 0; i < mapping.length; i++) {
            if (theme[mapping[i][0]] !== undefined) css += mapping[i][1] + ':' + theme[mapping[i][0]] + ';';
        }
        css += '}';
        if (Array.isArray(theme.heat)) {
            css += '.vaas-section{';
            for (var h = 0; h < theme.heat.length; h++) css += '--vaas-heat-' + h + ':' + theme.heat[h] + ';';
            css += '}';
        }
        injectedThemeStyle = document.createElement('style');
        injectedThemeStyle.id = 'vaas-theme-custom';
        injectedThemeStyle.textContent = css;
        document.head.appendChild(injectedThemeStyle);
    }

    // ------------------------------------------------------------
    // Mount / unmount
    // ------------------------------------------------------------
    function mount(target, overrides) {
        if (state.mounted) { console.warn('VAAS already mounted; ignoring.'); return; }
        applyConfig(overrides);
        injectTheme();
        var el = typeof target === 'string' ? document.querySelector(target) : target;
        if (!el) { console.error('VAAS mount target not found:', target); return; }
        rootEl = buildDom();
        el.appendChild(rootEl);
        els = {
            status: rootEl.querySelector('.vaas-status'),
            benHolder: rootEl.querySelector('.vaas-ben-holder'),
            promoHolder: rootEl.querySelector('.vaas-promo-holder'),
            benHeading: rootEl.querySelector('.vaas-ben-heading'),
            benScroll: rootEl.querySelector('.vaas-ben-scroll'),
            benDetails: rootEl.querySelector('.vaas-ben-details'),
            benLink: rootEl.querySelector('.vaas-ben-link'),
            promoHeading: rootEl.querySelector('.vaas-promo-heading'),
            promoScroll: rootEl.querySelector('.vaas-promo-scroll'),
            promoDetails: rootEl.querySelector('.vaas-promo-details'),
            promoLink: rootEl.querySelector('.vaas-promo-link')
        };
        state.mounted = true;
        state.destroyed = false;
        document.addEventListener('visibilitychange', pollNowIfVisible);
        document.addEventListener('pageshow', pollNowIfVisible);
        (async function () {
            try {
                var restored = restoreShared();
                if (restored) updateStatus();
                await fetchFeedHistory();
                await pollBlock();
                startPolling();
            } catch (e) {
                console.error('VAAS init error:', e);
                if (els.status) els.status.textContent = 'VAAS initialization failed.';
            }
        })();
    }

    function unmount() {
        if (!state.mounted) return;
        state.mounted = false;
        state.destroyed = true;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        document.removeEventListener('visibilitychange', pollNowIfVisible);
        document.removeEventListener('pageshow', pollNowIfVisible);
        if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
        if (injectedThemeStyle && injectedThemeStyle.parentNode) injectedThemeStyle.parentNode.removeChild(injectedThemeStyle);
        injectedThemeStyle = null;
        rootEl = null;
        els = {};
        state.postPool = [];
        state.memoPool = [];
    }

    function refresh() {
        displayCycle().then(function () { updateStatus(); });
    }

    // ------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------
    window.VAAS = {
        init: function (cfg) { applyConfig(cfg); return this; },
        mount: mount,
        unmount: unmount,
        refresh: refresh
    };
})();