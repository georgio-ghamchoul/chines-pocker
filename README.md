# Chinese Poker — Online Multiplayer Card Game ♠♥

![Chinese Poker gameplay](https://github.com/user-attachments/assets/c2c26a04-30e9-4c25-a24f-e3f08050a761)

A real-time, 4-player online **Chinese Poker** game. One player creates a room,
shares a 4-letter code (or invite link), and everyone plays from their own phone
or computer — no accounts, no install. Empty your hand to win the round; first to
**101 points loses**, lowest score wins.

Built with **Node.js**, **Express**, and **Socket.IO**. The server is
authoritative — it holds every hand and validates every move — so the rules
can't be cheated from a modified client.

## Features

- 🌐 **Real-time multiplayer** — 4 players, live updates over WebSockets, reconnect to your seat.
- 🔑 **Simple rooms** — create a room, share a 4-letter code or invite link. No sign-up.
- 🤖 **Bots** — fill empty seats with computer players (play solo or with missing friends). Solid heuristic AI.
- 🪵 **Themes** — a classic wood table by default, plus a one-tap dark mode.
- 🔊 **Sound effects** — dealing, playing, passing, your turn, 1-card alerts, and wins (mutable).
- 💬 **Chat** — type-anything messages plus one-tap emoji/quick phrases, shown as bubbles by each seat.
- ⏱ **Turn timer** — the host can set a 10/20/30-second limit per turn (auto-pass on timeout).
- 🏆 **Scoreboard & 📊 lifetime stats** — current standings any time, plus matches/rounds won saved across games.
- 🃏 **Hands your way** — drag cards into up to 3 rows and arrange them however you like; drag onto the table to play.
- 📱 **Responsive** — designed to play well on both phones and desktop.

## How to play

1. Enter a name and **Create a room** (or join with a 4-letter code / invite link).
2. Add bots or wait for friends until all 4 seats are filled, then the host clicks **Start**.
3. Whoever holds **3♦** leads first and must include it.
4. Beat the current play with a higher combination, or **Pass**. Empty your hand to win the round.
5. Losers get penalty points based on cards left. The match ends when someone reaches **101** — **lowest score wins**.

## Run locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Then open <http://localhost:3000>. To play with people on the same Wi-Fi, share
`http://YOUR-LOCAL-IP:3000` (find it with `ipconfig` / `ifconfig`).

## Deploy for free (Render)

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Web Service**, connect the repo.
3. Build command `npm install`, start command `npm start`, instance type **Free**.
4. Open the public URL it gives you and share it.

The app reads the port from `process.env.PORT`, so no extra configuration is needed.

## Project structure

```
server.js            Authoritative Express + Socket.IO server (rooms, turns, scoring, bots, timer, chat, stats)
game/engine.js       Pure rules: cards, combinations, comparisons, scoring (no I/O)
game/bot.js          Bot AI (chooses moves from the rules engine)
game/*.test.js       Unit tests  ->  npm test
public/              The web client (index.html, style.css, client.js)
```

Run the tests with `npm test`.

## Tech

Node.js · Express · Socket.IO · vanilla HTML/CSS/JS · no database (state in memory, mirrored to disk).
