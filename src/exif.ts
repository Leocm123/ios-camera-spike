// Leitura de orientação EXIF direto dos bytes do arquivo.
//
// Por que parsear na mão em vez de confiar no navegador: precisamos saber se o
// navegador JÁ aplicou a rotação ao decodificar. Sem o valor bruto do EXIF e
// sem as dimensões reais armazenadas no JPEG (marcador SOF), não dá para
// distinguir "já veio certo" de "veio deitado" — e as duas situações existem
// dependendo da versão do Safari.

export type LeituraExif = {
  /** 1..8 conforme TIFF/EXIF. `null` quando não há tag de orientação. */
  orientacao: number | null
  /** Dimensões como estão gravadas nos pixels do JPEG, antes de qualquer rotação. */
  larguraBruta: number | null
  alturaBruta: number | null
  /** Formato detectado pelos magic bytes, que pode divergir de `File.type`. */
  formatoDetectado: string
  /** Por que a leitura terminou como terminou. Sempre preenchido. */
  observacao: string
}

const ORIENTACOES_QUE_TROCAM_EIXOS = [5, 6, 7, 8]

export function trocaEixos(orientacao: number | null): boolean {
  return orientacao !== null && ORIENTACOES_QUE_TROCAM_EIXOS.includes(orientacao)
}

export function descreverOrientacao(orientacao: number | null): string {
  switch (orientacao) {
    case null:
      return 'ausente'
    case 1:
      return '1 — normal'
    case 2:
      return '2 — espelhada na horizontal'
    case 3:
      return '3 — girada 180°'
    case 4:
      return '4 — espelhada na vertical'
    case 5:
      return '5 — transposta'
    case 6:
      return '6 — girar 90° horário (retrato de iPhone)'
    case 7:
      return '7 — transversa'
    case 8:
      return '8 — girar 90° anti-horário'
    default:
      return `${orientacao} — valor fora do intervalo 1..8`
  }
}

export async function lerExif(arquivo: Blob): Promise<LeituraExif> {
  const buffer = await arquivo.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  const formato = detectarFormato(bytes)

  if (formato !== 'jpeg') {
    return {
      orientacao: null,
      larguraBruta: null,
      alturaBruta: null,
      formatoDetectado: formato,
      observacao:
        formato === 'heic'
          ? 'HEIC/HEIF: este parser só lê JPEG. O Safari normalmente entrega JPEG na captura, mas pode entregar HEIC ao escolher da galeria — anotar se acontecer.'
          : `Formato ${formato}: sem EXIF lido (só JPEG é parseado neste spike).`,
    }
  }

  let orientacao: number | null = null
  let larguraBruta: number | null = null
  let alturaBruta: number | null = null
  const notas: string[] = []

  let pos = 2
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) {
      notas.push(`Fluxo de marcadores quebrou no offset ${pos} (esperava 0xFF, achou 0x${bytes[pos].toString(16)}).`)
      break
    }
    const marcador = bytes[pos + 1]

    // Marcadores sem payload.
    if (marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd9)) {
      pos += 2
      continue
    }
    // Início do scan: daqui para frente são dados comprimidos, nada a ler.
    if (marcador === 0xda) break

    const tamanho = view.getUint16(pos + 2)
    if (tamanho < 2) {
      notas.push(`Segmento 0x${marcador.toString(16)} com tamanho inválido (${tamanho}).`)
      break
    }

    if (marcador === 0xe1 && orientacao === null) {
      orientacao = lerOrientacaoNoApp1(view, bytes, pos + 4, tamanho - 2, notas)
    }

    // SOF0..SOF15, exceto DHT (0xC4), JPG (0xC8) e DAC (0xCC).
    const ehSof =
      marcador >= 0xc0 && marcador <= 0xcf && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc
    if (ehSof && larguraBruta === null) {
      alturaBruta = view.getUint16(pos + 5)
      larguraBruta = view.getUint16(pos + 7)
    }

    pos += 2 + tamanho
  }

  if (orientacao === null) notas.push('Nenhuma tag 0x0112 (Orientation) encontrada.')
  if (larguraBruta === null) notas.push('Nenhum marcador SOF encontrado; sem dimensões brutas para comparar.')

  return {
    orientacao,
    larguraBruta,
    alturaBruta,
    formatoDetectado: 'jpeg',
    observacao: notas.length > 0 ? notas.join(' ') : 'Leitura completa.',
  }
}

function detectarFormato(bytes: Uint8Array): string {
  if (bytes.length < 12) return 'arquivo curto demais'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png'
  const caixa = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])
  if (caixa === 'ftyp') {
    const marca = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(marca)) return 'heic'
    return `iso-bmff (${marca})`
  }
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF') return 'webp'
  return 'desconhecido'
}

/** Lê a tag Orientation dentro de um segmento APP1. Devolve null se não achar. */
function lerOrientacaoNoApp1(
  view: DataView,
  bytes: Uint8Array,
  inicio: number,
  tamanho: number,
  notas: string[],
): number | null {
  const assinatura = String.fromCharCode(...bytes.slice(inicio, inicio + 4))
  if (assinatura !== 'Exif') return null

  const tiff = inicio + 6
  if (tiff + 8 > inicio + tamanho) {
    notas.push('APP1 Exif truncado antes do cabeçalho TIFF.')
    return null
  }

  const ordem = view.getUint16(tiff)
  if (ordem !== 0x4949 && ordem !== 0x4d4d) {
    notas.push(`Ordem de bytes TIFF inválida (0x${ordem.toString(16)}).`)
    return null
  }
  const le = ordem === 0x4949

  if (view.getUint16(tiff + 2, le) !== 42) {
    notas.push('Magic 42 do TIFF ausente.')
    return null
  }

  const ifd0 = tiff + view.getUint32(tiff + 4, le)
  const entradas = view.getUint16(ifd0, le)
  for (let i = 0; i < entradas; i++) {
    const entrada = ifd0 + 2 + i * 12
    if (entrada + 12 > view.byteLength) break
    if (view.getUint16(entrada, le) === 0x0112) {
      return view.getUint16(entrada + 8, le)
    }
  }

  notas.push('IFD0 lido, mas sem tag de orientação.')
  return null
}
