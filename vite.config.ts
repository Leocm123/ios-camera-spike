import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// A câmera exige secure context, então o iPhone precisa chegar aqui por HTTPS.
// Há dois jeitos, e o modo escolhe entre eles:
//
//   npm run dev         → HTTPS local com certificado autoassinado (rota LAN)
//   npm run dev:tunel   → HTTP puro, para um túnel pôr o HTTPS confiável na frente
const DOMINIOS_DE_TUNEL = ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.io', '.loca.lt', '.ts.net']

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'tunel' ? [] : [basicSsl()])],
  server: {
    host: true,
    port: 5273,
    // O Vite recusa Host desconhecido (proteção contra DNS rebinding) e a URL do
    // túnel é sorteada a cada execução. Libera os domínios, não qualquer host.
    ...(mode === 'tunel' ? { allowedHosts: DOMINIOS_DE_TUNEL } : {}),
  },
}))
