import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const target = `http://localhost:${process.env.PORT || 4173}`;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Registered by hand in main.tsx. The plugin's automatic updates reload the page, and that
      // would stop someone's music or sharing.
      injectRegister: false,
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'PeerBeats',
        short_name: 'PeerBeats',
        description: 'Peer-to-peer music.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app's own files only. Music, keys and account data are never kept here.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/seeder\//, /^\/covers\//, /^\/socket\.io\//],
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': target, '/seeder': target, '/covers': target },
  },
});
