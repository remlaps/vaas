/* Minimal headless smoke test for vaas.js
 * Run: node smoke.test.js
 * Provides a lightweight DOM/fetch/localStorage shim so the widget's
 * mount -> poll -> pool-build -> display pipeline can execute in Node.
 */
'use strict';

// --- tiny DOM shim -------------------------------------------------
function makeEl() {
    return {
        children: [],
        style: {},
        classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
        textContent: '',
        _html: '',
        parentNode: null,
        appendChild: function (c) { this.children.push(c); c.parentNode = this; return c; },
        removeChild: function (c) {
            const idx = this.children.indexOf(c);
            if (idx >= 0) this.children.splice(idx, 1);
        },
        set innerHTML(v) { this._html = v; },
        get innerHTML() { return this._html; },
        setAttribute: function () {},
        querySelector: function () { return makeEl(); }
    };
}

global.window = globalThis;
global.location = { hostname: 'testhost', pathname: '/' };
global.localStorage = (function () {
    const store = {};
    return { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
})();
global.document = {
    createElement: function () { return makeEl(); },
    querySelector: function () { return makeEl(); },
    head: { appendChild: function () {} },
    addEventListener: function () {},
    removeEventListener: function () {}
};

// --- fetch shim (Steem RPC) ---------------------------------------
let headNum = 29;          // 1st poll: head 30 (sync); 2nd poll: head 31 -> display try
function headNext() { headNum += 1; return headNum; }

global.fetch = async function (url, opts) {
    const body = JSON.parse(opts.body);
    const m = body.method;
    let result;
    if (m === 'condenser_api.get_dynamic_global_properties') {
        result = { last_irreversible_block_num: headNext() };
    } else if (m === 'condenser_api.get_feed_history') {
        result = {
            price_history: [
                { quote: '1.000 SBD', base: '9.000 STEEM' },
                { quote: '1.000 SBD', base: '8.000 STEEM' }
            ]
        };
    } else if (m === 'condenser_api.get_ops_in_block') {
        // One promo transfer (vanity) + one null-beneficiary post.
        result = [
            { op: ['transfer', { from: 'alice', to: 'null', amount: '0.500 STEEM', memo: 'Hello from alice' }] },
            {
                op: ['comment_options', {
                    author: 'bob',
                    permlink: 'my-post',
                    extensions: [[0, { beneficiaries: [
                        { account: 'null', weight: 2500 },
                        { account: 'steemcurator01', weight: 100 }
                    ] }]]
                }]
            }
        ];
    } else if (m === 'condenser_api.get_account_reputations') {
        result = [{ reputation: '12345678901234567890123' }];
    } else if (m === 'follow_api.get_follow_count') {
        result = { follower_count: 500 };
    } else if (m === 'follow_api.get_followers') {
        result = [{ follower: 'f1', reputation: '9000000000000000' }];
    } else if (m === 'condenser_api.get_content') {
        result = {
            title: 'My Test Post',
            root_author: 'bob',
            root_title: 'My Test Post',
            pending_payout_value: '5.000 SBD',
            net_votes: 12,
            url: '/@bob/my-post'
        };
    } else {
        result = null;
    }
    return { json: async function () { return { jsonrpc: '2.0', result: result }; } };
};

// --- load the widget and drive it ---------------------------------
require('./vaas.js');        // executes the IIFE; assigns window.VAAS === globalThis.VAAS
const VAAS = globalThis.VAAS;
const captured = [];

(async function () {
    const target = makeEl();
    VAAS.init({
        // Disable the wall-clock rotation gate so a display renders quickly under test.
        displayIntervalMs: 1,
        pollMsBehind: 50,
        onDisplay: function (d) { captured.push(d); }
    }).mount(target);

    // Let a few poll cycles run so at least one display cycle executes.
    await new Promise(r => setTimeout(r, 800));
    VAAS.unmount();

    let pass = true;

    if (captured.length === 0) {
        const status = target.children[0] && target.children[0].textContent;
        console.log('FAIL: no display rendered within the window.');
        console.log('  status text:', status);
        pass = false;
    } else {
        captured.forEach(function (d) {
            console.log('DISPLAY type=' + d.type + ' | heading=' + d.heading);
            if (!d.type || !d.heading) pass = false;
        });
        // Pools both non-empty, so memos should have been normalized (SBD/STEEM).
        console.log('rendered ' + captured.length + ' display(s)');
    }

    console.log(pass ? 'SMOKE TEST: PASS' : 'SMOKE TEST: FAIL');
    process.exit(pass ? 0 : 1);
})();