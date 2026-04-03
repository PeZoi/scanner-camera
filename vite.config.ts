import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  optimizeDeps: {
    /** Giảm lỗi "Importing a module script failed" khi Vite pre-bundle đổi (HMR reload). */
    include: ['@zxing/browser', '@zxing/library', 'scanbot-web-sdk', 'scanbot-web-sdk/ui'],
  },
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss()
  ],
  server: {
    // Tunnels (ngrok, etc.): Host header is not localhost
    allowedHosts: true,
  },
})
