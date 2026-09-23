import { useCallback, useEffect, useRef, useState } from 'react'

import {
  codificar,
  decidirRotacao,
  decodificar,
  descreverErro,
  detalharErro,
  formatarBytes,
  recortarQuadrado,
  type Codificado,
  type DecisaoRotacao,
  type Decodificada,
} from './captura'
import { coletarDiagnostico, sondarSuporteWebp, type Diagnostico } from './diagnostico'
import {
  db,
  limparCapturas,
  listarCapturas,
  novoId,
  paraBlob,
  salvarCaptura,
  type CapturaSalva,
  type FormaArmazenada,
  type Rota,
} from './db'
import { descreverOrientacao, lerExif, type LeituraExif } from './exif'
import { ImagemBlob } from './ImagemBlob'

const QUALIDADE_ALTA = 0.82
const QUALIDADE_BAIXA = 0.6

type RegistroErro = {
  id: string
  quando: string
  contexto: string
  cru: string
}

type Resultado = {
  rota: Rota
  origem: string
  exif: LeituraExif
  decode: { caminho: string; largura: number; altura: number; avisos: string[] }
  decisao: DecisaoRotacao
  orientacaoAplicada: number
  larguraOrientada: number
  alturaOrientada: number
  ladoOrigem: number
  lado: number
  jpegAlta: Codificado
  jpegBaixa: Codificado
  webp: Codificado
  msDecorridos: number
  id: string
  modoRotacao: ModoRotacao
}

type Persistencia =
  | { estado: 'gravando' }
  | { estado: 'ok'; forma: FormaArmazenada }
  | { estado: 'falhou' }

type ModoRotacao = 'auto' | 'forcar' | 'ignorar'

export default function App() {
  const [diag] = useState<Diagnostico>(coletarDiagnostico)
  const [suporteWebp, setSuporteWebp] = useState('sondando…')
  const [erros, setErros] = useState<RegistroErro[]>([])
  const [resultado, setResultado] = useState<Resultado | null>(null)
  const [salvas, setSalvas] = useState<CapturaSalva[]>([])
  const [recuperadasNoLoad, setRecuperadasNoLoad] = useState<number | null>(null)
  const [persistencia, setPersistencia] = useState<Persistencia | null>(null)
  const [modoRotacao, setModoRotacao] = useState<ModoRotacao>('auto')
  const [ocupado, setOcupado] = useState(false)

  const [cameraAtiva, setCameraAtiva] = useState(false)
  const [ajustesTrilha, setAjustesTrilha] = useState<MediaTrackSettings | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const avisouWebp = useRef(false)

  const registrarErro = useCallback((contexto: string, e: unknown) => {
    setErros((atuais) => [
      {
        id: `${Date.now()}-${Math.random()}`,
        quando: new Date().toLocaleTimeString('pt-BR'),
        contexto,
        cru: detalharErro(e),
      },
      ...atuais,
    ])
  }, [])

  // Nada de erro sumindo no console: o device real não tem console à vista.
  useEffect(() => {
    const aoErro = (ev: ErrorEvent) => registrarErro(`window.error em ${ev.filename}:${ev.lineno}`, ev.error ?? ev.message)
    const aoRejeitar = (ev: PromiseRejectionEvent) => registrarErro('unhandledrejection', ev.reason)
    window.addEventListener('error', aoErro)
    window.addEventListener('unhandledrejection', aoRejeitar)
    return () => {
      window.removeEventListener('error', aoErro)
      window.removeEventListener('unhandledrejection', aoRejeitar)
    }
  }, [registrarErro])

  useEffect(() => {
    sondarSuporteWebp().then(setSuporteWebp, (e: unknown) => {
      setSuporteWebp(`falhou — ${descreverErro(e)}`)
      registrarErro('sondarSuporteWebp', e)
    })
  }, [registrarErro])

  // Prova da persistência: o que aparece aqui veio do IndexedDB, não da memória.
  useEffect(() => {
    listarCapturas().then(
      (lista) => {
        setSalvas(lista)
        setRecuperadasNoLoad(lista.length)
      },
      (e: unknown) => registrarErro('listarCapturas no load', e),
    )
  }, [registrarErro])

  useEffect(() => () => pararStream(streamRef), [])

  const processar = useCallback(
    async (fonte: { tipo: 'arquivo'; arquivo: File } | { tipo: 'video'; video: HTMLVideoElement }, rota: Rota) => {
      setOcupado(true)
      const t0 = performance.now()
      let decodificada: Decodificada | null = null

      try {
        let exif: LeituraExif
        let imagem: CanvasImageSource
        let largura: number
        let altura: number
        let caminho: string
        let avisos: string[]
        let origem: string

        if (fonte.tipo === 'arquivo') {
          exif = await lerExif(fonte.arquivo)
          decodificada = await decodificar(fonte.arquivo)
          imagem = decodificada.imagem
          largura = decodificada.largura
          altura = decodificada.altura
          caminho = decodificada.caminho
          avisos = decodificada.avisos
          origem = `${fonte.arquivo.name || '(sem nome)'} · ${fonte.arquivo.type || '(sem type)'} · ${formatarBytes(fonte.arquivo.size)}`
        } else {
          const v = fonte.video
          if (v.videoWidth === 0 || v.videoHeight === 0) {
            throw new Error('O vídeo ainda não tem dimensões (videoWidth = 0). O stream não chegou a renderizar um frame.')
          }
          exif = {
            orientacao: null,
            larguraBruta: null,
            alturaBruta: null,
            formatoDetectado: 'frame de vídeo',
            observacao: 'Frame vindo de getUserMedia não passa por EXIF — o pixel já chega na orientação do sensor.',
          }
          imagem = v
          largura = v.videoWidth
          altura = v.videoHeight
          caminho = 'HTMLVideoElement (frame ao vivo)'
          avisos = []
          origem = `frame ${v.videoWidth}×${v.videoHeight} do stream`
        }

        const decisao = decidirRotacao(exif, { largura, altura })

        const orientacaoAplicada =
          modoRotacao === 'forcar'
            ? (exif.orientacao ?? 1)
            : modoRotacao === 'ignorar'
              ? 1
              : decisao.orientacaoAplicada

        // Recorte 1:1 no ato: o retângulo original nunca chega a virar arquivo.
        const recorte = recortarQuadrado(imagem, largura, altura, orientacaoAplicada)

        const jpegAlta = await codificar(recorte.canvas, 'image/jpeg', QUALIDADE_ALTA)
        const jpegBaixa = await codificar(recorte.canvas, 'image/jpeg', QUALIDADE_BAIXA)
        const webp = await codificar(recorte.canvas, 'image/webp', QUALIDADE_ALTA)

        const msDecorridos = Math.round(performance.now() - t0)
        const id = novoId()

        // A prévia entra antes da gravação: se o IndexedDB recusar, a foto
        // continua na tela e o erro aparece separado, sem esconder o resultado.
        setResultado({
          rota,
          origem,
          exif,
          decode: { caminho, largura, altura, avisos },
          decisao,
          orientacaoAplicada,
          larguraOrientada: recorte.larguraOrientada,
          alturaOrientada: recorte.alturaOrientada,
          ladoOrigem: recorte.ladoOrigem,
          lado: recorte.lado,
          jpegAlta,
          jpegBaixa,
          webp,
          msDecorridos,
          id,
          modoRotacao,
        })

        for (const aviso of avisos) registrarErro('decodificação (tentativa descartada)', aviso)
        // Uma vez por sessão: a substituição é do navegador, não da foto, e
        // repetir o aviso a cada captura só afoga a lista.
        if (webp.caiuParaOutroFormato && !avisouWebp.current) {
          avisouWebp.current = true
          registrarErro(
            'toBlob WebP',
            `Pedi image/webp e recebi ${webp.tipoRecebido}. O navegador trocou o formato sem avisar. Aviso emitido uma vez; vale para todas as capturas desta sessão.`,
          )
        }
        if (jpegAlta.caiuParaOutroFormato) {
          registrarErro('toBlob JPEG', `Pedi image/jpeg e recebi ${jpegAlta.tipoRecebido}.`)
        }

        setPersistencia({ estado: 'gravando' })
        try {
          const gravacao = await salvarCaptura(
            {
              id,
              criadoEm: Date.now(),
              rota,
              jpegTipoRecebido: jpegAlta.tipoRecebido,
              jpegBytes: jpegAlta.bytes,
              jpegBaixaBytes: jpegBaixa.bytes,
              webpBytes: webp.bytes,
              webpTipoRecebido: webp.tipoRecebido,
              lado: recorte.lado,
              origem,
              exifOrientacao: exif.orientacao,
              rotacaoAplicada: orientacaoAplicada,
              motivoRotacao: decisao.motivo,
              caminhoDecode: caminho,
              msDecorridos,
            },
            jpegAlta.blob,
          )
          if (gravacao.avisoBlob !== null) registrarErro('IndexedDB — Blob direto', gravacao.avisoBlob)
          setPersistencia({ estado: 'ok', forma: gravacao.forma })
          setSalvas(await listarCapturas())
        } catch (e) {
          setPersistencia({ estado: 'falhou' })
          registrarErro('salvarCaptura', e)
        }
      } catch (e) {
        registrarErro(`processar (${rota})`, e)
      } finally {
        decodificada?.liberar()
        setOcupado(false)
      }
    },
    [modoRotacao, registrarErro],
  )

  function aoEscolherArquivo(ev: React.ChangeEvent<HTMLInputElement>) {
    const input = ev.currentTarget
    const arquivo = input.files?.[0]
    if (arquivo === undefined) {
      registrarErro('input[type=file]', 'O change disparou sem arquivo em files[0].')
      return
    }
    void processar({ tipo: 'arquivo', arquivo }, 'input-file')
    // Sem isso, escolher a mesma foto duas vezes não dispara change de novo.
    input.value = ''
  }

  async function abrirCamera() {
    setAjustesTrilha(null)
    try {
      if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
        throw new Error(
          `navigator.mediaDevices.getUserMedia não existe. isSecureContext = ${window.isSecureContext}, origem = ${window.location.origin}.`,
        )
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1920 },
        },
      })
      streamRef.current = stream
      setCameraAtiva(true)

      const video = videoRef.current
      if (video === null) throw new Error('videoRef nulo depois de obter o stream.')
      video.srcObject = stream
      await video.play()

      const trilha = stream.getVideoTracks()[0]
      setAjustesTrilha(trilha?.getSettings() ?? null)
    } catch (e) {
      registrarErro('getUserMedia', e)
      pararStream(streamRef)
      setCameraAtiva(false)
    }
  }

  function fecharCamera() {
    pararStream(streamRef)
    if (videoRef.current !== null) videoRef.current.srcObject = null
    setCameraAtiva(false)
  }

  function capturarDoVideo() {
    const video = videoRef.current
    if (video === null) {
      registrarErro('capturarDoVideo', 'videoRef nulo.')
      return
    }
    void processar({ tipo: 'video', video }, 'getusermedia')
  }

  async function apagarTudo() {
    try {
      await limparCapturas()
      setSalvas([])
      setResultado(null)
      setPersistencia(null)
      setRecuperadasNoLoad(0)
    } catch (e) {
      registrarErro('limparCapturas', e)
    }
  }

  return (
    <main>
      <h1>Captura com recorte 1:1 no iOS</h1>
      <p className="subtitulo">
        Banco de provas: duas rotas de câmera, recorte quadrado no ato, compressão, EXIF e IndexedDB — com tudo que
        falhar escrito na tela. Feito para abrir no Safari do iPhone.
      </p>

      <section>
        <h2>1. Rota A — input[type=file] capture=environment</h2>
        <label className="arquivo">
          <span>{ocupado ? 'Processando…' : 'Abrir câmera pelo input de arquivo'}</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={aoEscolherArquivo}
            disabled={ocupado}
          />
        </label>
        <p className="mime" style={{ marginTop: 8 }}>
          O sistema decide a UI. No iOS abre a câmera nativa com Foto/Vídeo/Biblioteca; não há como pré-visualizar o
          recorte antes do disparo.
        </p>
      </section>

      <section>
        <h2>2. Rota B — getUserMedia + canvas</h2>
        <div className="moldura-video" style={{ display: cameraAtiva ? 'block' : 'none' }}>
          <video ref={videoRef} playsInline muted autoPlay />
          <div className="guia" />
        </div>
        <div className="botoes">
          {cameraAtiva ? (
            <>
              <button onClick={capturarDoVideo} disabled={ocupado}>
                {ocupado ? 'Processando…' : 'Capturar frame'}
              </button>
              <button className="secundario" onClick={fecharCamera}>
                Fechar câmera
              </button>
            </>
          ) : (
            <button onClick={() => void abrirCamera()} disabled={ocupado}>
              Abrir câmera ao vivo
            </button>
          )}
        </div>
        {ajustesTrilha !== null && (
          <>
            <h3 style={{ marginTop: 16 }}>Ajustes da trilha de vídeo</h3>
            <pre>{JSON.stringify(ajustesTrilha, null, 2)}</pre>
          </>
        )}
      </section>

      <section>
        <h2>3. Correção de orientação EXIF</h2>
        <p className="mime" style={{ marginTop: 0 }}>
          O automático compara as dimensões decodificadas com as dimensões brutas do JPEG. Se o resultado sair deitado,
          force o outro modo e capture de novo.
        </p>
        <div className="controle-rotacao">
          {(
            [
              ['auto', 'Automático'],
              ['forcar', 'Forçar EXIF'],
              ['ignorar', 'Ignorar EXIF'],
            ] as const
          ).map(([valor, rotulo]) => (
            <button
              key={valor}
              className="secundario"
              aria-pressed={modoRotacao === valor}
              onClick={() => setModoRotacao(valor)}
            >
              {rotulo}
            </button>
          ))}
        </div>
      </section>

      {resultado !== null && <BlocoResultado resultado={resultado} />}

      <section>
        <h2>5. Persistência (IndexedDB via Dexie)</h2>
        <p className="mime" style={{ marginTop: 0 }}>
          {recuperadasNoLoad === null
            ? 'Lendo o banco…'
            : recuperadasNoLoad === 0
              ? `Ao carregar a página: nenhuma captura no banco "${db.name}". Capture uma e recarregue.`
              : `Ao carregar a página: ${recuperadasNoLoad} captura(s) recuperada(s) do IndexedDB — banco "${db.name}".`}
        </p>
        {persistencia !== null && (
          <p className={persistencia.estado === 'falhou' ? 'mime nao' : 'mime'}>
            {persistencia.estado === 'gravando' && 'Gravando a última captura…'}
            {persistencia.estado === 'ok' &&
              (persistencia.forma === 'blob'
                ? 'Última captura gravada como Blob direto — o caminho normal.'
                : 'Última captura só gravou como ArrayBuffer: este device recusa Blob no IndexedDB. Ver erros crus.')}
            {persistencia.estado === 'falhou' && 'A última captura NÃO foi gravada. Ver erros crus.'}
          </p>
        )}
        {salvas.length > 0 && (
          <div className="salvas" style={{ marginTop: 12 }}>
            {salvas.map((s) => (
              <div className="salva" key={s.id}>
                <ImagemBlob
                  blob={paraBlob(s.jpeg, s.jpegTipoRecebido)}
                  className="bolinha"
                  alt="Miniatura recuperada do banco"
                />
                <div>
                  <strong>
                    {s.rota === 'input-file' ? 'Rota A (input file)' : 'Rota B (getUserMedia)'} · {s.lado}px ·{' '}
                    {s.formaArmazenada === 'blob' ? 'Blob' : 'ArrayBuffer'}
                  </strong>
                  {new Date(s.criadoEm).toLocaleString('pt-BR')} · JPEG q{QUALIDADE_ALTA}{' '}
                  {formatarBytes(s.jpegBytes)} · q{QUALIDADE_BAIXA} {formatarBytes(s.jpegBaixaBytes)} · WebP{' '}
                  {formatarBytes(s.webpBytes)} ({s.webpTipoRecebido}) · EXIF {s.exifOrientacao ?? 'ausente'} → aplicada{' '}
                  {s.rotacaoAplicada} · {s.msDecorridos} ms
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="botoes" style={{ marginTop: 12 }}>
          <button className="secundario" onClick={() => location.reload()}>
            Recarregar a página
          </button>
          <button className="secundario" onClick={() => void apagarTudo()}>
            Apagar tudo do banco
          </button>
        </div>
      </section>

      <section className={erros.length > 0 ? 'erro-bloco' : undefined}>
        <h2>6. Erros crus ({erros.length})</h2>
        {erros.length === 0 ? (
          <p className="mime" style={{ margin: 0 }}>
            Nenhum erro registrado. Tudo que falhar aparece aqui inteiro, sem catch silencioso.
          </p>
        ) : (
          <>
            {erros.map((e) => (
              <pre key={e.id}>
                [{e.quando}] {e.contexto}
                {'\n'}
                {e.cru}
              </pre>
            ))}
            <button className="secundario" onClick={() => setErros([])}>
              Limpar lista
            </button>
          </>
        )}
      </section>

      <section>
        <h2>7. Diagnóstico do device</h2>
        <dl className="dados">
          <dt>getUserMedia</dt>
          <dd className={diag.temGetUserMedia ? 'sim' : 'nao'}>{diag.temGetUserMedia ? 'existe' : 'NÃO existe'}</dd>
          <dt>mediaDevices</dt>
          <dd className={diag.temMediaDevices ? 'sim' : 'nao'}>{diag.temMediaDevices ? 'existe' : 'NÃO existe'}</dd>
          <dt>getUserMedia legado</dt>
          <dd>{diag.temGetUserMediaLegado ? 'existe (prefixado)' : 'não existe'}</dd>
          <dt>secure context</dt>
          <dd className={diag.secureContext ? 'sim' : 'nao'}>{String(diag.secureContext)}</dd>
          <dt>origem</dt>
          <dd>{diag.origem}</dd>
          <dt>toBlob WebP</dt>
          <dd className={suporteWebp.startsWith('sim') ? 'sim' : 'aviso'}>{suporteWebp}</dd>
          <dt>createImageBitmap</dt>
          <dd className={diag.temCreateImageBitmap ? 'sim' : 'nao'}>{String(diag.temCreateImageBitmap)}</dd>
          <dt>OffscreenCanvas</dt>
          <dd>{String(diag.temOffscreenCanvas)}</dd>
          <dt>IndexedDB</dt>
          <dd className={diag.temIndexedDB ? 'sim' : 'nao'}>{String(diag.temIndexedDB)}</dd>
          <dt>crypto.randomUUID</dt>
          <dd className={diag.temRandomUUID ? 'sim' : 'aviso'}>{String(diag.temRandomUUID)}</dd>
          <dt>display-mode</dt>
          <dd>
            {diag.displayMode}
            {diag.standaloneIOS ? ' (navigator.standalone)' : ''}
          </dd>
          <dt>tela / DPR</dt>
          <dd>
            {diag.telaCss} @ {diag.devicePixelRatio}x
          </dd>
          <dt>platform</dt>
          <dd>{diag.plataforma}</dd>
        </dl>
        <h3 style={{ marginTop: 16 }}>User agent</h3>
        <pre>{diag.userAgent}</pre>
      </section>
    </main>
  )
}

function BlocoResultado({ resultado }: { resultado: Resultado }) {
  const { exif, decode, decisao, webp, jpegAlta, jpegBaixa } = resultado
  const economia = Math.round((1 - jpegBaixa.bytes / jpegAlta.bytes) * 100)

  return (
    <section>
      <h2>4. Última captura</h2>

      <div className="formatos">
        <Formato titulo={`JPEG q${QUALIDADE_ALTA}`} codificado={jpegAlta} />
        <Formato titulo={`JPEG q${QUALIDADE_BAIXA}`} codificado={jpegBaixa} />
        {!webp.caiuParaOutroFormato && <Formato titulo={`WebP q${QUALIDADE_ALTA}`} codificado={webp} />}
      </div>

      <p className="bytes" style={{ marginTop: 12 }}>
        q{QUALIDADE_BAIXA} pesa {economia}% menos que q{QUALIDADE_ALTA}. Compare as duas bolinhas de 56px e a foto
        ampliada antes de decidir.
      </p>
      {webp.caiuParaOutroFormato && (
        <p className="mime aviso">
          WebP indisponível: o toBlob devolveu {webp.tipoRecebido} com {formatarBytes(webp.bytes)}. Sem prévia, porque
          não é um formato candidato neste device.
        </p>
      )}

      <h3 style={{ marginTop: 20 }}>Pipeline</h3>
      <dl className="dados">
        <dt>rota</dt>
        <dd>{resultado.rota === 'input-file' ? 'A — input[type=file]' : 'B — getUserMedia'}</dd>
        <dt>origem</dt>
        <dd>{resultado.origem}</dd>
        <dt>decode</dt>
        <dd>{decode.caminho}</dd>
        <dt>decodificado</dt>
        <dd>
          {decode.largura}×{decode.altura}
        </dd>
        <dt>formato real</dt>
        <dd>{exif.formatoDetectado}</dd>
        <dt>EXIF orientação</dt>
        <dd>{descreverOrientacao(exif.orientacao)}</dd>
        <dt>dimensões brutas</dt>
        <dd>
          {exif.larguraBruta === null ? 'não lidas' : `${exif.larguraBruta}×${exif.alturaBruta} (SOF)`}
        </dd>
        <dt>rotação aplicada</dt>
        <dd className={decisao.indeterminado ? 'aviso' : undefined}>{resultado.orientacaoAplicada}</dd>
        <dt>orientado</dt>
        <dd>
          {resultado.larguraOrientada}×{resultado.alturaOrientada}
        </dd>
        <dt>recorte 1:1</dt>
        <dd>
          {resultado.ladoOrigem}px de origem → {resultado.lado}px finais
        </dd>
        <dt>tempo total</dt>
        <dd>{resultado.msDecorridos} ms</dd>
        <dt>id da captura</dt>
        <dd>{resultado.id}</dd>
      </dl>

      <h3 style={{ marginTop: 16 }}>Decisão de orientação</h3>
      <pre>
        {resultado.modoRotacao === 'auto'
          ? decisao.motivo
          : `Modo manual "${resultado.modoRotacao === 'forcar' ? 'Forçar EXIF' : 'Ignorar EXIF'}" sobrepôs o automático.\nO automático diria: ${decisao.motivo}`}
      </pre>
      <pre>{exif.observacao}</pre>
    </section>
  )
}

function Formato({ titulo, codificado }: { titulo: string; codificado: Codificado }) {
  return (
    <div className="formato">
      <h3>{titulo}</h3>
      <ImagemBlob blob={codificado.blob} className="ampliada" alt={`Prévia ampliada em ${titulo}`} />
      <p className="bytes">{formatarBytes(codificado.bytes)}</p>
      <p className={codificado.caiuParaOutroFormato ? 'mime aviso' : 'mime'}>
        {codificado.caiuParaOutroFormato
          ? `pediu ${codificado.tipoPedido}, veio ${codificado.tipoRecebido}`
          : codificado.tipoRecebido}
      </p>
      <div className="linha-bolinha">
        <ImagemBlob blob={codificado.blob} className="bolinha" alt={`Prévia de 56px em ${titulo}`} />
        <span>56px, o tamanho de uma miniatura de lista</span>
      </div>
    </div>
  )
}

function pararStream(ref: React.RefObject<MediaStream | null>) {
  ref.current?.getTracks().forEach((t) => t.stop())
  ref.current = null
}
