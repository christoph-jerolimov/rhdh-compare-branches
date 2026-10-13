// @ts-check
import { defineConfig } from 'astro/config';

// SITE and BASE_PATH are provided by the GitHub Pages workflow
// (actions/configure-pages). Locally the site is served from "/".
const site = process.env.SITE || 'http://localhost:4321';
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
});
