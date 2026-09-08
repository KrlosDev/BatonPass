// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages serves a project repo from a subpath, so `base` has to match the
// repo name or every asset URL 404s once deployed while working fine locally.
// On a custom domain, set base back to '/'.
export default defineConfig({
  site: 'https://krlosdev.github.io',
  base: '/BatonPass',
  trailingSlash: 'ignore',
  build: {
    // The deploy is a plain static host, so emit real directories rather than
    // relying on the server to resolve extensionless URLs.
    format: 'directory',
  },
});
