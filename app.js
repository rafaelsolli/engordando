(function () {
  'use strict';

  const brl = (centavos) =>
    (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Escreve o texto no elemento: **trecho** vira negrito, ~~trecho~~ riscado, e "R$"/"PIX" ficam
  // em maiúsculas (a página é toda lowercase)
  function escrever(el, texto) {
    el.textContent = '';
    for (const parte of String(texto).split(/(\*\*.+?\*\*|~~.+?~~|R\$|PIX)/)) {
      if (!parte) continue;
      if (parte.startsWith('**') || parte.startsWith('~~')) {
        const tag = document.createElement(parte.startsWith('**') ? 'strong' : 's');
        escrever(tag, parte.slice(2, -2));
        el.appendChild(tag);
      } else if (parte === 'R$' || parte === 'PIX') {
        const span = document.createElement('span');
        span.className = 'caixa-alta';
        span.textContent = parte;
        el.appendChild(span);
      } else {
        el.appendChild(document.createTextNode(parte));
      }
    }
  }

  // ---------- Textos (textos.json) ----------

  let textos = {};

  // t('doacao.pergunta', { valor: 'R$ 0,75' }) → texto com os {placeholders} trocados
  function t(chave, vars = {}) {
    const bruto = chave.split('.').reduce((o, k) => (o == null ? o : o[k]), textos);
    if (typeof bruto !== 'string') return '';
    return bruto.replace(/\{(\w+)\}/g, (m, nome) => (nome in vars ? vars[nome] : m));
  }

  function aplicarTextos() {
    document.title = t('aba') || document.title;
    for (const el of document.querySelectorAll('[data-texto]')) escrever(el, t(el.dataset.texto));

    // sorteia um trocadilho pro topo a cada visita
    const opcoes = textos.topo?.trocadilhos || [];
    const sorteado = opcoes[Math.floor(Math.random() * opcoes.length)] || {};
    escrever($('topo-antes'), sorteado.antes || '');
    escrever($('topo-riscado'), sorteado.riscado || '');
  }

  // ---------- Pix BR Code (EMV estático) ----------

  const tlv = (id, valor) => id + String(valor.length).padStart(2, '0') + valor;

  function crc16(str) {
    let crc = 0xffff;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let b = 0; b < 8; b++) {
        crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
        crc &= 0xffff;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  // BR Code só aceita ASCII; tira acentos e caracteres estranhos
  const ascii = (s, max, pontuacao = false) =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(pontuacao ? /[^A-Za-z0-9 .,]/g : /[^A-Za-z0-9 ]/g, '')
      .toUpperCase().trim().slice(0, max);

  // Ex.: "2KKAT 3LILI 1FINI D0.75" (os ids vêm do data.json)
  function mensagemPix(itens, doacao) {
    const partes = itens.map((i) => (i.unidades ?? i.qtd) + i.id.toUpperCase());
    if (doacao) partes.push('D' + (doacao / 100).toFixed(2));
    return partes.join(' ');
  }

  // O campo 26 (conta) tem no máximo 99 caracteres; a mensagem usa o que sobrar
  function pixPayload({ chave, nome, cidade }, centavos, mensagem) {
    const base = tlv('00', 'br.gov.bcb.pix') + tlv('01', chave);
    const espaco = 99 - base.length - 4;
    const msg = ascii(mensagem || 'Engordando', 999, true).slice(0, espaco).trim();
    const conta = base + (msg ? tlv('02', msg) : '');
    const semCrc =
      tlv('00', '01') +
      tlv('26', conta) +
      tlv('52', '0000') +
      tlv('53', '986') +
      tlv('54', (centavos / 100).toFixed(2)) +
      tlv('58', 'BR') +
      tlv('59', ascii(nome, 25)) +
      tlv('60', ascii(cidade, 15)) +
      tlv('62', tlv('05', '***')) +
      '6304';
    return semCrc + crc16(semCrc);
  }

  // ---------- Estado ----------

  let dados = null;
  const carrinho = {}; // id -> unidades avulsas
  const kits = {};     // id -> quantos kits

  const $ = (id) => document.getElementById(id);
  const produtosAtivos = () =>
    dados.produtos.filter((p) => p.ativo !== false && centavosDe(p) > 0);
  // Preço = custo médio ponderado das compras × (1 + margem), arredondado pra cima.
  // Um "preco" fixo no produto, se existir, tem prioridade.
  function centavosDe(p, margem = dados.precificacao?.margem ?? 0.2) {
    if (p.preco != null) return Math.round(p.preco * 100);
    const compras = p.compras || [];
    const valor = compras.reduce((s, c) => s + c.valor, 0);
    const unidades = compras.reduce((s, c) => s + c.unidades, 0);
    if (!unidades) return 0;
    const passo = Math.round((dados.precificacao?.arredondamento ?? 0.25) * 100);
    const bruto = (valor * 100 / unidades) * (1 + margem);
    return Math.ceil(bruto / passo - 1e-9) * passo;
  }

  // "Leve mais por menos": no kit, cada unidade sai com a margem menor.
  // Só aparece nos produtos com "kit": true, sem preço fixo, e se ficar mais barato
  // que a unidade (nas balas, o arredondamento empata).
  const tamanhoKit = () => dados.precificacao?.kit?.quantidade ?? 3;
  function precoKitDe(p) {
    const kit = dados.precificacao?.kit;
    if (!kit || !p.kit || p.preco != null || p.esgotado) return 0;
    const preco = centavosDe(p, kit.margem ?? 0.1);
    return preco < centavosDe(p) ? preco : 0;
  }

  // qtd = unidades avulsas, kits = nº de kits, unidades = total de unidades
  function itensNoCarrinho() {
    return produtosAtivos()
      .filter((p) => !p.esgotado)
      .map((p) => {
        const qtd = carrinho[p.id] || 0;
        const k = precoKitDe(p) ? kits[p.id] || 0 : 0;
        const unidadesKit = k * tamanhoKit();
        return {
          ...p, qtd, kits: k, unidadesKit,
          unidades: qtd + unidadesKit,
          subtotalAvulso: centavosDe(p) * qtd,
          subtotalKit: precoKitDe(p) * unidadesKit,
          subtotal: centavosDe(p) * qtd + precoKitDe(p) * unidadesKit,
        };
      })
      .filter((i) => i.unidades > 0);
  }

  // ---------- Render ----------

  // Foto do produto (campo "imagem"); sem foto, ou se ela não carregar, fica o emoji
  function icone(el, p) {
    const emoji = () => { el.textContent = p.emoji || '🍬'; };
    if (!p.imagem) return emoji();
    const img = document.createElement('img');
    img.src = p.imagem;
    img.alt = '';
    img.addEventListener('error', () => { el.classList.remove('com-foto'); emoji(); }, { once: true });
    el.replaceChildren(img);
    el.classList.add('com-foto');
  }

  function renderCatalogo() {
    const porCategoria = {};
    for (const p of produtosAtivos()) {
      (porCategoria[p.categoria] ||= []).push(p);
    }

    const main = $('catalogo');
    main.innerHTML = '';
    for (const [categoria, produtos] of Object.entries(porCategoria)) {
      const sec = document.createElement('section');
      sec.className = 'categoria';
      const h2 = document.createElement('h2');
      h2.textContent = categoria;
      const grade = document.createElement('div');
      grade.className = 'grade';

      for (const p of produtos) {
        const card = document.createElement('article');
        card.className = 'produto';
        card.dataset.id = p.id;
        card.innerHTML = `
          <div class="emoji" aria-hidden="true"></div>
          <div class="info">
            <div class="nome"></div>
            <div class="detalhe"></div>
            <div class="preco"></div>
          </div>
          <div class="qtd qtd-un">
            <button class="menos" aria-label="Remover um">−</button>
            <span class="n">0</span>
            <button class="mais" aria-label="Adicionar um">+</button>
          </div>`;
        icone(card.querySelector('.emoji'), p);
        card.querySelector('.nome').textContent = p.nome;
        card.querySelector('.detalhe').textContent = p.detalhe || '';
        const preco = card.querySelector('.preco');
        escrever(preco, brl(centavosDe(p)));
        // preço da Araujo riscado, só quando o nosso é mais barato
        const araujo = Math.round((p.precoAraujo || 0) * 100);
        if (!p.esgotado && araujo > centavosDe(p)) {
          const span = document.createElement('span');
          span.className = 'preco-araujo';
          escrever(span, t('catalogo.precoAraujo', { preco: brl(araujo) }));
          preco.prepend(span, ' ');
        }
        if (p.esgotado) {
          // continua na lista, mas cinza e sem os botões
          card.classList.add('esgotado');
          const selo = document.createElement('span');
          selo.className = 'selo-esgotado';
          escrever(selo, t('catalogo.esgotado'));
          card.querySelector('.qtd').replaceWith(selo);
        } else {
          card.querySelector('.qtd-un .menos').addEventListener('click', () => alterar(p.id, -1));
          card.querySelector('.qtd-un .mais').addEventListener('click', () => alterar(p.id, +1));
          if (precoKitDe(p)) card.appendChild(linhaKit(p));
        }
        grade.appendChild(card);
      }

      sec.append(h2, grade);
      main.appendChild(sec);
    }
    atualizar();
  }

  // linha "🍫 R$ 4,00 cada ×3" com −/+ de kit em kit
  function linhaKit(p) {
    const linha = document.createElement('div');
    linha.className = 'kit';
    linha.innerHTML = `
      <span class="kit-icone" aria-hidden="true"><span class="kit-emoji"></span></span>
      <span class="kit-preco"><span class="kit-valor"></span> <span class="kit-qtd"></span></span>
      <div class="qtd qtd-kit">
        <button class="menos" aria-label="Remover um kit">−</button>
        <span class="n">0</span>
        <button class="mais" aria-label="Adicionar um kit">+</button>
      </div>`;
    icone(linha.querySelector('.kit-emoji'), p);
    escrever(linha.querySelector('.kit-qtd'), t('catalogo.kit', { qtd: tamanhoKit() }));
    escrever(linha.querySelector('.kit-valor'), t('catalogo.kitPreco', { preco: brl(precoKitDe(p)) }));
    linha.querySelector('.menos').addEventListener('click', () => alterar(p.id, -1, true));
    linha.querySelector('.mais').addEventListener('click', () => alterar(p.id, +1, true));
    return linha;
  }

  function alterar(id, delta, kit = false) {
    const alvo = kit ? kits : carrinho;
    alvo[id] = Math.max(0, (alvo[id] || 0) + delta);
    atualizar();
    if (delta > 0) {
      const n = document.querySelector(`.produto[data-id="${id}"] ${kit ? '.qtd-kit' : '.qtd-un'} .n`);
      n.classList.remove('pop');
      void n.offsetWidth; // reinicia a animação
      n.classList.add('pop');
    }
  }

  function atualizar() {
    for (const card of document.querySelectorAll('.produto:not(.esgotado)')) {
      const q = carrinho[card.dataset.id] || 0;
      card.querySelector('.qtd-un .n').textContent = q;
      card.querySelector('.qtd-un .menos').disabled = q === 0;
      // no kit, o contador mostra unidades (3, 6, 9…)
      const k = kits[card.dataset.id] || 0;
      const kit = card.querySelector('.qtd-kit');
      if (kit) {
        kit.querySelector('.n').textContent = k * tamanhoKit();
        kit.querySelector('.menos').disabled = k === 0;
      }
      card.classList.toggle('no-carrinho', q + k > 0);
    }
    const itens = itensNoCarrinho();
    const qtd = itens.reduce((s, i) => s + i.unidades, 0);
    const total = itens.reduce((s, i) => s + i.subtotal, 0);
    escrever($('barra-itens'),
      t(qtd === 0 ? 'barra.nenhumItem' : qtd === 1 ? 'barra.umItem' : 'barra.variosItens', { qtd }));
    escrever($('barra-total'), brl(total));
    $('btn-pagar').disabled = qtd === 0;
  }

  // ---------- Pagamento ----------

  const etapa = (nome) => {
    for (const e of ['doacao', 'pix', 'obrigado']) $(e + '-etapa').hidden = e !== nome;
  };

  // Quanto falta pra arredondar pro próximo real (ou um valor fixo se já for redondo)
  // "não perguntar mais" fica salvo só no navegador de quem marcou
  const CHAVE_SEM_DOACAO = 'engordando:semDoacao';
  const lerSemDoacao = () => {
    try { return localStorage.getItem(CHAVE_SEM_DOACAO) === '1'; } catch { return false; }
  };
  const salvarSemDoacao = () => {
    try { localStorage.setItem(CHAVE_SEM_DOACAO, '1'); } catch { /* modo privado etc. */ }
  };

  function abrirPagamento() {
    const itens = itensNoCarrinho();
    const subtotal = itens.reduce((s, i) => s + i.subtotal, 0);
    if (!subtotal) return;

    const doacao = dados.doacao;
    if (!doacao || doacao.ativo === false || lerSemDoacao()) {
      mostrarPix(itens, 0);
    } else {
      const valor = Math.round((doacao.valor ?? 0.1) * 100);
      const vars = {
        valor: brl(valor), subtotal: brl(subtotal), nome: doacao.nome, emoji: doacao.emoji || '🐳',
      };
      $('doacao-emoji').textContent = vars.emoji;
      escrever($('doacao-pergunta'), t('doacao.pergunta', vars));
      escrever($('doacao-explicacao'), t('doacao.explicacao', vars));
      escrever($('btn-doar'), t('doacao.doar', vars));
      const escolher = (centavos) => () => {
        if ($('doacao-nao-perguntar').checked) salvarSemDoacao();
        mostrarPix(itens, centavos);
      };
      $('doacao-nao-perguntar').checked = false;
      $('btn-doar').onclick = escolher(valor);
      $('btn-nao-doar').onclick = escolher(0);
      etapa('doacao');
    }
    $('modal-pix').hidden = false;
  }

  function linhaResumo(texto, centavos, classe) {
    const li = document.createElement('li');
    if (classe) li.className = classe;
    const nome = document.createElement('span');
    escrever(nome, texto);
    const valor = document.createElement('span');
    escrever(valor, brl(centavos));
    li.append(nome, valor);
    return li;
  }

  function mostrarPix(itens, doacao) {
    const total = itens.reduce((s, i) => s + i.subtotal, 0) + doacao;

    const resumo = $('pix-resumo');
    resumo.innerHTML = '';
    for (const i of itens) {
      const vars = { emoji: i.emoji || '🍬', nome: i.nome };
      if (i.qtd) resumo.appendChild(linhaResumo(t('pix.linhaItem', { ...vars, qtd: i.qtd }), i.subtotalAvulso));
      if (i.kits) resumo.appendChild(linhaResumo(t('pix.linhaKit', { ...vars, qtd: i.unidadesKit }), i.subtotalKit));
    }
    if (doacao) {
      const d = dados.doacao;
      const texto = t('doacao.linhaResumo', { emoji: d.emoji || '🐳', nome: d.nome });
      resumo.appendChild(linhaResumo(texto, doacao, 'doacao'));
    }
    escrever($('pix-total'), brl(total));

    const codigo = pixPayload(dados.pix, total, mensagemPix(itens, doacao));
    $('pix-codigo').value = codigo;

    const qr = qrcode(0, 'M');
    qr.addData(codigo);
    qr.make();
    $('pix-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });

    escrever($('btn-copiar'), t('pix.copiar'));
    etapa('pix');
  }

  function fecharModal() {
    $('modal-pix').hidden = true;
  }

  async function copiar() {
    const input = $('pix-codigo');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    escrever($('btn-copiar'), t('pix.copiado'));
  }

  // "a", "a e b", "a, b e c"
  const listar = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' e ' + xs.at(-1));

  // Se comprou algo que fica na geladeira, mostra o lembrete de repor no lugar do obrigado
  function paguei() {
    const bebidas = itensNoCarrinho()
      .filter((i) => i.geladeira)
      .map((i) => (i.unidades > 1 ? `${i.unidades} ${i.nome}` : i.nome));
    const chave = bebidas.length ? 'obrigadoGeladeira' : 'obrigado';
    const vars = { bebidas: listar(bebidas) };
    for (const campo of ['emoji', 'titulo', 'texto']) {
      escrever($('obrigado-' + campo), t(`${chave}.${campo}`, vars));
    }
    escrever($('btn-fechar'), t(`${chave}.fechar`));

    for (const id of Object.keys(carrinho)) delete carrinho[id];
    for (const id of Object.keys(kits)) delete kits[id];
    atualizar();
    etapa('obrigado');
  }

  // Link do WhatsApp com a mensagem pronta (só aparece se tiver número no data.json)
  function montarBanner() {
    const numero = String(dados.contato?.whatsapp || '').replace(/\D/g, '');
    if (!numero) return;
    const texto = encodeURIComponent(t('banner.mensagemPronta'));
    $('banner').href = `https://wa.me/${numero}?text=${texto}`;
    $('banner').hidden = false;
  }

  // ---------- Tema ----------
  // Sem escolha salva, segue o aparelho. O botão alterna e grava a escolha.

  const escuroDoAparelho = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
  const temaAtual = () => document.documentElement.dataset.tema || (escuroDoAparelho() ? 'escuro' : 'claro');

  function renderTema() {
    const escuro = temaAtual() === 'escuro';
    $('btn-tema').textContent = escuro ? '☀️' : '🌙';
    $('btn-tema').setAttribute('aria-label', escuro ? 'usar tema claro' : 'usar tema escuro');
  }

  function trocarTema() {
    const novo = temaAtual() === 'escuro' ? 'claro' : 'escuro';
    document.documentElement.dataset.tema = novo;
    try { localStorage.setItem('engordando:tema', novo); } catch { /* sem storage */ }
    renderTema();
  }

  $('btn-tema').addEventListener('click', trocarTema);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderTema);
  renderTema();

  // ---------- Init ----------

  $('btn-pagar').addEventListener('click', abrirPagamento);
  $('btn-voltar').addEventListener('click', fecharModal);
  $('btn-fechar').addEventListener('click', fecharModal);
  $('btn-copiar').addEventListener('click', copiar);
  $('btn-paguei').addEventListener('click', paguei);
  $('modal-pix').addEventListener('click', (e) => {
    if (e.target.id === 'modal-pix') fecharModal();
  });

  const carregar = (arquivo) =>
    fetch(arquivo, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`${arquivo}: ${r.status}`);
      return r.json();
    });

  Promise.all([carregar('data.json'), carregar('textos.json')])
    .then(([d, txt]) => {
      dados = d;
      textos = txt;
      aplicarTextos();
      renderCatalogo();
      montarBanner();
    })
    .catch(() => {
      $('catalogo').innerHTML = '<p class="erro">Não consegui carregar os produtos 😢</p>';
    });

  // exposto pra testes no console
  window.engordando = {
    pixPayload, crc16, centavosDe, precoKitDe, mensagemPix, t,
    setDados: (d) => (dados = d), setTextos: (x) => (textos = x),
  };
})();
