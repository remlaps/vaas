# VAAS Selection Logic — Implementation Instructions

This document describes the **VAAS** (Visible Attention / Advertisement System) selection logic used in the Steemometer desktop application (a JavaFX app that monitors the Steem blockchain). The goal of this document is to give another LLM (or developer) everything needed to **re-implement the same logic in a different program and/or language**, without requiring access to the original codebase.

If you have access to the original code, the canonical implementation can be cross-checked in these files:

| File | Role |
|---|---|
| `src/main/java/steemometer/Steemometer.java` | Display loop; type selection; 30-block refresh cadence; promo-memo rendering decisions |
| `src/main/java/steemometer/CountOps.java` | Blockchain polling; building the two candidate pools |
| `src/main/java/steemometer/PostDisplayManager.java` | Weighted-random selection + expiry trimming for beneficiary posts |
| `src/main/java/steemometer/XferMemoManager.java` | Weighted-random selection + expiry trimming for promo/vanity transfers |
| `src/main/java/steemometer/PostInfo.java` | Beneficiary-post data model; age-decay weighting for posts |
| `src/main/java/steemometer/XferMemoInfo.java` | Transfer-memo data model; age-decay weighting for memos; SBD→STEEM normalization |
| `src/main/java/steemometer/SteemometerConfig.java` + `src/main/resources/steemometer.properties` | Configuration values |
| `src/main/java/steemometer/AuthorInfo.java`, `MedianCalculator.java`, `SteemPriceFetcher.java`, `UriValidator.java` | Supporting lookups and helpers |

---

## 1. Overview

The VAAS cycles between two kinds of content, displayed one at a time in a rotating "ad space":

1. **Null-beneficiary posts ("burn posts")** — Posts on the Steem blockchain whose `comment_options` operation includes the account `null` as a beneficiary. These are authors "burning" a portion of their post rewards.
2. **Promotional transfers / vanity messages** — `transfer` operations sent to the account `null` with a **non-blank memo**. The memo may contain a link to a post (post promotion), a general URL, or plain text (a vanity/broadcast message).

Every display cycle the program:

1. Picks a display **type** at random (with fallback if the type's pool is empty).
2. From the chosen pool, picks a random **item**, weighted by an age-decayed "promotion weight."
3. Fetches metadata for the chosen item (author reputation, follower count, median follower reputation, post title/payout/votes).
4. Displays it in the VAAS area for a fixed number of blocks, then repeats.

The selection is designed so that:
- **Higher null-beneficiary weight** → a post is displayed more often.
- **Larger normalized transfer amount** → a promo memo is displayed more often.
- **Older items** become less likely to be shown (weight halves every halflife) and are **removed entirely** after a max lifetime.

---

## 2. System Inputs & Configuration

### 2.1 Blockchain input

The program polls the Steem blockchain one block at a time using the JSON-RPC method:

```
POST {node URL}
Body: {"jsonrpc":"2.0","method":"condenser_api.get_ops_in_block","params":[<blockNum>, false],"id":1}
```

`false` means "include virtual operations" is disabled (only real operations are returned). The response contains a `result` array; each element has `op` (an array where `op[0]` is the operation name string and `op[1]` is the operation's data object) and `trx_id`.

A new block is processed only when `lastBlockChecked < lastIrreversibleBlock`; after processing, `lastBlockChecked` is set to the processed block number.

### 2.2 Configuration values

From `steemometer.properties`:

| Property | Default at time of writing | Meaning |
|---|---|---|
| `blocksPerMinute` | `20` | Approximate Steem block rate per minute (used only for context/metrics) |
| `halflifeBlocks` | `1200` | Display weight halves this often; ~1 hour at 3s/block |
| `maxlifeBlocks` | `28800` | Items removed from pools after this many blocks; 1 day at 3s/block |
| `startBlock` | `-1` | If `< 1`, start polling at the last irreversible block; otherwise start at this block number |

### 2.3 Display timing

- **`VAAS_INTERVAL = 30`** — the number of blocks between VAAS content refreshes.
- Steem produces roughly one block every 3 seconds, so each VAAS display lasts roughly `30 × 3 = 90` seconds.

---

## 3. Candidate Collection (Building the Pools)

Two in-memory pools are maintained and updated continuously as blocks are scanned.

### 3.1 Pool A — Null-beneficiary posts (`PostDisplayManager` list of `PostInfo`)

**Trigger:** every `comment_options` operation.

**How to detect a null beneficiary:**
- The operation data object contains a key `extensions` (generally an array of `[key, value]` pairs; the beneficiary list is under the `beneficiaries` key in the value object).
- Each beneficiary entry is an object `{ "account": <name>, "weight": <int> }`.
- The weight is an integer where **25% = 2500** (i.e., percent × 100).
- If any beneficiary has `account == "null"`, extract its `weight` as `nullWeight`.

**Quality gates** — fetch the author's data and only add the post to the pool if **all** of these pass:

| Gate | Constant | Condition to be added |
|---|---|---|
| Author reputation | `MINREP_FOR_BEN_DISPLAY = 45.0` | `reputation > 45.0` |
| Follower count | `MIN_FOLLOWERS_FOR_BEN_DISPLAY = 20` | `followerCount > 20` |
| Median follower reputation | `MED_FOLLOWER_REP_FOR_BEN_DISPLAY = 35.0` | `medianFollowerRep > 35.0` |

(The reputation here is the "display" reputation, roughly 0–75+, computed from the raw Steem reputation string — see §10.2. The median follower reputation uses a similar scale.)

**Record stored for each accepted post:**
- `author`, `permlink` (from the operation data), `nullBenWeight` (the null beneficiary weight found), `blockNumber` (the block that contained the `comment_options` op).
- Cached metadata (fetched lazily at display time, or can be prefetched): `title`, `pendingPayout`, `netVotes`, `authorReputation`, `authorFollowers`, `medianRepOfFollowers`, `steemURL`.

### 3.2 Pool B — Promotional transfers (`XferMemoManager` list of `XferMemoInfo`)

**Trigger:** every `transfer` operation.

**Acceptance rule:** add to the pool **only if** `to == "null"` **and** the `memo` field is **non-blank**. (Transfers with a blank memo to `null` are skipped; transfers to any other account are ignored.)

**SBD→STEEM normalization:** the transfer's `amount` field is a string like `"12.345 STEEM"` or `"0.500 SBD"`. Normalize all amounts to STEEM:
- If `type == "STEEM"`: `xferNormal = amount`.
- If `type == "SBD"`: `xferNormal = amount × steemPerSbd`, where `steemPerSbd` is the **median** of the `quote/base` ratios from the `condenser_api.get_feed_history` price history (compute the median of all `quote_number / base_number` values; `quote`/`base` are strings like `"1.000 SBD"` / `"7.500 STEEM"`).

**Memo URL/path extraction (using the memo text):**
- Detect a "Steem path" — one of these formats:
  - Format 1: `/tag/@author/rest_of_path`
  - Format 2: `/@author/rest_of_path`
  - Format 3: `https://website/tag/@author/rest_of_path`
  - Format 4: `https://website/@author/rest_of_path`
  - Format 5: `@author/rest_of_path`
- Detect a plain URL — `http://`, `https://`, or `ftp://` followed by a domain, optional port, and optional path segments (e.g., `https://example.com/path?x=1`), matched as a whole whitespace-delimited word.
- Extract the **first** valid Steem path (stripped of any leading website portion — i.e., for formats 3/4 store just the path after the host) and the **first** valid URL found in the memo.

**Record stored for each accepted transfer:**
- `xferFrom`, `xferTo`, `xferMemo`, `xferType` (`"STEEM"` or `"SBD"`), `xferAmount`, `xferNormal` (normalized to STEEM), `blockNumber`, and (when present) `firstURL` and `firstSteemPath`.

---

## 4. Data Model Summary

### 4.1 Post candidate (`PostInfo`)
```
author             : string
permlink           : string
nullBenWeight      : int        // 25% == 2500
blockNumber        : int        // block containing the comment_options op
title              : string     // cached/lazy
pendingPayout      : double     // from get_content result
netVotes           : int        // from get_content result
authorReputation   : double     // display reputation (~25-75+)
authorFollowers    : int
medianRepOfFollowers : double
steemURL           : string     // e.g. "/@author/permlink" (Steem-format url field)
```

### 4.2 Memo candidate (`XferMemoInfo`)
```
xferFrom     : string
xferTo       : string          // always "null" for pool members
xferMemo     : string
xferType     : string          // "STEEM" | "SBD"
xferAmount   : double
xferNormal   : double          // normalized to STEEM
blockNumber  : int
firstURL     : string | null   // first valid http(s)/ftp URL in memo
firstSteemPath : string | null // first valid Steem path in memo
```

---

## 5. Age Decay & Expiry (the Weighting Math)

Both pools apply the same half-life decay concept, but with different numeric types (posts use integer truncation; memos use floating point). **Reproduce this exactly.**

### 5.1 Post adjusted weight (`PostInfo.getAdjustedNullBenWeight`)

```
function adjustedNullBenWeight(post, currentBlockNumber, HALFLIFE_BLOCKS):
    adjusted = post.nullBenWeight                 // int
    timeFactor = currentBlockNumber - post.blockNumber
    while timeFactor > HALFLIFE_BLOCKS:
        timeFactor -= HALFLIFE_BLOCKS
        adjusted = floor(adjusted / 2)            // integer division, NOT rounding
    return adjusted
```

### 5.2 Memo adjusted weight (`XferMemoInfo.getAdjustedPromoWeight`)

```
function adjustedPromoWeight(memo, currentBlockNumber, HALFLIFE_BLOCKS):
    adjusted = memo.xferNormal                    // double
    timeFactor = currentBlockNumber - memo.blockNumber
    while timeFactor > HALFLIFE_BLOCKS:
        timeFactor -= HALFLIFE_BLOCKS
        adjusted = adjusted / 2.0                 // floating-point division
    return adjusted
```

### 5.3 Expiry (trimming)

On every refresh cycle (see §7), before selecting an item:

```
function trimPosts(pool, currentBlockNumber, MAXLIFE_BLOCKS):
    for each item in pool:
        if (currentBlockNumber - item.blockNumber) > MAXLIFE_BLOCKS:
            remove item from pool
```

This applies identically to both pools. (Note: strictly `>` — an item exactly `MAXLIFE_BLOCKS` old survives.)

---

## 6. Display-Type Selection (`Steemometer.updateDashLabels`)

Each refresh cycle, pick which kind of content to show:

```
numTypes = 3
vaasType  = random.nextInt(numTypes)   // uniform 0, 1, or 2
checkType = vaasType

OUTER_LOOP for lcv in 0 ..< numTypes:
    switch checkType:
        case 0:                              // beneficiary post
            if postPool.size != 0:
                vaasType = checkType
                break OUTER_LOOP
            else:
                checkType = checkType + 1
            break
        case 1:
        case 2:                              // promo memo (both map to Pool B)
            if memoPool.size != 0:
                vaasType = checkType
                break OUTER_LOOP
            else:
                checkType = checkType + 1
            break
        default:
            break
    if checkType == numTypes:
        checkType = 0                        // wrap around
```

**Interpretation:**
- Type `0` = a null-beneficiary post (Pool A).
- Types `1` and `2` = a promotional memo (Pool B). Both 1 and 2 render the same content — the distinction is only in the random draw; the switch statement in the display code treats cases 1 and 2 identically.
- If the randomly drawn type's pool is empty, the algorithm advances to the next type (`0→1→2`, wrapping `2→0`) and takes the first type whose pool is non-empty.
- If all three passes find empty pools, `vaasType` keeps whatever value it ends with, and nothing is displayed this cycle (both holders are hidden).

---

## 7. Display Refresh Cadence (30-Block Cycle)

The following runs inside the every-block update (or every N seconds, in a timer):

```
if currentBlockNumber % VAAS_INTERVAL == 1:            // e.g. block ≡ 1 (mod 30)
    // ALWAYS: trim both pools of expired items
    trimPosts(postPool, currentBlockNumber)            // §5.3
    trimMemos(memoPool, currentBlockNumber)            // §5.3

    switch vaasType:                                   // type selected by §6
        case 0:  showRandomBeneficiaryPost()           // §8.1
        case 1:
        case 2:  showRandomPromoMemo()                 // §8.2
        default: break

else if currentBlockNumber % VAAS_INTERVAL == 2:       // e.g. block ≡ 2 (mod 30)
    changePost = true                                  // re-arm the latch
```

### The `changePost` latch

- `changePost` starts as `true`.
- When a type-0/type-1/type-2 refresh runs, actual content replacement happens **only if `changePost == true`**, and then `changePost` is set to `false`.
- The latch is re-armed at `currentBlockNumber % 30 == 2`.
- **Purpose:** the 3-second timing is approximate; if the blockchain temporarily slows (two polls return the same block number), this prevents the same block window from re-triggering a content change multiple times.
- In effect: content changes once per 30-block window, during the window whose block number is ≡ 1 (mod 30).

---

## 8. Weighted Random Item Selection

### 8.1 Beneficiary post selection (`PostDisplayManager.getRandomPost`)

```
function getRandomPost(postPool, currentBlockNumber, HALFLIFE_BLOCKS):
    if postPool is empty:
        return null                        // no posts available

    totalWeight = 0
    for each post in postPool:
        totalWeight += adjustedNullBenWeight(post, currentBlockNumber, HALFLIFE_BLOCKS)

    randomValue = random.nextInt(totalWeight + 1)   // inclusive of totalWeight
                                                     // → range [0, totalWeight]
    postIndex = 0
    while randomValue > 0 and postIndex < postPool.size:
        post = postPool[postIndex]
        postIndex += 1
        randomValue -= adjustedNullBenWeight(post, currentBlockNumber, HALFLIFE_BLOCKS)

    return postPool[postIndex - 1]         // the post where iteration stopped
```

Notes:
- **Integer arithmetic.** `randomValue` is an int; weights are ints.
- The comment in the source notes this as a weighted random selection where a post's weight reflects its (currently adjusted) null beneficiary weight, and older posts are less likely to be shown.
- A brand-new `Random()` instance is created per call.

### 8.2 Promo memo selection (`XferMemoManager.getRandomMemo`)

```
function getRandomMemo(memoPool, currentBlockNumber, HALFLIFE_BLOCKS):
    if memoPool is empty:
        return null                        // no memos available

    totalWeight = 0.0
    for each memo in memoPool:
        totalWeight += adjustedPromoWeight(memo, currentBlockNumber, HALFLIFE_BLOCKS)

    randomValue = random.nextDouble() * totalWeight   // float in [0, totalWeight)
    memoIndex = 0
    while randomValue > 0.0 and memoIndex < memoPool.size:
        memo = memoPool[memoIndex]
        memoIndex += 1
        randomValue -= adjustedPromoWeight(memo, currentBlockNumber, HALFLIFE_BLOCKS)

    return memoPool[memoIndex - 1]         // the memo where iteration stopped
```

Notes:
- **Floating-point arithmetic** (`nextDouble`), unlike the post selection.
- A brand-new `Random()` instance is created per call.

---

## 9. What Gets Displayed for Each Type

### 9.1 Type 0 — Beneficiary post display

When a random post is selected and `changePost` is true:

1. **Fetch post metadata** via `condenser_api.get_content` with params `[author, permlink]`. Retry up to 5 times if the call returns null. Extract:
   - `title` → shown in the scrolling ticker. **If `title` is blank** (which is the case for replies/comments), also read `root_author` and `root_title`, and show the scrolling text as a reply to the parent post: `Re: @<root_author>: <root_title>`. Only fall back to `(untitled)` if there is no usable title **and** no `root_title`.
   - `pending_payout_value` (numeric part of e.g. `"12.345 SBD"`) → pending payout.
   - `net_votes` (int) → net votes.
   - `url` field (e.g. `"/@author/permlink"`) → the Steem URL used for the click-through link.
2. **Fetch author reputation** via `condenser_api.get_account_reputations` (params `[author, 1]`), converted to display reputation via `repLog10` (§10.2).
3. **Fetch follower count** via `follow_api.get_follow_count` (params `[author]`).
4. **Fetch median follower reputation** and follower count via `follow_api.get_followers` (params `{account, type:"blog", limit:1000}`, paginated) — median of follower reputations (§10.3).
5. **Null fraction label:** `nullWeight = nullBenWeight / 100.0` (so 2500 → 25.0) — displayed as the `@null%` value.
6. **Border color (heat scale)** — based on `colorIndex = floor(nullWeight / 10)`:

   | `colorIndex` | Color |
   |---|---|
   | 0–1 | Cool (reddish-orange) `rgb(255,100,0)` |
   | 2–4 | Warm (orange) `rgb(255,128,64)` |
   | 5–7 | Warmer (yellow-orange) `rgb(253,152,0)` |
   | 8–9 | Hot (turquoise) `rgb(0,253,228)` |
   | 10 | Hottest (light blue) `rgb(50,132,255)` |
   | else | black |

   The source expresses the stroke/fill opacity as `0.5 + (5 * colorIndex) / 100` for colorIndex 0–7 and 9–10, and `0.25 + (5 * colorIndex) / 100` for colorIndex 8–9. NOTE: in Java, `(5 * colorIndex) / 100` is an **integer division** (5 × 10 = 50 max), so the term is always 0 and the alpha values in effect are `0.5` and `0.25` respectively — reproduce accordingly (0.5 for all indices except 8–9, which use 0.25). Stroke width = `2 + floor((1 + colorIndex) / 2)`.

7. Show the beneficiary post holder, hide the promo holder.
8. Start the scrolling title animation (scroll across the VAAS area over `VAAS_INTERVAL / 2` seconds, looping). The scrolling text is the post `title`; for a blank title it is `Re: @<root_author>: <root_title>` (see step 1).
9. Click-through target: `webUrl = urlLeft + post.steemURL` (e.g. `https://steemit.com` + `/@author/permlink`).

### 9.2 Types 1 & 2 — Promo memo display

When `changePost` is true and the memo pool is non-empty:

1. Select a random memo (§8.2).
2. **Total promo amount:** sum `xferNormal` for **all** memos in the pool with the same `(xferFrom, xferMemo)` pair as the selected memo. This total is the displayed "Promo:" amount (a sender can split one message across multiple transfers; the display accumulates them).
3. **Branch on whether the memo contains a valid Steem path:**

   **(a) Memo has a Steem path → post promotion:**
   - Parse the referenced post: extract `author` and `permlink` from the path (format `@author/permlink` or `/tag/@author/permlink` → author/permlink; strip any leading `/` or website host).
   - Fetch metadata as in §9.1 (title, pending payout, net votes, URL).
   - Fetch author reputation, follower count, and median follower reputation.
   - Display: heading `"Promo: <totalNormalizedAmount>"`, the post author, reputation, follower count, median follower rep, pending payout, net votes, and the scrolling **post title** (not the transfer memo). If the post title is blank, use `Re: @<root_author>: <root_title>` (same rule as §9.1). If the post metadata fetch fails, fall back to the author handle (e.g. `@author`).
   - Click-through: the **memo's extracted Steem path** (not the fetched post's `url` field), prefixed with `urlLeft` and ensuring a leading `/` (e.g. `steemPath = "@author/permlink"` → `urlLeft + "/@author/permlink"`).

   **(b) Memo has no Steem path → vanity message:**
   - Display: heading `"{from} says:"`, scrolling text = the memo text.
   - Clear all post-detail fields (author, rep, followers, payout, votes).
   - Click-through (this branch only; no Steem path exists in the memo):
     1. If the memo contains a URL (`firstURL` non-null) → that URL.
     2. Else → the sender's profile page: `urlLeft + "/@" + from`.
   - (Overall click-through priority across both branches: memo Steem path → post URL; then memo URL; then sender profile.)
4. **Border color (heat scale)** — based on the total promo `burnAmount` (= total normalized amount for the `(from, memo)` pair):

   | Condition | `colorIndex` |
   |---|---|
   | `burnAmount < 0.001` | 0 |
   | `burnAmount < 0.1` | 2 |
   | `burnAmount < 10` | 5 |
   | `burnAmount < 100` | 8 |
   | else | 10 |

   Then the same color table as §9.1.
5. Hide the beneficiary post holder; show the promo holder.

---

## 10. Supporting Lookups (re-implement as needed)

### 10.1 Author reputation — `condenser_api.get_account_reputations`
```
POST {node}
Body: {"jsonrpc":"2.0","method":"condenser_api.get_account_reputations",
       "params":[<author>, 1], "id":1}
```
Response `result` is an array; take `result[0].reputation` (a string like `"1234567890123456789"`).

### 10.2 Display reputation conversion — Steem `reputation` → display score

```
function repLog10(repStr):
    if repStr == "0":
        return 25.0
    sign = (repStr starts with "-") ? -1 : 1
    if sign == -1:
        repStr = repStr without leading "-"

    // log10(repStr): compute using the first 4 digits for the mantissa
    leadingDigits = int(repStr[0..min(4, len)])
    log = log10(leadingDigits) + 0.00000001
    n = len(repStr) - 1
    logValue = n + (log - floor(log))

    out = max(logValue - 9, 0) * sign
    out = out * 9 + 25
    return round(out, 2)            // HALF_UP rounding, 2 decimal places
```

### 10.3 Follower count — `follow_api.get_follow_count`
```
POST {node}
Body: {"jsonrpc":"2.0","method":"follow_api.get_follow_count",
       "params":[<author>], "id":1}
```
Response: `result.follower_count` (int).

### 10.4 Median follower reputation — `follow_api.get_followers` (paginated)
```
POST {node}
Body: {"jsonrpc":"2.0","method":"follow_api.get_followers",
       "params":{"account":"<author>","start":<null or last follower>,"type":"blog","limit":1000},
       "id":1}
```
- Start with `start: null`; after each page, set `start` to the **last follower** in the page (`result[last].follower`).
- Each result entry has a `reputation` field (int/string — use the raw reputation value in the median; NOTE: the original code uses the raw integer reputation here, **not** the `repLog10`-converted value — see source `MedianCalculator`).
- Collect follower reputations in a list, then compute the median:
  - Odd size → middle element.
  - Even size > 0 → average of the two middle elements.
  - Empty list → `24.99` (deliberately below the 25 threshold).
- Return `[median, listLength]`. The `listLength` (count of followers actually read, in batches of 1000) is used as the author's follower count in some code paths; the separate `follow_api.get_follow_count` call is the authoritative follower count used in the display.

### 10.5 STEEM/SBD feed ratio — `condenser_api.get_feed_history`
```
POST {node}
Body: {"jsonrpc":"2.0","method":"condenser_api.get_feed_history","params":[],"id":1}
```
From `result.price_history[]`, for each entry with string `quote`/`base` fields (e.g. `"1.000 SBD"` / `"7.500 STEEM"`), compute `ratio = quoteNumber / baseNumber`. Take the **median** of all ratios → `steemPerSbd`.

---

## 11. Edge Cases & Implementation Notes

1. **Empty pools:** never select from an empty pool; the type-fallback loop (§6) handles this by advancing to another type. If all pools are empty, display nothing.
2. **Blank memo → rejected:** transfers to `null` with blank memos are never added to Pool B.
3. **Zero/negative weights:** a post's adjusted weight can decay to `0` (integer division). Such posts still occupy list slots until expiry, but contribute 0 weight. Since `random.nextInt(totalWeight + 1)` includes `totalWeight` in the range, and the walk only continues while `randomValue > 0`, a post with weight 0 can be returned when `randomValue == 0` — preserve this boundary behavior if exact parity matters.
4. **Random instance:** the original code creates a new `Random()` per selection call. Reproduce if exact behavioral parity is required (this differs from seeding once and reusing).
5. **5 retries** on post-metadata fetch failure.
6. **API failure handling:** if a poll fails, the app flags an invalid poll and retries; candidate-pool changes only occur on successful block reads.
7. **`changePost` latch:** content replacement happens only when `changePost` is true (§7). After replacing content, set it to false. Re-arm at `% 30 == 2`.
8. **Median follower rep default:** empty follower list → `24.99` (below the 35 gate → such authors won't enter Pool A).
9. **Type-1 vs type-2:** both render promo memos; there is no behavioral difference. Keep the two values distinct in the random draw (so memos effectively get twice the draw probability of beneficiary posts when both pools are non-empty).
10. **SBD/STEEM ticker:** `amount` strings split on whitespace — `"12.345 STEEM".split(" ")[0]` → `12.345`, `[1]` → `"STEEM"`.
11. **Exact boundary comparisons:** gates use strict `>` (rep `> 45.0`, followers `> 20`, median follower rep `> 35.0`). Expiry uses `>` (older than `maxlifeBlocks`).

---

## 12. Complete Reference Pseudocode

Consolidated, language-agnostic pseudo-code for the whole selection + display pipeline:

```
# ------------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------------
VAAS_INTERVAL     = 30        # blocks between content refresh
HALFLIFE_BLOCKS   = 1200      # weight halves this often
MAXLIFE_BLOCKS    = 28800     # item expiry
MINREP            = 45.0
MIN_FOLLOWERS     = 20
MIN_MED_FOLLOWER_REP = 35.0

postPool = []                 # Pool A
memoPool = []                 # Pool B
changePost = true

# ------------------------------------------------------------------
# ON EACH NEW BLOCK (currentBlockNumber):
#   1. scan ops (add to pools — see COLLECT below)
#   2. run display cycle
# ------------------------------------------------------------------

# ------------------------------------------------------------------
# COLLECT (during block scan)
# ------------------------------------------------------------------
for each op in block.ops:
    if op.name == "comment_options":
        nullWeight = find_null_beneficiary_weight(op.data)   # -1 if none
        if nullWeight != -1:
            rep  = fetch_author_reputation(op.data.author)
            fol  = fetch_follower_count(op.data.author)
            med  = fetch_median_follower_reputation(op.data.author)
            if rep > MINREP and fol > MIN_FOLLOWERS and med > MIN_MED_FOLLOWER_REP:
                postPool.add(Post(author=op.data.author,
                                  permlink=op.data.permlink,
                                  nullBenWeight=nullWeight,
                                  blockNumber=currentBlockNumber))

    else if op.name == "transfer" and op.data.to == "null" and op.data.memo.trim() != "":
        [amount, type] = split(op.data.amount)               # "12.345 STEEM" → 12.345, "STEEM"
        normal = (type == "SBD") ? amount * steemPerSbdMedian : amount
        memoPool.add(Memo(from=op.data.from, to="null", memo=op.data.memo,
                          type=type, amount=amount, xferNormal=normal,
                          blockNumber=currentBlockNumber,
                          firstURL=first_valid_url(memo),
                          firstSteemPath=first_valid_steem_path(memo)))

# ------------------------------------------------------------------
# DISPLAY CYCLE (once per block)
# ------------------------------------------------------------------
if currentBlockNumber % VAAS_INTERVAL == 1:
    trim(postPool)                                            # §5.3
    trim(memoPool)                                            # §5.3
    vaasType = select_type()                                  # §6
    switch vaasType:
        case 0: handle_beneficiary_post()
        case 1:
        case 2: handle_promo_memo()
        default: hide_all()
else if currentBlockNumber % VAAS_INTERVAL == 2:
    changePost = true

# ------------------------------------------------------------------
# select_type (returns 0, 1, or 2 with empty-pool fallback)
# ------------------------------------------------------------------
function select_type():
    numTypes = 3
    vaasType  = random(0, numTypes - 1)
    checkType = vaasType
    for lcv in 0..2:
        if checkType == 0 and postPool.size != 0:
            return checkType
        else if checkType in {1, 2} and memoPool.size != 0:
            return checkType
        # fall through: advance
        checkType += 1
        if checkType == numTypes:
            checkType = 0
    return vaasType                      # all pools empty; caller handles

# ------------------------------------------------------------------
# handle_beneficiary_post (type 0)
# ------------------------------------------------------------------
function handle_beneficiary_post():
    global changePost
    if not changePost:
        return
    changePost = false
    post = weighted_random_post()        # §8.1
    if post == null:
        hide_beneficiary_holder()
        return
    metadata = fetch_post_metadata(post) # title, root_author, root_title, payout, votes, url; retry ×5
    post.authorReputation   = fetch_author_reputation(post.author)
    post.authorFollowers    = fetch_follower_count(post.author)
    [post.medianRepOfFollowers, _] = fetch_median_follower_reputation_and_count(post.author)
    nullWeight = post.nullBenWeight / 100.0
    update_labels(post, nullWeight)
    show_beneficiary_holder(post)
    # scrolling text resolves to title, else "Re: @<root_author>: <root_title>" for blank
    # titles (replies), else "(untitled)"
    start_scroll_animation(resolve_title(post), VAAS_INTERVAL / 2)

# ------------------------------------------------------------------
# handle_promo_memo (types 1 and 2)
# ------------------------------------------------------------------
function handle_promo_memo():
    global changePost
    if not changePost:
        return
    changePost = false
    if memoPool is empty:
        return
    memo = weighted_random_memo()        # §8.2
    burnAmount = sum(xferNormal for m in memoPool
                     if m.xferFrom == memo.xferFrom and m.xferMemo == memo.xferMemo)
    if memo.firstSteemPath != null:
        [promoAuthor, promoPermlink] = parse_steem_path(memo.firstSteemPath)
        post = fetch_post_info(promoAuthor, promoPermlink)  # includes root_author/root_title
        post.authorReputation   = fetch_author_reputation(promoAuthor)
        post.authorFollowers    = fetch_follower_count(promoAuthor)
        [post.medianRepOfFollowers, _] = fetch_median_follower_reputation_and_count(promoAuthor)
        # display heading "Promo: <burnAmount>", post details, scrolling post title
        # click-through uses the memo's extracted Steem path (not post.steem_url)
        target_url = urlLeft + normalize_steem_path(memo.firstSteemPath)
    else:
        # vanity message: "{from} says: {memo}", cleared detail fields
        target_url = memo.firstURL
        if memo.firstURL == null:
            target_url = "/@" + memo.xferFrom
    color = heat_color(by_burn_amount(burnAmount))       # §9.2 step 4
    show_promo_holder(color, burnAmount, target_url, memo)
    if memo.firstSteemPath != null:
        scroll_text = resolve_title(post) if post else "@{promoAuthor}"   # title, else "Re: @<root_author>: <root_title>"
    else:
        scroll_text = memo.memo
    start_scroll_animation(scroll_text, VAAS_INTERVAL / 2)
```

---

## 13. Suggested Acceptance Checklist

To verify a re-implementation matches the original semantics:

- [ ] With an empty Pool A and non-empty Pool B, a draw of type 0 falls back to type 1/2 (promo shown).
- [ ] With non-empty Pool A and empty Pool B, a draw of types 1/2 falls back to type 0.
- [ ] With both pools empty, nothing is displayed and no exception is thrown.
- [ ] A post with `nullBenWeight = 2500` and `blockDistance = 2400` has adjusted weight `1250` (one halving: 2500 → 1250). Halving occurs only while the remaining gap strictly exceeds `halflifeBlocks`; at a gap of 2400, the second subtraction leaves 1200 which is not `> 1200`, so only one halving occurs.
- [ ] A post with `nullBenWeight = 2500` and `blockDistance = 3600` has adjusted weight `625` (two halvings: 2500 → 1250 → 625).
- [ ] A memo with `xferNormal = 0.8` and `blockDistance = 2400` has adjusted weight `0.4` (one halving).
- [ ] A memo with `xferNormal = 0.8` and `blockDistance = 3600` has adjusted weight `0.2` (two halvings).
- [ ] An item with `blockDistance == MAXLIFE_BLOCKS` survives; `blockDistance > MAXLIFE_BLOCKS` is removed.
- [ ] Weighted selection: over many draws, the post with the largest adjusted weight is selected most often.
- [ ] Content changes once per 30-block window (block ≡ 1 mod 30), and no content change occurs at block ≡ 2 mod 30 (only the latch re-arms).
- [ ] SBD transfer of 0.5 SBD with `steemPerSbd = 7.5` yields `xferNormal = 3.75`.
- [ ] Blank-memo transfers to `null` never enter Pool B.
- [ ] A memo with a Steem path renders as a post promo with accumulated Promo amount and the **post title** as scrolling text (not the memo); a memo without a path renders as `"{from} says: {memo}"` with the memo as scrolling text.
- [ ] A selected post with a **blank `title`** (a reply/comment) displays its scrolling text as `Re: @<root_author>: <root_title>` instead of an empty/`(untitled)` string; this applies to both beneficiary posts and promoted posts.
