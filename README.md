# Codenames

A local, peer-to-peer implementation of the word game **Codenames**. One player
**hosts** the game in their browser; everyone else **joins** with a short room
code from their own phone or laptop on the same network. There is **no backend** —
all game logic and authoritative state live in the host's browser tab, and
players talk directly to the host over WebRTC.

It is a purely static site (HTML / CSS / vanilla JS ES modules), installable as a
PWA, and deployable to GitHub Pages.

## Features

- **Host on one device, join on many.** Star topology over WebRTC (PeerJS).
- **Seamless reconnect.** Drop your Wi-Fi, reload, or background the tab — you
  rejoin the same seat (team, role, and the Spymaster's private key) with no
  re-picking. The host can reload too without destroying the game.
- **Zero-flicker board.** The 5×5 grid is built once; state updates surgically
  patch only the cards that changed.
- **Private key card.** The map of which word belongs to which team is sent
  **only** to the two Spymasters — never to Operatives, not even hidden in the DOM.
- **Installable & offline-capable shell** via service worker + web app manifest.

## Play

- **Teams:** Red and Blue. Each needs exactly one **Spymaster** and at least one
  **Operative**. 4+ players recommended.
- **Board:** 25 words. The key assigns **9 / 8 / 7 / 1** — first team's agents,
  second team's agents, neutral bystanders, and one assassin. The team with 9
  goes first.
- **Turn:** the active Spymaster gives a one-word clue + a number; their
  Operatives may make up to *(number + 1)* guesses. A clue of **0** or **∞**
  grants unlimited guesses that turn.
  - Own agent → keep guessing. Neutral or enemy agent → turn passes.
    **Assassin → instant loss.**
- **Win:** reveal all your team's agents (or the other team hits the assassin).

## Regenerating the icons

The PWA icons are generated with a tiny dependency-free Node script:

```bash
node tools/gen-icons.mjs
```

## Project layout

```
index.html              all screens (home / join / lobby / game)
manifest.webmanifest    PWA manifest (relative start_url, dark theme)
sw.js                   service worker (precache app shell, cache-first)
css/styles.css          minimalist dark, mobile-first styling
js/
  config.js             ALL tunable constants: rules, broker, palette, keys
  words.js              bundled word list (original ~570 common nouns)
  rules.js              game rules + authoritative state machine + view derivation
  net.js                PeerJS transport: host/client, reconnect-by-token
  render.js             the only DOM patcher: applyState(prev, next), no flicker
  ui.js                 screens, toasts, network banner, clipboard
  storage.js            localStorage: name / seat token / host snapshot
  main.js               app entry: wires net + UI + persistence
icons/                  icon.svg + generated PNGs
tools/gen-icons.mjs     zero-dependency PNG icon generator
```

## Modules of note

- **`net.js`** is the networking module: a documented broker config constant
  with offline-LAN notes, host-authoritative validation, reconnect-by-token with
  backoff, a grace timer for dropped players, and host-reload safety.
- **`render.js`** contains the single `applyState(prev, next)` function — the
  only code permitted to mutate the board DOM — plus the rAF-coalesced render
  pipeline that keeps the game screen from ever flickering.
