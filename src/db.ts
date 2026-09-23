// Persistência local. O que interessa validar aqui é se o Safari/iOS guarda e
// devolve a foto depois de um reload — o modelo de dados é o mínimo possível.
//
// Achado do spike: nem todo WebKit aceita `Blob` como valor de object store.
// Alguns builds respondem `UnknownError: Error preparing Blob/File data to be
// stored in object store`. Por isso a gravação tenta Blob primeiro e cai para
// ArrayBuffer, registrando na tela qual das duas formas funcionou no device.

import Dexie, { type Table } from 'dexie'

import { descreverErro } from './captura'

export type Rota = 'input-file' | 'getusermedia'
export type FormaArmazenada = 'blob' | 'arraybuffer'

export type CapturaSalva = {
  id: string
  criadoEm: number
  rota: Rota
  /** JPEG na qualidade alta — é ele que a miniatura recuperada usa. */
  jpeg: Blob | ArrayBuffer
  jpegTipoRecebido: string
  jpegBytes: number
  /** Só o peso interessa nos outros dois; guardar três cópias da foto não paga. */
  jpegBaixaBytes: number
  webpBytes: number
  webpTipoRecebido: string
  formaArmazenada: FormaArmazenada
  lado: number
  origem: string
  exifOrientacao: number | null
  rotacaoAplicada: number
  motivoRotacao: string
  caminhoDecode: string
  msDecorridos: number
}

type DadosCaptura = Omit<CapturaSalva, 'jpeg' | 'formaArmazenada'>

class BancoSpike extends Dexie {
  capturas!: Table<CapturaSalva, string>

  constructor() {
    super('ios-camera-spike')
    this.version(1).stores({ capturas: 'id, criadoEm' })
  }
}

export const db = new BancoSpike()

/** `?falharBlob=1` na URL força o caminho de fallback, para testá-lo de propósito. */
export const falhaDeBlobForcada = new URLSearchParams(window.location.search).has('falharBlob')

export async function listarCapturas(limite = 8): Promise<CapturaSalva[]> {
  return db.capturas.orderBy('criadoEm').reverse().limit(limite).toArray()
}

export type ResultadoGravacao = {
  forma: FormaArmazenada
  /** Preenchido quando o Blob direto falhou e o ArrayBuffer salvou. */
  avisoBlob: string | null
}

export async function salvarCaptura(dados: DadosCaptura, jpeg: Blob): Promise<ResultadoGravacao> {
  try {
    if (falhaDeBlobForcada) {
      throw new Error('Falha simulada por ?falharBlob=1 na URL — o Blob nem chegou a ser gravado.')
    }
    await db.capturas.put({ ...dados, jpeg, formaArmazenada: 'blob' })
    return { forma: 'blob', avisoBlob: null }
  } catch (e) {
    // Se o ArrayBuffer também falhar, o erro sobe — não existe terceira tentativa.
    await db.capturas.put({
      ...dados,
      jpeg: await jpeg.arrayBuffer(),
      formaArmazenada: 'arraybuffer',
    })
    return {
      forma: 'arraybuffer',
      avisoBlob: `IndexedDB recusou o Blob direto: ${descreverErro(e)}. O mesmo dado gravou como ArrayBuffer — neste device é preciso guardar bytes, não Blob.`,
    }
  }
}

export function paraBlob(valor: Blob | ArrayBuffer, tipo: string): Blob {
  return valor instanceof Blob ? valor : new Blob([valor], { type: tipo })
}

export async function limparCapturas(): Promise<void> {
  await db.capturas.clear()
}

export function novoId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // crypto.randomUUID exige secure context; se cair aqui, o próprio diagnóstico já avisou.
  return `sem-uuid-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
