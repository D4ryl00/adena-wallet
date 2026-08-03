# GnoConnect in Adena — implementation log & handoff

Working notes for the GnoConnect implementation pass in `adena-wallet`.
Companion to `~/gnokey-mobile/GNOCONNECT_SPEC_REVIEW.md` (the spec-review
tracker), which this pass reopened one item in and added three to.

**Status as of 2026-07-30:** Adena side done and verified; spec corrections
drafted; nothing committed anywhere.

**Files under discussion (full paths):**

- **SPEC** = `~/gno-inpage-wallets/docs/resources/gnoconnect.md`, branch
  `feat/gnoconnect-in-page-wallets`. This is the fullest copy (external-wallets
  material *plus* the In-Page Wallets section) and the only one checked out —
  `~/gno` is on `master`, and the `~/gno-external-wallets` worktree the review doc
  references no longer exists. **Both halves of any spec edit have to land here.**
- **REVIEW** = `~/gnokey-mobile/GNOCONNECT_SPEC_REVIEW.md` — untracked (`??`), so
  it lives only on this machine.
- **ADENA** = this repo, branch `main`, base commit `29322478`. All work is
  uncommitted.

---

## 1. What was already there (don't re-derive this)

Adena implemented more of GnoConnect than it looks. Before touching anything:

| Piece | Where | State |
|---|---|---|
| `gnoconnect:rpc` / `gnoconnect:chainid` meta parsing | `src/inject/message/methods/gno-connect.ts:49` `parseGnoConnectInfo()` | Working. Scans **all** `<meta>` in the live DOM, not just `<head>`. |
| `$help&func=` TxLink parsing | was `parseGnoMessageInfo()` | **Removed.** The interceptor deletion took its last caller; a TxLink is a *page* URL, so gnoweb renders the form and the chooser calls the provider — an in-page wallet never parses one. |
| `vm/qdoc` realm-document lookup | `src/common/provider/gno/gno-provider.ts:463` `getRealmDocument()` | Working. `QUERY_DOCUMENT = 'vm/qdoc'` in `provider/gno/types.ts`. |
| Origin allowlist | `src/common/constants/gno-connect-allowlist.constant.ts` | Derived from `chains.json` `gnoUrl`. Remote https trusted statically; loopback needs a runtime chainId gate. |
| Network-must-match-active gate | `src/pages/popup/wallet/approve-transaction-main/index.tsx:200-213` `isRequestedNetworkReady` | **The important one.** Blocks document build (`:740`) and approve (`:706`) unless the requested `chainId`+`rpcUrl` equal the wallet's active network. |
| `gnoconnect:txdomains` | — | **Absent.** See §6. |
| HTTP headers | — | **Absent.** See §4. |
| Announce protocol (`gno:registerWallet`) | — | **Absent — this was the main gap.** |

Existing executor methods, which the new provider is built from (nothing new was
added to the wallet core): `addEstablish`, `doContract`, `getAccount`,
`getNetwork`, `signAmino`, `signTx`, `addNetwork`, `switchNetwork`, 4× multisig,
`cosmos.*`, `On(changedAccount|changedNetwork)`.

---

## 2. What was built

New module `packages/adena-extension/src/inject/gnoconnect/`:

| File | Role |
|---|---|
| `types.ts` | Standard's vocabulary only — `GnoWalletInfo`, `GnoTransactionIntent`, `UserResponse`, event-name and `rdns` constants. Deliberately free of Adena's `WalletResponse`. |
| `announce.ts` | The handshake. Announces on load *and* on every `gno:requestWallet`. Idempotent; takes an optional `EventTarget` (defaults `window`) purely so tests get isolation. |
| `provider.ts` | The announced surface. Thin adapters over `AdenaExecutor`. |
| `response.ts` | The **only** place the two vocabularies meet. See §3.2. |
| `tx-builder.ts` | Named args → declaration order via `vm/qdoc`. Extracted from the deleted `command-handler` path. |
| `icon.ts` | `public/icon/icon128.svg` as a `data:image/svg+xml;base64` URI. Regenerate with `base64 -i public/icon/icon128.svg \| tr -d '\n'` if the SVG changes. |
| `*.spec.ts` ×4 | 39 tests. See §5. |

Wired in at `src/inject.ts` (bottom): `announceGnoWallet()` after `init()`.
`window.adena` is **untouched** — the announcement is purely additive.

**Announced provider:** `signAndSubmitTransaction`, `signAndSubmitTransactions`
(multi-message), `connect`, `getAccount`, `getNetwork`, `switchNetwork`.

---

## 3. Decisions taken, and why

### 3.1 Announced surface derived from what already exists

Every announced method wraps an executor Adena already had, so nothing here can
sign without going through the existing approval popups.

- **`signMessage` deliberately omitted.** Adena's `Sign`/`signAmino` signs a
  *transaction document*, not an arbitrary message. Announcing it under the
  standard's name would mislead a page that feature-detects it.
- **`signTransaction` (sign-only) omitted for now** — not because Adena lacks it
  (`SignTx` works), but because it only became conformant *after* the spec change
  in §4.2. It is a small, safe follow-up: wrap `executor.signTx` and return
  `{ signedtx: data.encodedTransaction }`. Deferred so the encoding change lands
  in the spec first.
- **Multi-message announced**, because Adena does it natively via `DoContract`.
  This is REVIEW item #4's prediction realised: the standard's single-message
  baseline is a *subset* of Adena's capability, reachable in-page today with no
  spec change.

### 3.2 `UserResponse` mapping (`response.ts`)

The standard splits an unhappy outcome in two where Adena has one `failure`:

- User declined → `{status:'Rejected'}`, a **resolved** promise. Detected by
  membership in `WalletResponseRejectType` (code 4000).
- Anything else → **throws** `GnoConnectError`.
- `ALREADY_CONNECTED` and `REDUNDANT_CHANGE_REQUEST` → **Approved**. Adena calls
  them failures, but each is the state the caller asked for.

Mapping on the **reject-type enum**, not on `code`, is deliberate: when the SDK
grows a new failure type, it surfaces as a thrown error (a page's `catch` already
handles it) rather than a silent, wrong "the user said no".

### 3.3 Interceptors removed (user decision: "Interceptors + checkMetadata flow")

Deleted — the spec forbids a wallet cancelling the page's own events:

- `interceptors/anchor-interceptor.ts`, `interceptors/form-submit-interceptor.ts`
- `gno-interceptor-manager.ts`
- `CommandHandler.createContentHandler` + its `makeTransactionMessage`
- the `chrome.tabs.onUpdated` → `checkMetadata` trigger in `background.ts`
- the `checkMetadata` command key and `CheckMetadataMessageData`

**−631 lines.**

**Kept, and this is the one call worth re-reviewing:** `GnoWebEventWatcherInterceptor`
(+ `gno-connect-info-provider.ts`, `gno-web-event-watcher.ts`, the `gnoSessions`
machinery in `background.ts`). It *observes* gnoweb's own dispatched events
(`params:changed`, `mode:changed`, `address:changed`) and cancels nothing, which
is not what the spec forbids; it drives gno-session sync, unrelated to GnoConnect.
The chosen option's text named only anchor/form/manager/checkMetadata. It is now
registered directly from `content.ts` (`initGnoWebEventWatcher`) since the manager
is gone. **If this should also go, it's a contained follow-up.**

### 3.4 qdoc resolution runs in the page

`buildTransactionParams` constructs a `GnoProvider` and fetches the realm document
from the inpage world. This is the same CORS posture as before — the old flow did
the identical fetch from the content script, which in MV3 is also page-CORS-bound.
Not a regression.

### 3.5 Ledger declaration fix (unrelated, but blocking)

`yarn build` was **already broken on `main`** — confirmed by stashing. Two ambient
declarations of `ledger-cosmos-js` had drifted:

- `packages/adena-module/src/types/ledger-cosmos-js.d.ts` — has `return_code`
- `packages/adena-extension/src/types/ledger-cosmos-js/index.d.ts` — was missing it

Building from the extension, the nearer declaration shadows the other, so
`adena-module/src/ledger/ledger-app-utils.ts:35` failed to compile. Added the one
missing field. Outside the task's scope; flagged rather than hidden.

---

## 4. Spec corrections (drafted in SPEC, tracked in REVIEW)

### 4.1 HTTP headers — REVIEW item P3 #11 **reopened**

It was marked ☑ done as "header-wins, because a header can't be injected via page
content". The precedence rule is fine; the *rationale* was wrong:

- **Nobody emits or reads them.** gnoweb writes only the two meta tags
  (`~/gno-inpage-wallets/gno.land/pkg/gnoweb/components/layouts/head.html:47-48`);
  no `Gnoconnect-*` header exists anywhere in the gno tree; gnoweb's own client
  reads meta only (`frontend/js/controller-wallet-launch.ts:211-212`).
- **No named client *can* read them.** MV3 content scripts have no access to
  response headers → Adena structurally can't. **gnobro is not a wallet** — it's a
  terminal realm browser (`~/gno-inpage-wallets/contribs/gnobro`) that takes
  `-remote` and talks straight to a node's RPC; it never fetches an HTML page.
  Mobile wallets receive `rpc`/`chainid` as launch-link params, never from a page.
- **It guarded the wrong channel anyway.** A compromised page also emits the
  launch link, and a custom-scheme URL has no headers to overrule its `rpc`.

**Applied to SPEC:** headers reframed as a convenience for clients that *fetch*
the page; precedence kept but explicitly "a tiebreak, not a security boundary";
new subsection **"`rpc` and `chainid` are declarations, not authority"** stating
the mitigation that holds across every transport — the declared network must
already be user-configured, and must be shown in review. Adena already enforces
exactly this, which is what surfaced the gap.

### 4.2 `signedtx`: amino-JSON → **amino-binary**

SPEC said base64 amino-JSON. Every Adena broadcast path emits base64
**amino-binary** — `uint8ArrayToBase64(Tx.encode(signedTx).finish())` in
`adena-module/src/wallet/keyring/address-keyring.ts:56` (and the multisig / hd /
ledger keyrings) — handed straight to the RPC as `params: [tx]`
(`src/common/provider/gno/gno-provider.ts:363-368`).

So base64 amino-binary **is** the `broadcast_tx_sync` wire format: a producer
passes it through and needs no amino library. amino-JSON forces a
decode/re-encode, which is precisely the hazard SPEC's own §signtx already warns
about ("a client that cannot represent that signature will re-encode the
transaction into an invalid one"). Not hypothetical — Adena's `encodeGnoTx`
(`adena-module/src/proto/session/local-tx.ts:37-58`) emits a bespoke
`LocalTxSignature` carrying `session_addr` that standard `Tx.encode` does not
produce; a generic client round-tripping that through JSON drops the session field
and broadcasts an invalid tx.

**Applied to SPEC:** amino-binary + "a producer MUST treat `signedtx` as opaque
and broadcast it unmodified."

### 4.3 Named args imply a `vm/qdoc` lookup — was unstated

In-page `args: {name,value}[]` is named; a `MsgCall` is positional. Every wallet
must resolve declaration order via qdoc, and `rpc` is *optional*, so the lookup
had no declared endpoint. **Applied to SPEC §provider:** the requirement, the
`cur realm` exclusion, and a SHOULD to resolve against the network the wallet will
actually sign on.

---

## 5. Verification performed

```sh
cd packages/adena-extension
npx tsc --noEmit -p tsconfig.json     # clean
npx eslint 'src/inject/gnoconnect/**/*.ts'   # 0 errors (3 `any` warnings, repo-typical)
npx jest --ci src/inject/gnoconnect   # 39 passed / 4 suites
yarn test:ci                          # 640 passed; 32 failed
yarn build                            # succeeds
```

- **The 32 failures are pre-existing**, all in `src/migrates/**`, libsodium
  `invalid salt length` under jsdom. Confirmed identical on a stashed clean tree.
  Baseline before this work was 601 passing; the +39 are the new tests.
- **Bundle checked**, not just compiled: `dist/inject.js` contains
  `gno:registerWallet` and `land.gno.adena`; `dist/content.js` no longer contains
  the gnoweb interceptor selectors (`b-action-function`).
- `handshake.spec.ts` drives the **real page-side pattern** (listen → dispatch
  `gno:requestWallet` → receive announcement → call provider) through the **real**
  provider and executor, against a simulated content-script bridge. Covers:
  approved-with-hash, rejected, locked-throws, connect discloses the account only
  after establish is approved, connect-declined discloses nothing, multi-message,
  switchNetwork, unadded-network-throws.

**jsdom gotcha, cost ~20 min:** `window.postMessage` delivers `event.origin` as
`''`, which the executor's origin check discards. The repo's established
workaround is to spy on `postMessage` and dispatch a synthetic `MessageEvent` with
an explicit `origin` — see `setupPostMessageSpy` at
`src/inject/executor/executor-cosmos.spec.ts:37`.
`handshake.spec.ts` follows it, and additionally defers the reply by a tick
because the executor installs its resolver only *after* `postMessage` returns.

**Not done:** no real-browser run. Loading an unpacked extension needs manual
`chrome://extensions` interaction, which the browser tooling can't drive.

---

## 6. Open items / next steps

**Adena**

1. **`signTransaction` (sign-only)** — now conformant per §4.2; wrap
   `executor.signTx`, return `{ signedtx: data.encodedTransaction }`.
2. **Real-browser end-to-end** — load `dist/` unpacked, hit a gnoweb `$help` page,
   confirm the chooser sees Adena and a call lands on chain.
3. **Decide on `GnoWebEventWatcherInterceptor`** (§3.3).
4. **`gnoconnect:txdomains`** — deliberately not implemented; see below.
5. Ledger declaration fix (§3.5) probably wants to be its own commit/PR.

**Spec / cross-repo**

6. **gnokey-mobile + boards2 still emit/parse amino-JSON.** SPEC now says
   amino-binary. Same "one cheap moment before anything merges" argument REVIEW
   used for the `message`→`code` rename. **This is the highest-value follow-up** —
   spec and code are knowingly out of sync until it's done.
7. **`gnoconnect:txdomains` has no emitter.** gnoweb's `head.html` writes only
   `rpc` and `chainid`. Gating TxLink handling on it would degrade to same-origin
   in practice, so Adena's existing origin allowlist was left as the control.
   Either gnoweb starts emitting it, or SPEC should say what a receiver does when
   it's absent.
8. REVIEW's own still-open items are untouched by this pass: producer-side
   timeout in boards2, and `invalid_request` never being emitted.

---

## 7. Conventions worth keeping

- Tests colocate as `*.spec.ts` next to source; Jest 29 + jsdom.
- Specs that touch `@adena-wallet/sdk` must **mock it** — it pulls @web3auth's
  native crypto, which fails under jsdom. Pattern:
  `src/inject/message/methods/wallet.spec.ts:1-45`.
- Comments in the new module explain *why*, not *what*, and cite the standard's
  reasoning where a rule looks arbitrary (e.g. why the icon must be a data URI,
  why declining resolves rather than throws). Keep that if extending it.
