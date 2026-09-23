# Captura de foto com recorte 1:1 em PWA no iOS

Página única que exercita, num aparelho real, tudo que envolve tirar uma foto
quadrada dentro de uma PWA no Safari do iPhone: as duas rotas de câmera, o
recorte 1:1 no ato da captura, a orientação EXIF, a compressão e a persistência
do resultado em IndexedDB.

Nasceu como spike de decisão de um projeto meu, eu precisava saber se uma PWA
dava conta da câmera no iOS antes de escrever qualquer linha do app. Deu, mas o
caminho até lá rendeu uma lista de comportamentos que quase não aparecem
documentados, e é por isso que o repo existe separado.

**O princípio da página:** nada de `console.log`. Com um iPhone na mão e nenhum
Mac ao lado, o console é invisível, então toda falha, inclusive `window.onerror`
e `unhandledrejection`, é renderizada crua na tela, com `name`, `message`,
`stack` e as propriedades próprias do objeto.

---

## Os achados

Medidos em **iPhone, iOS 18.7, Safari 26.6.1**, com a página instalada na tela
de início (`navigator.standalone === true`). Onde o WebKit de desktop/Linux
diverge, está dito.

### 1. `canvas.toBlob('image/webp')` devolve PNG, sem avisar

O achado mais importante, porque falha em silêncio: o `toBlob` chama o callback
com um Blob perfeitamente válido, só que `image/png`. Não há exceção, não há
`null`, não há aviso. Quem confiar no tipo que pediu sobe PNG de fotografia
achando que é WebP:

| | JPEG q0,82 | "WebP" (PNG de verdade) |
| --- | --- | --- |
| `input capture` (12 MP) | 487 KB | 2.464 KB |
| `getUserMedia` | 259 KB | 1.847 KB |

Cinco vezes o tamanho. **Cheque sempre o `blob.type` recebido, nunca o pedido.**
O mesmo código em WebKit de desktop/Linux produz WebP de verdade, então testar
em WebKit headless *não* responde esta pergunta.

### 2. Guardar `Blob` no IndexedDB pode falhar

```
UnknownError: Error preparing Blob/File data to be stored in object store
```

Aconteceu de forma **intermitente** em WebKit headless: falhou, depois passou,
depois falhou de novo, com a mesma imagem e o mesmo código. Por isso a gravação
aqui tenta `Blob` e cai para `ArrayBuffer`, mostrando na tela qual das duas
funcionou. Se você precisa de confiabilidade, guarde bytes e remonte o `Blob` na
leitura.

Para exercitar o fallback de propósito, abra a página com `?falharBlob=1`.

### 3. O Safari do iOS já aplica a rotação EXIF, aplicar de novo deita a foto

Uma foto de iPhone em retrato chega com `Orientation = 6`, mas
`createImageBitmap(file, { imageOrientation: 'from-image' })` **já devolve o
bitmap girado**. Rotacionar no canvas por cima do EXIF, que é a receita que mais
circula, produz uma imagem deitada.

Só que também não dá para assumir o contrário, porque nem todo navegador aplica.
A saída usada aqui é detectar: ler a orientação do EXIF **e** as dimensões
brutas do marcador SOF do JPEG, e comparar com as dimensões que o decode
devolveu. Se o EXIF diz 6 (troca eixos) e o decode veio com as dimensões brutas,
o navegador não aplicou e o canvas aplica; se veio trocado, já está pronto.

Nas orientações 2, 3 e 4 as dimensões não mudam e a comparação não conclui nada
— a página marca o caso como *indeterminado* em vez de fingir certeza, e oferece
botões de forçar/ignorar para você decidir no olho.

### 4. `getUserMedia` funciona no app instalado na tela de início

Era o risco que podia derrubar a escolha de PWA, porque é historicamente onde o
iOS quebra. No iOS 18.7 funcionou: permissão pedida, câmera traseira, frame
capturado. Pipeline completo em 118–140 ms para uma foto de 12 MP.

Um detalhe: `matchMedia('(display-mode: standalone)')` responde `browser` mesmo
rodando pela tela de início, porque esta página não tem manifest.
`navigator.standalone` responde `true`. Não use o media query como detector de
PWA no iOS sem manifest.

### 5. O Vite 6 bloqueia o host do túnel

Não é iOS, mas custa tempo. Como a câmera exige secure context, o caminho
prático é um túnel HTTPS — e aí o Vite responde `403 Blocked request`, porque o
`Host` não está em `server.allowedHosts` (proteção contra DNS rebinding). A
mensagem não tem nada a ver com câmera e manda editar um arquivo que talvez nem
exista. O `vite.config.ts` daqui já libera os domínios de túnel comuns.

### 6. Qualidade de JPEG: 0,60 resolve

Comparando q0,82 e q0,60 na mesma foto, no device: **32% mais leve, com
diferença visual quase imperceptível**, tanto na foto ampliada quanto na
miniatura circular de 56px. A página mostra as duas lado a lado justamente para
você conferir com a sua foto, no seu aparelho.

O lado de 1080px não é exagero: numa tela de 440pt @3x uma foto em largura cheia
ocupa cerca de 1320px físicos.

---

## Rodar

A câmera exige *secure context*. No iPhone o host é a sua máquina, não
`localhost`, então `http://192.168.x.x:5173` **não serve**, `getUserMedia`
simplesmente não aparece em `navigator.mediaDevices`.

### Opção 1 - túnel com certificado confiável (recomendada)

Atrás de um túnel, quem faz o HTTPS é o túnel. O modo `tunel` serve HTTP puro e
libera os domínios de túnel em `allowedHosts`.

```bash
npm install
npm run dev:tunel
```

Em outro terminal:

```bash
cloudflared tunnel --url http://localhost:5273
```

Abra no Safari do iPhone a URL `https://...trycloudflare.com` que ele imprimir.
Sem conta, sem login. Se o comando não existir:

```bash
curl -L -o /tmp/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
sudo install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
```

A URL muda a cada execução, e é por isso que `allowedHosts` lista domínios
(`.trycloudflare.com`, `.ngrok-free.app`, `.ngrok.io`, `.loca.lt`, `.ts.net`) em
vez de hosts. Para outro serviço, acrescente em `DOMINIOS_DE_TUNEL` no
`vite.config.ts`.

Equivalentes: `ngrok http 5273` (exige conta) ou `tailscale funnel 5273`.

### Opção 2 - LAN direto, com certificado autoassinado

```bash
npm run dev            # HTTPS na 5273
```

Aceite o aviso em **Mostrar detalhes → Visitar este site**. Duas ressalvas:

1. **No WSL2**, os IPs que o Vite imprime são da rede interna e o iPhone não os
   alcança. Ou ligue o *mirrored networking*, ou faça o proxy de porta no
   PowerShell como administrador:

   ```powershell
   # IP da WSL: wsl hostname -I
   netsh interface portproxy add v4tov4 listenport=5273 listenaddress=0.0.0.0 `
     connectport=5273 connectaddress=<IP-DA-WSL>
   netsh advfirewall firewall add rule name="vite 5273" dir=in action=allow `
     protocol=TCP localport=5273
   ```

2. **Certificado autoassinado.** O Safari deixa navegar depois do aviso, mas a
   permissão de câmera em origem não confiável é errática no iOS. Se a rota B
   falhar aqui, refaça pela opção 1 antes de concluir qualquer coisa.

### Testar no app instalado

É o cenário que mais importa e o mais fácil de esquecer: Compartilhar →
Adicionar à Tela de Início, abrir pelo ícone e repetir a rota B lá dentro.

---

## O que a página faz

| Arquivo | Papel |
| --- | --- |
| `src/exif.ts` | Lê `Orientation` e as dimensões do marcador SOF direto dos bytes do JPEG |
| `src/captura.ts` | Decodifica, monta a matriz de orientação, recorta 1:1 e codifica |
| `src/db.ts` | Dexie, com o fallback de `Blob` para `ArrayBuffer` |
| `src/diagnostico.ts` | Capacidades do device, incluindo a sonda de WebP real no `toBlob` |
| `src/App.tsx` | As duas rotas, as prévias e a lista de erros crus |

**O recorte é um único `drawImage`.** A janela quadrada central e a matriz de
orientação são compostas antes do desenho, então o retângulo original nunca
chega a virar arquivo:

```ts
ctx.setTransform(escala, 0, 0, escala, -sx * escala, -sy * escala)
ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
ctx.drawImage(imagem, 0, 0)
```

As oito matrizes de orientação estão em `matrizOrientacao`, na convenção
`setTransform(a,b,c,d,e,f)` ⇒ `x' = a·x + c·y + e` e `y' = b·x + d·y + f`.

---

## Stack

Vite · React · TypeScript · Dexie. Sem framework de UI, sem router, sem backend.
CSS à mão, num arquivo só.

## Licença

MIT.
