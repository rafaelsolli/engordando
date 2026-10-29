# engordando 🍫

Vendinha de honestidade do escritório. Página estática: escolhe os itens, paga por Pix (QR Code + copia e cola já com o valor).

## Editar preços / produtos / Pix

Tudo fica em [`data.json`](data.json):

- `pix`: chave (telefone no formato `+55DDDNUMERO`), nome (até 25 caracteres, sem acento) e cidade (até 15).
- `precificacao`: `margem` (0.20 = 20%) e `arredondamento` (0.25 = sempre arredonda pra cima de R$ 0,25 em R$ 0,25).
  - `kit`: o "leve mais por menos". Cada produto ganha uma linha de kit com `quantidade` unidades (3) a um preço calculado com a `margem` do kit (0.10 = 10%). A linha só aparece nos produtos com `"kit": true`, quando o kit sai mais barato que a unidade e o produto não tem preço fixo. Na mensagem do Pix vai o total de unidades (avulsas + kits).
- `doacao`: antes do Pix, pergunta se a pessoa quer doar `valor` (fixo) pra `nome`. Tem um "não perguntar mais" que fica salvo no navegador da pessoa. `"ativo": false` desliga pra todo mundo.
- `contato.whatsapp`: número (com DDI e DDD) do banner no fim da lista e do "Paguei": ao clicar, abre o WhatsApp com o resumo da compra pronto pra mandar (itens, doação, cashback, total, e-mail de quem está logado e o código da mensagem do Pix), porque a descrição do Pix se perde na maioria dos bancos. Os textos ficam em `textos.json` → `whatsapp`. O texto pronto da mensagem fica em `textos.json` → `banner.mensagemPronta`. Sem número, o banner some. O banner inteiro é o link.
- `produtos`: cada item tem `id`, `nome`, `emoji`, `categoria`, `ativo` e `compras`.
  - `imagem`: foto do produto (PNG com fundo transparente, quadrado, ~256px) em `img/produtos/`. Sem ela, ou se não carregar, aparece o `emoji`.
  - O `id` (curto, ~4 letras, único) vai na mensagem do Pix pra contabilizar as vendas, ex.: `2KKAT 3LILI 1FINI D0.75` (`D` = doação, `C` no começo = cupom do cashback). A mensagem tem limite de ~59 caracteres; carrinhos gigantes são cortados no fim.
  - **Repôs estoque?** Adicione uma linha em `compras` com o que pagou e quantas unidades vieram:
    `{ "data": "2026-11-01", "valor": 83.52, "unidades": 24 }`
  - O preço é calculado sozinho: (soma dos valores ÷ soma das unidades) × (1 + margem), arredondado pra cima.
  - Quer forçar um preço? Coloque `"preco": 5.00` no produto, que ele tem prioridade sobre o cálculo.
  - Acabou o estoque? Coloque `"esgotado": true`: o item continua na lista, mas cinza, com o selo "esgotado!" e sem os botões. Já `"ativo": false` tira o item da lista.
  - `"geladeira": true` marca o que fica na geladeira: se a compra tiver algum, a tela final usa os textos de `obrigadoGeladeira` (lembrete de repor) em vez de `obrigado`.
  - A ordem no arquivo é a ordem na página; categorias aparecem na ordem do primeiro item de cada uma.

## Entrar

O botão "entrar" no topo pede o e-mail da Fit: a pessoa digita só o usuário e o `@fitenergia.com.br` fica fixo no campo (se colar o e-mail inteiro, o domínio é tirado). Ele fica salvo no navegador (`localStorage`) até a pessoa clicar em "sair". Com e-mail salvo, o botão vira "sair". Quem chega sem login já vê o pedido de entrar; se fechar, não é perguntado de novo até fechar a aba.

## Cashback

`data.json` → `cashback`: `meta` (R$ 100) e `cupom` (R$ 10). Bateu a meta em compras no mês (horário de Brasília), a pessoa ganha um cupom pra usar **uma vez, no mesmo mês**.

- Banner acima do do WhatsApp: logado, mostra a barrinha do mês (quanto falta, cupom liberado ou já usado); sem login, convida pra entrar (e abre o login).
- No Pix, com cupom liberado, aparece "usar meu cupom": desconta até o valor dele, mas o Pix nunca fica abaixo de R$ 0,01 (o que sobrar do cupom se perde). Vem marcado só se a compra for de pelo menos o valor do cupom. A mensagem do Pix ganha um `C10.00` no começo.
- Conta como usado se a pessoa clicou em "Paguei" com ele aplicado (fica salvo no navegador dela) ou se a compra do mês no `historico.json` tiver `"cupom": true` (o registro oficial).

As compras vêm de [`historico.json`](historico.json) (que ninguém vê na página; só alimenta a barrinha, então ela só anda quando o arquivo é atualizado):

```json
{
  "2026-10": {
    "rafael.solli@fitenergia.com.br": [
      { "data": "2026-10-20", "valor": 8.50 },
      { "data": "2026-10-28", "valor": 0.01, "cupom": true }
    ]
  }
}
```

Agrupado por mês → e-mail (em ordem alfabética) → compras. `data` é só o dia (`"2026-10-28"`, horário de Brasília); pro cashback só importa o mês. Data com hora (ISO com fuso) também funciona. O arquivo é público como o resto do site.

## Editar textos

Títulos, frases e botões ficam em [`textos.json`](textos.json).

- `{placeholders}` são trocados na hora: `{valor}`, `{subtotal}`, `{nome}`, `{emoji}`, `{qtd}` (só os que já aparecem em cada texto).
- `**trecho**` vira negrito e `~~trecho~~` vira riscado.
- `topo.trocadilhos`: a cada visita sorteia um. Cada item pode ter `antes` (frase pequena acima do título) e/ou `riscado` (palavra riscada acima do título).
- A página é toda em minúsculas, mas `R$` e `PIX` sempre aparecem em maiúsculas.

## Rodar localmente

```sh
python3 -m http.server 8000
# abrir http://localhost:8000
```

(Abrir o `index.html` direto pelo arquivo não funciona, o navegador bloqueia a leitura do `data.json`.)

## Publicar no GitHub Pages

Settings → Pages → Source: *Deploy from a branch* → branch `main`, pasta `/ (root)`.
