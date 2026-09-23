// Tudo que precisa aparecer na tela do device real. Nada de console: no iPhone
// sem Mac ao lado, console é invisível.

export type Diagnostico = {
  userAgent: string
  plataforma: string
  secureContext: boolean
  origem: string
  temMediaDevices: boolean
  temGetUserMedia: boolean
  temGetUserMediaLegado: boolean
  temCreateImageBitmap: boolean
  temOffscreenCanvas: boolean
  temIndexedDB: boolean
  temRandomUUID: boolean
  standaloneIOS: boolean
  displayMode: string
  devicePixelRatio: number
  telaCss: string
}

export function coletarDiagnostico(): Diagnostico {
  const nav = navigator as Navigator & {
    standalone?: boolean
    getUserMedia?: unknown
    webkitGetUserMedia?: unknown
  }

  return {
    userAgent: navigator.userAgent,
    plataforma: navigator.platform ?? '(sem navigator.platform)',
    secureContext: window.isSecureContext,
    origem: window.location.origin,
    temMediaDevices: typeof navigator.mediaDevices !== 'undefined',
    temGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
    temGetUserMediaLegado:
      typeof nav.getUserMedia === 'function' || typeof nav.webkitGetUserMedia === 'function',
    temCreateImageBitmap: typeof createImageBitmap === 'function',
    temOffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    temIndexedDB: typeof indexedDB !== 'undefined',
    temRandomUUID: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function',
    standaloneIOS: nav.standalone === true,
    displayMode: ['standalone', 'fullscreen', 'minimal-ui', 'browser']
      .find((modo) => window.matchMedia(`(display-mode: ${modo})`).matches) ?? 'indeterminado',
    devicePixelRatio: window.devicePixelRatio,
    telaCss: `${window.screen.width}×${window.screen.height}`,
  }
}

/**
 * Descobre se o `canvas.toBlob` deste navegador realmente produz WebP, ou se
 * ignora o pedido em silêncio e devolve PNG. Safari antigo faz exatamente isso.
 */
export async function sondarSuporteWebp(): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  const ctx = canvas.getContext('2d')
  if (ctx === null) return 'sem contexto 2d'
  ctx.fillStyle = '#c1121f'
  ctx.fillRect(0, 0, 2, 2)

  const blob = await new Promise<Blob | null>((resolver) => {
    canvas.toBlob(resolver, 'image/webp', 0.8)
  })

  if (blob === null) return 'toBlob devolveu null'
  return blob.type === 'image/webp' ? 'sim (image/webp)' : `NÃO — devolveu ${blob.type}`
}
