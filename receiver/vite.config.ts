import { defineConfig, type Plugin } from "vite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function precacheSwPlugin(): Plugin {
  return {
    name: "airbridge-precache-sw",
    closeBundle() {
      const distDir = resolve(__dirname, "dist");
      const assetsDir = resolve(distDir, "assets");
      const swPath = resolve(distDir, "sw.js");
      try {
        const assetUrls = readdirSync(assetsDir).map((f) => `./assets/${f}`);
        const urls = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", ...assetUrls];
        const sw = readFileSync(swPath, "utf-8").replace(
          '["__PRECACHE_URLS__"]',
          JSON.stringify(urls),
        );
        writeFileSync(swPath, sw, "utf-8");
      } catch {
        // Ignore in dev mode
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [precacheSwPlugin()],
  build: {
    outDir: "dist",
    target: "es2022",
    assetsInlineLimit: 4096,
  },
  worker: {
    format: "es",
  },
});
