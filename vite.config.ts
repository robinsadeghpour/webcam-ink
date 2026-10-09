import { defineConfig, type Plugin } from 'vite';

/**
 * The site has to work at a path with no trailing slash (/lab/ink), where
 * relative URLs would resolve one level too high. index.html fixes that with
 * a <base> set by an inline script, but browsers fetch the scripts and
 * stylesheets they can see in the markup before any script has run. So in
 * the built page those two tags are not in the markup: a second inline
 * script adds them once the base is in place.
 */
function lateEntryTags(): Plugin {
  return {
    name: 'late-entry-tags',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const tags = [...html.matchAll(/[ \t]*<(?:script type="module"|link rel="(?:stylesheet|modulepreload)")[^>]*(?:src|href)="(\.\/assets\/[^"]+)"[^>]*>(?:<\/script>)?\n?/g)];
        const scripts = tags.filter((t) => t[1].endsWith('.js') && t[0].includes('<script')).map((t) => t[1]);
        const styles = tags.filter((t) => t[1].endsWith('.css')).map((t) => t[1]);
        if (scripts.length !== 1 || styles.length !== 1) {
          throw new Error('late-entry-tags: expected one module script and one stylesheet in the built page');
        }
        let out = html;
        for (const tag of tags) out = out.replace(tag[0], '');
        const loader = [
          '    <script>',
          '      (function () {',
          "        var style = document.createElement('link');",
          "        style.rel = 'stylesheet';",
          `        style.href = ${JSON.stringify(styles[0])};`,
          '        document.head.appendChild(style);',
          "        var entry = document.createElement('script');",
          "        entry.type = 'module';",
          `        entry.src = ${JSON.stringify(scripts[0])};`,
          '        document.head.appendChild(entry);',
          '      })();',
          '    </script>',
          '',
        ].join('\n');
        return out.replace('  </head>', `${loader}  </head>`);
      },
    },
  };
}

// Relative base so the build works from any path.
export default defineConfig({
  base: './',
  plugins: [lateEntryTags()],
  server: { port: 5181, strictPort: true },
  build: { target: 'es2022' },
});
