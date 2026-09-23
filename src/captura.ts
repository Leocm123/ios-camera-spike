// Pipeline de captura: decodificar → orientar → recortar 1:1 → codificar.
//
// O recorte acontece aqui, no ato da captura, num único `drawImage` que já
// combina a matriz de orientação EXIF com a janela quadrada central. Nada é
// guardado em formato retangular para ser recortado depois.

import { trocaEixos, type LeituraExif } from './exif'

/** Lado máximo do quadrado final. 1080 cobre uma foto em largura cheia numa tela @3x. */
export const LADO_MAX = 1080

export type Decodificada = {
  imagem: ImageBitmap | HTMLImageElement
  largura: number
  altura: number
  /** Qual caminho de decodificação funcionou de verdade neste device. */
  caminho: string
  /** Tentativas que falharam antes de chegar no caminho que funcionou. */
  avisos: string[]
  liberar: () => void
}

export async function decodificar(arquivo: Blob): Promise<Decodificada> {
  const avisos: string[] = []

  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(arquivo, { imageOrientation: 'from-image' })
      return {
        imagem: bitmap,
        largura: bitmap.width,
        altura: bitmap.height,
        caminho: "createImageBitmap(imageOrientation: 'from-image')",
        avisos,
        liberar: () => bitmap.close(),
      }
    } catch (e) {
      avisos.push(`createImageBitmap com from-image falhou: ${descreverErro(e)}`)
    }

    try {
      const bitmap = await createImageBitmap(arquivo)
      return {
        imagem: bitmap,
        largura: bitmap.width,
        altura: bitmap.height,
        caminho: 'createImageBitmap(sem opções)',
        avisos,
        liberar: () => bitmap.close(),
      }
    } catch (e) {
      avisos.push(`createImageBitmap sem opções falhou: ${descreverErro(e)}`)
    }
  } else {
    avisos.push('createImageBitmap não existe neste navegador.')
  }

  const url = URL.createObjectURL(arquivo)
  const img = new Image()
  img.src = url
  await img.decode()
  return {
    imagem: img,
    largura: img.naturalWidth,
    altura: img.naturalHeight,
    caminho: 'HTMLImageElement + decode()',
    avisos,
    liberar: () => URL.revokeObjectURL(url),
  }
}

export type DecisaoRotacao = {
  /** Orientação a aplicar no canvas. 1 significa "não mexer". */
  orientacaoAplicada: number
  motivo: string
  /** true quando as dimensões não permitem concluir nada sozinhas. */
  indeterminado: boolean
}

/**
 * Decide se o navegador já aplicou a rotação EXIF na decodificação, comparando
 * as dimensões decodificadas com as dimensões brutas do JPEG.
 */
export function decidirRotacao(
  exif: LeituraExif,
  decodificada: { largura: number; altura: number },
): DecisaoRotacao {
  const o = exif.orientacao

  if (o === null || o === 1) {
    return { orientacaoAplicada: 1, motivo: 'Sem EXIF de orientação (ou orientação 1). Nada a corrigir.', indeterminado: false }
  }

  if (exif.larguraBruta === null || exif.alturaBruta === null) {
    return {
      orientacaoAplicada: 1,
      motivo: `EXIF diz ${o}, mas não há dimensões brutas (SOF) para comparar. Assumindo que o navegador aplicou — confira no device e use o controle manual.`,
      indeterminado: true,
    }
  }

  const dimsTrocadas = decodificada.largura === exif.alturaBruta && decodificada.altura === exif.larguraBruta
  const dimsIguais = decodificada.largura === exif.larguraBruta && decodificada.altura === exif.alturaBruta

  if (trocaEixos(o)) {
    if (dimsTrocadas) {
      return {
        orientacaoAplicada: 1,
        motivo: `EXIF ${o} troca eixos e o decode veio ${decodificada.largura}×${decodificada.altura} contra ${exif.larguraBruta}×${exif.alturaBruta} no SOF: o navegador JÁ aplicou a rotação.`,
        indeterminado: false,
      }
    }
    if (dimsIguais) {
      return {
        orientacaoAplicada: o,
        motivo: `EXIF ${o} troca eixos mas o decode veio com as dimensões brutas (${decodificada.largura}×${decodificada.altura}): o navegador NÃO aplicou. Rotacionando no canvas.`,
        indeterminado: false,
      }
    }
    return {
      orientacaoAplicada: 1,
      motivo: `Decode ${decodificada.largura}×${decodificada.altura} não bate com o SOF ${exif.larguraBruta}×${exif.alturaBruta} nem trocado. Não dá para decidir pelas dimensões.`,
      indeterminado: true,
    }
  }

  // Orientações 2, 3 e 4 mantêm as dimensões, então a comparação não conclui nada.
  return {
    orientacaoAplicada: 1,
    motivo: `EXIF ${o} não troca eixos — as dimensões são idênticas nos dois casos e não revelam se o navegador aplicou. Assumindo que aplicou; confira visualmente.`,
    indeterminado: true,
  }
}

type Matriz = { m: [number, number, number, number, number, number]; largura: number; altura: number }

/**
 * Matriz que leva a imagem bruta (`w`×`h`) para o espaço já orientado.
 * setTransform(a,b,c,d,e,f) ⇒ x' = a·x + c·y + e ; y' = b·x + d·y + f
 */
function matrizOrientacao(orientacao: number, w: number, h: number): Matriz {
  switch (orientacao) {
    case 2:
      return { m: [-1, 0, 0, 1, w, 0], largura: w, altura: h }
    case 3:
      return { m: [-1, 0, 0, -1, w, h], largura: w, altura: h }
    case 4:
      return { m: [1, 0, 0, -1, 0, h], largura: w, altura: h }
    case 5:
      return { m: [0, 1, 1, 0, 0, 0], largura: h, altura: w }
    case 6:
      return { m: [0, 1, -1, 0, h, 0], largura: h, altura: w }
    case 7:
      return { m: [0, -1, -1, 0, h, w], largura: h, altura: w }
    case 8:
      return { m: [0, -1, 1, 0, 0, w], largura: h, altura: w }
    default:
      return { m: [1, 0, 0, 1, 0, 0], largura: w, altura: h }
  }
}

export type Recorte = {
  canvas: HTMLCanvasElement
  /** Dimensões da imagem depois de orientada, antes do recorte. */
  larguraOrientada: number
  alturaOrientada: number
  /** Lado do quadrado recortado, em pixels da imagem orientada. */
  ladoOrigem: number
  /** Lado do canvas final, depois do downscale para LADO_MAX. */
  lado: number
  sx: number
  sy: number
}

export function recortarQuadrado(
  imagem: CanvasImageSource,
  largura: number,
  altura: number,
  orientacao: number,
): Recorte {
  const { m, largura: w, altura: h } = matrizOrientacao(orientacao, largura, altura)

  const ladoOrigem = Math.min(w, h)
  const sx = Math.round((w - ladoOrigem) / 2)
  const sy = Math.round((h - ladoOrigem) / 2)
  const lado = Math.min(ladoOrigem, LADO_MAX)
  const escala = lado / ladoOrigem

  const canvas = document.createElement('canvas')
  canvas.width = lado
  canvas.height = lado

  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('getContext("2d") devolveu null — canvas indisponível neste device.')

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Primeiro a janela quadrada (em espaço orientado), depois a orientação.
  // A composição resultante é recorte ∘ orientação, aplicada num único draw.
  ctx.setTransform(escala, 0, 0, escala, -sx * escala, -sy * escala)
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
  ctx.drawImage(imagem, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  return { canvas, larguraOrientada: w, alturaOrientada: h, ladoOrigem, lado, sx, sy }
}

export type Codificado = {
  blob: Blob
  tipoPedido: string
  tipoRecebido: string
  bytes: number
  /** true quando o navegador ignorou o formato pedido e devolveu outro. */
  caiuParaOutroFormato: boolean
}

export async function codificar(
  canvas: HTMLCanvasElement,
  tipoPedido: string,
  qualidade: number,
): Promise<Codificado> {
  const blob = await new Promise<Blob>((resolver, rejeitar) => {
    canvas.toBlob(
      (b) => {
        if (b === null) {
          rejeitar(new Error(`canvas.toBlob devolveu null para ${tipoPedido} (qualidade ${qualidade}).`))
          return
        }
        resolver(b)
      },
      tipoPedido,
      qualidade,
    )
  })

  return {
    blob,
    tipoPedido,
    tipoRecebido: blob.type,
    bytes: blob.size,
    caiuParaOutroFormato: blob.type !== tipoPedido,
  }
}

export function descreverErro(e: unknown): string {
  if (e instanceof DOMException) return `${e.name}: ${e.message}`
  if (e instanceof Error) return `${e.name}: ${e.message}`
  if (typeof e === 'object' && e !== null) {
    try {
      return `objeto simples: ${JSON.stringify(e)}`
    } catch {
      return `objeto não serializável: ${String(e)}`
    }
  }
  return String(e)
}

export function detalharErro(e: unknown): string {
  const linhas: string[] = []
  linhas.push(`typeof: ${typeof e}`)
  linhas.push(`instanceof Error: ${e instanceof Error}`)
  linhas.push(`instanceof DOMException: ${e instanceof DOMException}`)
  if (e !== null && typeof e === 'object') {
    linhas.push(`constructor: ${(e as object).constructor?.name ?? '(sem)'}`)
    const chaves = Object.getOwnPropertyNames(e)
    linhas.push(`próprias: [${chaves.join(', ')}]`)
  }
  linhas.push(`String(e): ${String(e)}`)
  if (e instanceof Error && e.stack) linhas.push(`stack:\n${e.stack}`)
  return linhas.join('\n')
}

export function formatarBytes(bytes: number | undefined): string {
  // Registros gravados por uma versão anterior do spike não têm todos os campos.
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  return `${bytes.toLocaleString('pt-BR')} B (${(bytes / 1024).toFixed(1)} KB)`
}
