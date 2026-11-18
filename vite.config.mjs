import { defineConfig } from "vite";
const repo = "https://github.com/vitaliiznak/tab-lab";
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        home: "index.html",
        data: "data/index.html",
        cuda: "cuda/index.html",
        rust: "rust/index.html",
      },
    },
  },
  plugins: [
    {
      name: "lab-shell",
      transformIndexHtml: {
        order: "pre",
        handler(html, ctx) {
          const page = /\/(cuda|rust|data)(?:\/|$)/.exec(ctx.path)?.[1] || "home";
          const base = page === "home" ? "./" : "../";
          function nav(label, key, href) {
            return (
              "<a " +
              (key === (page === "home" ? "cuda" : page) ? 'aria-current="page" ' : "") +
              'href="' +
              base +
              href +
              '">' +
              label +
              "</a>"
            );
          }
          const navBar =
            '<header class="top"><div class="sitebar"><a class="brand" href="' +
            base +
            '"><span class="mark" aria-hidden="true">›<i>_</i></span>tab<span class="slash">/</span>lab</a><nav aria-label="Main">' +
            nav("CUDA", "cuda", "") +
            nav("Rust", "rust", "rust/") +
            nav("DuckDB", "data", "data/") +
            '</nav><a class="source" href="' +
            repo +
            '">GitHub <span aria-hidden="true">↗</span></a></div></header>';
          const guestPanel = `
            <section class="guest-check" aria-label="Linux guest inspection">
              <div class="guest-bar">
                <div><strong>Isolated Linux guest</strong><span>On your device · guest networking disabled</span></div>
                <button id="inspect-guest" type="button" aria-controls="guest-proof" disabled>Inspect this guest</button>
              </div>
              <pre id="guest-proof" aria-live="polite" tabindex="-1" hidden></pre>
              <div id="guest-compare" class="guest-compare" hidden>
                <span>This guest has a marker in /tmp. Open a second tab and look for it there.</span>
                <a href="?inspect=compare" target="_blank" rel="noopener">Compare in a new tab ↗</a>
              </div>
            </section>`;
          const footer =
            '<footer><a href="https://signumspace.net">Signumspace</a><span>Linux in a tab</span><a href="' +
            base +
            '#credits">Credits &amp; source</a></footer>';
          return html
            .replace("<!--NAV-->", navBar)
            .replace("<!--GUEST-->", guestPanel)
            .replace("<!--FOOT-->", footer);
        },
      },
    },
  ],
});
