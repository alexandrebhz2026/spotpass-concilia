# SpotPass Concilia

Aplicação web independente para conciliação de transações PagBank usando o EDI oficial e as condições comerciais informadas nos prints da conta SpotPass.

## Hospedagem
Preparado para Deno Deploy / Fresh.

## Variáveis privadas
Configure no Deno Deploy e **não** grave no GitHub:

- `APP_PASSWORD`: senha compartilhada para acesso da equipe.
- `PAGBANK_EDI_USER`: usuário da API EDI PagBank.
- `PAGBANK_EDI_TOKEN`: token da API EDI PagBank.
- `AUTH_SECRET` (opcional): segredo adicional para assinatura da sessão. Se não existir, o app usa `APP_PASSWORD`.

## Taxas contratuais cadastradas
- Débito Visa / Mastercard / Elo: **1,04%**
- Débito demais bandeiras do grupo: **2,39%**
- PIX: **0,10%**
- Crédito Visa / Mastercard 1x: **3,11%**
- Crédito Elo 1x: **3,39%**
- Crédito Diners 1x: **3,19%**
- Crédito Hipercard / grupo 1x: **3,71%**
- Crédito Visa / Mastercard / Elo 2x–6x: **2,55%**
- Crédito Hipercard / grupo 2x–6x: **3,00%**
- Crédito Diners 2x–18x: **3,79%**
- Crédito demais grupo 7x–18x: **5,59%**
- Vendas parceladas: **acréscimo de 1,55%/mês**

## Regra importante
**Não há taxa de antecipação cadastrada.** O acréscimo de **1,55%/mês** mostrado nos prints é tratado como regra de vendas parceladas, separada do MDR base.

Até a fórmula exata desse acréscimo ser calibrada contra uma transação parcelada real do EDI, transações parceladas são exibidas e auditadas, mas não compõem automaticamente o valor “a recuperar”. Isso evita apontar cobrança legítima como divergência.

## Segurança
O EDI é consultado no servidor. USER/TOKEN não são enviados ao navegador.


Release candidate v1.4
