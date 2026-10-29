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

    // título letra a letra, pro topo poder recolher até o "e."
    const letras = Array.from(t('topo.titulo'));
    $('marca').replaceChildren(...[...letras, '.'].map((letra, i) => {
      const span = document.createElement('span');
      span.className = 'letra' + (i === 0 ? ' inicial' : i === letras.length ? ' ponto' : '');
      span.textContent = letra;
      span.style.setProperty('--z', letras.length - i); // cada uma por trás da anterior
      return span;
    }));
    $('titulo').setAttribute('aria-label', t('topo.titulo'));

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

  // Ex.: "C10.00 2KKAT 3LILI 1FINI D0.75" (os ids vêm do data.json; C = cupom, D = doação).
  // O cupom vai na frente porque carrinho gigante é cortado no fim.
  function mensagemPix(itens, doacao, cupom = 0) {
    const partes = itens.map((i) => (i.unidades ?? i.qtd) + i.id.toUpperCase());
    if (cupom) partes.unshift('C' + (cupom / 100).toFixed(2));
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
            <div class="preco"></div>
          </div>
          <div class="qtd qtd-un">
            <button class="menos" aria-label="Remover um">−</button>
            <span class="n">0</span>
            <button class="mais" aria-label="Adicionar um">+</button>
          </div>`;
        icone(card.querySelector('.emoji'), p);
        card.querySelector('.nome').textContent = p.nome;
        const preco = card.querySelector('.preco');
        escrever(preco, brl(centavosDe(p)));
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

  // linha "🍫 R$ 4,00 / cada ×3" (o "cada ×3" embaixo do preço) com −/+ de kit em kit
  function linhaKit(p) {
    const linha = document.createElement('div');
    linha.className = 'kit';
    linha.innerHTML = `
      <span class="kit-icone" aria-hidden="true"><span class="kit-emoji"></span></span>
      <span class="kit-preco"><span class="kit-valor"></span><span class="kit-qtd"></span></span>
      <div class="qtd qtd-kit">
        <button class="menos" aria-label="Remover um kit">−</button>
        <span class="n">0</span>
        <button class="mais" aria-label="Adicionar um kit">+</button>
      </div>`;
    // o item repetido (×3), um por cima do outro
    for (let i = 0; i < tamanhoKit(); i++) {
      const unidade = document.createElement('span');
      unidade.className = 'kit-unidade';
      icone(unidade, p);
      linha.querySelector('.kit-emoji').appendChild(unidade);
    }
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

  let pixAtual = null;    // { itens, doacao, cupom } do Pix na tela
  let usarCupom = null;   // escolha do checkbox; null = ainda não decidiu (usa o padrão)

  function abrirPagamento() {
    usarCupom = null;
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
    const bruto = itens.reduce((s, i) => s + i.subtotal, 0) + doacao;

    // cupom do cashback: desconta até o valor dele, mas o Pix fica com pelo menos R$ 0,01.
    // Vem marcado só se a compra for maior que o cupom (pra não gastar à toa)
    const cb = cashback();
    $('pix-cupom').hidden = !cb?.disponivel;
    if (cb?.disponivel && usarCupom === null) usarCupom = bruto >= cb.cupom;
    const cupom = cb?.disponivel && usarCupom ? Math.min(cb.cupom, bruto - 1) : 0;
    if (cb?.disponivel) {
      $('pix-cupom-usar').checked = usarCupom;
      escrever($('pix-cupom-texto'), t('cashback.usar', { cupom: brl(cb.cupom) }));
    }
    const total = bruto - cupom;
    pixAtual = { itens, doacao, cupom };

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
    if (cupom) resumo.appendChild(linhaResumo(t('cashback.linhaResumo'), -cupom, 'cupom'));
    escrever($('pix-total'), brl(total));

    const codigo = pixPayload(dados.pix, total, mensagemPix(itens, doacao, cupom));
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
  // Resumo da compra pro WhatsApp (a descrição do Pix se perde na maioria dos bancos)
  const semMarcacao = (texto) => texto.replace(/\*\*|~~/g, '');
  function mensagemPaguei() {
    const { itens, doacao, cupom } = pixAtual;
    const linha = (texto, centavos) =>
      t('whatsapp.linha', { texto: semMarcacao(texto), valor: brl(centavos) });
    const linhas = [t('whatsapp.cabecalho'), ''];
    for (const i of itens) {
      const vars = { emoji: i.emoji || '🍬', nome: i.nome };
      if (i.qtd) linhas.push(linha(t('pix.linhaItem', { ...vars, qtd: i.qtd }), i.subtotalAvulso));
      if (i.kits) linhas.push(linha(t('pix.linhaKit', { ...vars, qtd: i.unidadesKit }), i.subtotalKit));
    }
    if (doacao) {
      const d = dados.doacao;
      linhas.push(linha(t('doacao.linhaResumo', { emoji: d.emoji || '🐳', nome: d.nome }), doacao));
    }
    if (cupom) linhas.push(linha(t('cashback.linhaResumo'), -cupom));
    const total = itens.reduce((s, i) => s + i.subtotal, 0) + doacao - cupom;
    linhas.push('', t('whatsapp.total', { total: brl(total) }));
    if (lerEmail()) linhas.push(t('whatsapp.quem', { email: lerEmail() }));
    linhas.push(t('whatsapp.codigo', { codigo: mensagemPix(itens, doacao, cupom) }));
    return linhas.join('\n');
  }

  const numeroWhatsapp = () => String(dados.contato?.whatsapp || '').replace(/\D/g, '');

  function paguei() {
    // abre o WhatsApp com o resumo (no clique, pra não ser bloqueado); sem número, só agradece
    const numero = numeroWhatsapp();
    if (numero && pixAtual) {
      window.open(`https://wa.me/${numero}?text=${encodeURIComponent(mensagemPaguei())}`, '_blank', 'noopener');
    }
    if (pixAtual?.cupom) {
      marcarCupomUsado();
      renderCashback();
    }
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
    const numero = numeroWhatsapp();
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

  // ---------- Conta ----------
  // E-mail @fitenergia.com.br guardado no navegador até a pessoa clicar em "sair"

  const DOMINIO = '@fitenergia.com.br';
  const CHAVE_EMAIL = 'engordando:email';
  let emailSemStorage = ''; // se o navegador bloquear o localStorage, vale até recarregar
  const lerEmail = () => {
    try { return localStorage.getItem(CHAVE_EMAIL) || ''; } catch { return emailSemStorage; }
  };
  const salvarEmail = (email) => {
    emailSemStorage = email;
    try {
      if (email) localStorage.setItem(CHAVE_EMAIL, email);
      else localStorage.removeItem(CHAVE_EMAIL);
    } catch { /* modo privado etc. */ }
  };
  // quem entrou quando o e-mail ficava só na sessão continua logado
  try {
    const antigo = sessionStorage.getItem(CHAVE_EMAIL);
    if (antigo && !lerEmail()) salvarEmail(antigo);
    sessionStorage.removeItem(CHAVE_EMAIL);
  } catch { /* sem storage */ }

  const svg = (d) =>
    `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONE_ENTRAR = svg('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>');
  const ICONE_SAIR = svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>');

  function renderConta() {
    const email = lerEmail();
    const rotulo = t(email ? 'conta.sair' : 'conta.entrar');
    for (const btn of document.querySelectorAll('.btn-conta')) {
      btn.innerHTML = (email ? ICONE_SAIR : ICONE_ENTRAR) + '<span class="rotulo"></span>';
      escrever(btn.querySelector('.rotulo'), rotulo);
      btn.setAttribute('aria-label', email ? `${rotulo} (${email})` : rotulo);
      btn.title = email;
    }
    minhasCompras = null;
    renderCashback();
    if (email) carregarHistorico().then(renderCashback, () => {}); // pro banner e o cupom do Pix
  }

  // automatico: aberto sozinho ao entrar na página; no celular não foca o campo
  // (senão o teclado sobe de cara)
  function abrirEntrar({ automatico = false } = {}) {
    $('entrar-email').value = '';
    $('entrar-email').placeholder = t('conta.placeholder');
    $('entrar-sufixo').textContent = DOMINIO;
    $('entrar-erro').hidden = true;
    $('modal-entrar').hidden = false;
    if (!automatico || !matchMedia('(pointer: coarse)').matches) $('entrar-email').focus();
  }

  // Quem fechou o login não é perguntado de novo na mesma sessão
  const CHAVE_PULOU = 'engordando:pulouLogin';
  const fecharEntrar = () => {
    $('modal-entrar').hidden = true;
    try { sessionStorage.setItem(CHAVE_PULOU, '1'); } catch { /* sem storage */ }
  };
  const pediuLogin = () => {
    try { return sessionStorage.getItem(CHAVE_PULOU) === '1'; } catch { return false; }
  };

  // Campo só com o usuário ("rafael.solli"); se colarem o e-mail inteiro, tira o domínio
  const usuarioDe = (texto) => {
    const v = texto.trim().toLowerCase();
    return v.endsWith(DOMINIO) ? v.slice(0, -DOMINIO.length) : v;
  };

  function entrar(e) {
    e.preventDefault();
    const usuario = usuarioDe($('entrar-email').value);
    if (!/^[a-z0-9._%+-]+$/.test(usuario)) {
      $('entrar-erro').hidden = false;
      $('entrar-email').focus();
      return;
    }
    salvarEmail(usuario + DOMINIO);
    fecharEntrar();
    renderConta();
  }

  function clicarConta() {
    if (!lerEmail()) return abrirEntrar();
    salvarEmail('');
    renderConta();
  }

  for (const btn of document.querySelectorAll('.btn-conta')) btn.addEventListener('click', clicarConta);
  $('form-entrar').addEventListener('submit', entrar);
  $('entrar-email').addEventListener('input', (e) => {
    $('entrar-erro').hidden = true;
    if (e.target.value.toLowerCase().includes(DOMINIO)) e.target.value = usuarioDe(e.target.value);
  });
  $('btn-entrar-cancelar').addEventListener('click', fecharEntrar);
  $('modal-entrar').addEventListener('click', (e) => {
    if (e.target.id === 'modal-entrar') fecharEntrar();
  });
  $('modal-entrar').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fecharEntrar();
  });

  // ---------- Histórico ----------
  // historico.json: { "2026-10": { "email": [{ "data" ("2026-10-28" ou ISO com hora), "valor", "cupom"? }] } }
  // (mês → e-mail → compras).
  // Não aparece pra ninguém: só alimenta o cashback.

  const FUSO = 'America/Sao_Paulo';
  let minhasCompras = null; // compras do e-mail logado

  async function carregarHistorico() {
    const email = lerEmail();
    const historico = await carregar('historico.json');
    if (lerEmail() !== email) return; // trocou de conta no meio do caminho
    // junta as compras desse e-mail de todos os meses
    minhasCompras = Object.values(historico)
      .flatMap((porEmail) => Object.entries(porEmail))
      .filter(([dono]) => dono.toLowerCase() === email)
      .flatMap(([, compras]) => compras)
      .filter((c) => !isNaN(dataDe(c)));
  }

  // ---------- Cashback ----------
  // Gastou a "meta" no mês (horário de Brasília) → cupom de "cupom" pra usar uma vez, no mesmo mês.
  // Usado = marcado no navegador (ao clicar em "Paguei") ou "cupom": true numa compra do historico.json.

  // "data" pode vir só com o dia ("2026-10-28"): vira meio-dia em Brasília (sem isso o navegador lê
  // meia-noite UTC, que aqui ainda é o dia anterior, e o dia 1º cairia no mês passado)
  const dataDe = (compra) => {
    const texto = String(compra.data);
    return new Date(/^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto + 'T12:00:00-03:00' : texto);
  };
  const mesDe = (data) => new Date(data).toLocaleDateString('en-CA', { timeZone: FUSO }).slice(0, 7); // "2026-10"
  const nomeDoMes = (mes) =>
    new Date(mes + '-15T12:00:00Z').toLocaleDateString('pt-BR', { month: 'long', timeZone: 'UTC' });
  const ultimoDia = (mes) => {
    const [ano, m] = mes.split('-').map(Number);
    return `${new Date(Date.UTC(ano, m, 0)).getUTCDate()}/${String(m).padStart(2, '0')}`;
  };

  const chaveCupom = () => 'engordando:cupom:' + lerEmail();
  const marcarCupomUsado = () => {
    try { localStorage.setItem(chaveCupom(), mesDe(Date.now())); } catch { /* sem storage */ }
  };
  const cupomUsadoAqui = (mes) => {
    try { return localStorage.getItem(chaveCupom()) === mes; } catch { return false; }
  };

  function cashback() {
    const cfg = dados.cashback;
    if (!cfg || !lerEmail() || !minhasCompras) return null;
    const mes = mesDe(Date.now());
    const doMes = minhasCompras.filter((c) => mesDe(dataDe(c)) === mes);
    const gasto = doMes.reduce((s, c) => s + Math.round(c.valor * 100), 0);
    const meta = Math.round(cfg.meta * 100);
    const cupom = Math.round(cfg.cupom * 100);
    const atingiu = gasto >= meta;
    const usado = doMes.some((c) => c.cupom) || cupomUsadoAqui(mes);
    return { mes, gasto, meta, cupom, atingiu, usado, disponivel: atingiu && !usado };
  }

  // Banner acima do WhatsApp: logado mostra a barrinha do mês; sem login, convida pra entrar
  function renderCashback() {
    const banner = $('banner-cashback');
    const cfg = dados?.cashback;
    const email = lerEmail();
    const cb = cashback();
    banner.hidden = !cfg || (email && !cb); // logado: espera o historico.json carregar
    if (banner.hidden) return;

    const convite = !email;
    banner.classList.toggle('clicavel', convite);
    banner.tabIndex = convite ? 0 : -1;
    banner.setAttribute('role', convite ? 'button' : 'region');
    $('cashback-seta').hidden = !convite;
    $('cashback-barra').hidden = convite;

    if (convite) {
      const vars = { meta: brl(Math.round(cfg.meta * 100)), cupom: brl(Math.round(cfg.cupom * 100)) };
      escrever($('cashback-emoji'), t('cashback.emoji'));
      escrever($('cashback-titulo'), t('cashback.conviteTitulo', vars));
      escrever($('cashback-texto'), t('cashback.conviteTexto', vars));
      return;
    }
    const vars = {
      falta: brl(cb.meta - cb.gasto), cupom: brl(cb.cupom), gasto: brl(cb.gasto), meta: brl(cb.meta),
      mes: nomeDoMes(cb.mes), ate: ultimoDia(cb.mes),
    };
    const estado = !cb.atingiu ? 'falta' : cb.usado ? 'usado' : 'liberado';
    escrever($('cashback-emoji'), t(estado === 'liberado' ? 'cashback.emojiLiberado' : 'cashback.emoji'));
    escrever($('cashback-titulo'), t('cashback.' + estado, vars));
    escrever($('cashback-texto'), estado === 'falta' ? t('cashback.detalhe', vars) : t(`cashback.${estado}Texto`, vars));
    $('cashback-preenchido').style.width = Math.min(100, (cb.gasto / cb.meta) * 100) + '%';
    banner.classList.toggle('completo', cb.atingiu);
  }

  $('banner-cashback').addEventListener('click', () => { if (!lerEmail()) abrirEntrar(); });
  $('banner-cashback').addEventListener('keydown', (e) => {
    if (!lerEmail() && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); abrirEntrar(); }
  });

  // ---------- Topo que encolhe ----------
  // Mede o topo cheio uma vez (e de novo se a tela/fonte mudar). Na rolagem da lista só atualiza
  // --p (0 = cheio, 1 = reduzido); o resto é calc() no CSS.

  const raiz = document.documentElement;
  const TAMANHO_E = 30; // px do "e." no topo reduzido
  let alturaCheia = 0;
  let alturaMini = 56;

  function medirTopo() {
    const topo = $('topo');
    raiz.style.setProperty('--p', 0);
    topo.style.height = 'auto';
    alturaCheia = topo.offsetHeight;
    topo.style.height = '';
    alturaMini = parseFloat(getComputedStyle(topo).getPropertyValue('--h-mini')) || 56;

    const marca = $('marca');
    marca.style.transform = 'none';
    const caixa = topo.getBoundingClientRect();
    const m = marca.getBoundingClientRect();
    marca.style.transform = '';
    const fonte = parseFloat(getComputedStyle($('titulo')).fontSize);
    const s = TAMANHO_E / fonte;
    const seguro = alturaMini - 56; // entalhe do iPhone

    raiz.style.setProperty('--h-cheia', alturaCheia + 'px');
    raiz.style.setProperty('--h-rodape', $('barra').offsetHeight + 'px');
    topo.style.setProperty('--x0', (caixa.width - m.width) / 2 - (m.left - caixa.left) + 'px'); // centro
    topo.style.setProperty('--x1', 20 - (m.left - caixa.left) + 'px'); // 20px da borda
    topo.style.setProperty('--dy', seguro + (56 - m.height * s) / 2 - (m.top - caixa.top) + 'px');
    topo.style.setProperty('--s', s);

    // quanto cada letra anda pra ficar atrás do "e" (o ponto para logo depois dele)
    const spans = [...marca.children];
    const [inicial] = spans;
    const ATRASO_MAX = 0.4;
    const n = spans.length - 2; // letras entre o "e" e o "."
    topo.style.setProperty('--atraso-max', ATRASO_MAX);
    spans.forEach((span, i) => {
      if (!i) return;
      const ponto = i === spans.length - 1;
      const alvo = ponto ? inicial.offsetLeft + inicial.offsetWidth : inicial.offsetLeft;
      span.style.setProperty('--dx', alvo - span.offsetLeft + 'px');
      span.style.setProperty('--atraso', (ATRASO_MAX * (Math.min(i, n) - 1)) / Math.max(1, n - 1));
    });
    ajustarFolga();
    rolarTopo();
  }

  // Se a lista rola, mas menos do que o topo precisa pra recolher, o título travaria no meio
  // (letras embaralhadas). Completa com uma folga no fim; se cabe tudo na tela, não rola e fica 0.
  function ajustarFolga() {
    const lista = $('rolagem');
    const folga = $('rolagem-folga');
    const sobra = lista.scrollHeight - folga.offsetHeight - lista.clientHeight;
    const faixa = alturaCheia - alturaMini;
    folga.style.height = sobra > 0 && sobra < faixa ? faixa - sobra + 'px' : '0px';
  }

  function rolarTopo() {
    const lista = $('rolagem');
    const faixa = alturaCheia - alturaMini; // rolagem que só encolhe o topo
    const p = Math.min(1, Math.max(0, lista.scrollTop / Math.max(1, faixa)));
    raiz.style.setProperty('--p', p.toFixed(4)); // na raiz: o topo e o recorte da lista usam

    // setinhas: tem item escondido acima (depois do topo já reduzido) ou abaixo?
    $('seta-cima').classList.toggle('visivel', lista.scrollTop > faixa + 8);
    $('seta-baixo').classList.toggle('visivel', lista.scrollTop + lista.clientHeight < lista.scrollHeight - 8);
  }

  const pular = (sentido) => () =>
    $('rolagem').scrollBy({ top: sentido * $('rolagem').clientHeight * 0.7, behavior: 'smooth' });
  $('seta-cima').addEventListener('click', pular(-1));
  $('seta-baixo').addEventListener('click', pular(+1));
  // lista muda de altura (fotos carregando, banner aparecendo): refaz a folga e as setinhas
  const observador = new ResizeObserver(() => { ajustarFolga(); rolarTopo(); });
  observador.observe($('catalogo'));
  observador.observe($('banner'));
  observador.observe($('banner-cashback'));

  let quadro = 0;
  $('rolagem').addEventListener('scroll', () => {
    if (!quadro) quadro = requestAnimationFrame(() => { quadro = 0; rolarTopo(); });
  }, { passive: true });
  addEventListener('resize', medirTopo);
  document.fonts?.ready.then(medirTopo);

  // ---------- Init ----------

  $('btn-pagar').addEventListener('click', abrirPagamento);
  $('btn-voltar').addEventListener('click', fecharModal);
  $('btn-fechar').addEventListener('click', fecharModal);
  $('btn-copiar').addEventListener('click', copiar);
  $('pix-cupom-usar').addEventListener('change', (e) => {
    usarCupom = e.target.checked;
    mostrarPix(pixAtual.itens, pixAtual.doacao); // refaz total e QR
  });
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
      medirTopo();
      renderConta();
      if (!lerEmail() && !pediuLogin()) abrirEntrar({ automatico: true });
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
