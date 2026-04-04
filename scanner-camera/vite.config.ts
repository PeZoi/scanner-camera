import { defineConfig, loadEnv } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const pyBarcodePort = env.PY_BARCODE_PORT || '8765'

  return {
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
    proxy: {
      // Python: `python python-barcode-server/server.py` — cổng PY_BARCODE_PORT (mặc định 8765)
      '/ws/pybarcode': {
        target: `ws://127.0.0.1:${pyBarcodePort}`,
        ws: true,
        changeOrigin: true,
        rewrite: () => '/',
      },
    },
  },
}
})
