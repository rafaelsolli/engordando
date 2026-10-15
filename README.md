# engordando 🍫

Vendinha de honestidade do escritório. Página estática: escolhe os itens, paga por Pix (QR Code + copia e cola já com o valor).

## Editar preços / produtos / Pix

Tudo fica em [`data.json`](data.json):

- `pix`: chave (telefone no formato `+55DDDNUMERO`), nome (até 25 caracteres, sem acento) e cidade (até 15).
- `precificacao`: `margem` (0.20 = 20%) e `arredondamento` (0.25 = sempre arredonda pra cima de R$ 0,25 em R$ 0,25).
  - `kit`: o "leve mais por menos". Cada produto ganha uma linha de kit com `quantidade` unidades (3) a um preço calculado com a `margem` do kit (0.10 = 10%). A linha só aparece nos produtos com `"kit": true`, quando o kit sai mais barato que a unidade e o produto não tem preço fixo. Na mensagem do Pix vai o total de unidades (avulsas + kits).
- `doacao`: antes do Pix, pergunta se a pessoa quer doar `valor` (fixo) pra `nome`. Tem um "não perguntar mais" que fica salvo no navegador da pessoa. `"ativo": false` desliga pra todo mundo.
- `contato.whatsapp`: número (com DDI e DDD) do banner no fim da lista. O texto pronto da mensagem fica em `textos.json` → `banner.mensagemPronta`. Sem número, o banner some. O banner inteiro é o link.
- `produtos`: cada item tem `id`, `nome`, `detalhe`, `emoji`, `categoria`, `ativo` e `compras`.
  - O `id` (curto, ~4 letras, único) vai na mensagem do Pix pra contabilizar as vendas, ex.: `2KKAT 3LILI 1FINI D0.75` (`D` = doação). A mensagem tem limite de ~59 caracteres; carrinhos gigantes são cortados no fim.
  - **Repôs estoque?** Adicione uma linha em `compras` com o que pagou e quantas unidades vieram:
    `{ "data": "2026-11-01", "valor": 83.52, "unidades": 24 }`
  - O preço é calculado sozinho: (soma dos valores ÷ soma das unidades) × (1 + margem), arredondado pra cima.
  - Quer forçar um preço? Coloque `"preco": 5.00` no produto, que ele tem prioridade sobre o cálculo.
  - Acabou o estoque? Coloque `"esgotado": true`: o item continua na lista, mas cinza, com o selo "esgotado!" e sem os botões. Já `"ativo": false` tira o item da lista.
  - `precoAraujo`: preço do mesmo item na Araujo. Aparece riscado à esquerda do nosso só quando é maior; `null` ou menor/igual não mostra nada.
  - `"geladeira": true` marca o que fica na geladeira: se a compra tiver algum, a tela final usa os textos de `obrigadoGeladeira` (lembrete de repor) em vez de `obrigado`.
  - A ordem no arquivo é a ordem na página; categorias aparecem na ordem do primeiro item de cada uma.

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
