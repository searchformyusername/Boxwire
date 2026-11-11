# Boxwire

A browser whiteboard for system design, UML and ER diagrams. Draw, review architecture changes, and export boards, images or replay videos. Boards are saved in this browser; export a board file to back it up or move it elsewhere.

AI assistants and coding agents can write diagrams directly in Boxwire's JSON format. Share the [format guide](public/products/boxwire/llm.md) and [examples](public/products/boxwire/examples), then open the generated file or paste its JSON onto the board. You can also export a critique bundle for an AI to review and bring its suggestions back as a patch to preview before applying.

Use Node.js 22.12 or newer:

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. `npm run build` creates the static site in `dist`; `npm run preview` serves it locally. Static hosts need an SPA fallback to `index.html` for direct links to `/products/boxwire`.

Run `npm test` for the test suite. `npm run test:browser` also checks the app in Chrome (set `CHROME` if it is installed outside the default macOS path). With the dev server running, use `npm run test:storage -- http://localhost:5173` to check browser storage.
