import { defineConfig } from "vite";
const repo = "https://github.com/vitaliiznak/tab-lab";
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        home: "index.html",
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
          const page = /\/(cuda|rust)(?:\/|$)/.exec(ctx.path)?.[1] || "home";
          const base = page === "home" ? "./" : "../";
          function nav(label, key, href) {
            return (
              "<a " +
              (key === page ? 'aria-current="page" ' : "") +
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
            nav("Overview", "home", "") +
            nav("CUDA", "cuda", "cuda/") +
            nav("Rust", "rust", "rust/") +
            '</nav><a class="source" href="' +
            repo +
            '">GitHub <span aria-hidden="true">↗</span></a></div></header>';
          const footer =
            '<footer><a href="https://signumspace.net">Signumspace</a><span>Linux in a tab</span><a href="' +
            base +
            '#credits">Credits &amp; source</a></footer>';
          return html
            .replace("<!--NAV-->", navBar)
            .replace("<!--FOOT-->", footer);
        },
      },
    },
  ],
});
