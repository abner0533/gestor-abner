# Gestor Abner

MVP local para capturar demandas em linguagem natural, inferir urgencia/prazo/esforco e gerar uma fila de foco para o dia.

## Como abrir

```bash
npm start
```

Depois acesse:

```text
http://localhost:8788
```

## Como usar

1. Escreva a demanda do jeito que ela apareceu na sua cabeca.
2. Se preferir, clique em `Falar demanda` e dite o texto.
3. Deixe a conta em `Auto` ou escolha Bluma, Luzem Joias, Chloe Brand, Nicolas iPhone ou Egovest.
4. Deixe a urgencia em `Auto` ou marque uma das opcoes.
5. Use `Alta depois` quando a demanda for importante, mas nao couber na semana.
6. Clique em `Lancar demanda`.
7. Confira a secao `Semana` para ver em qual dia cada demanda foi alocada.
8. Clique em `Criar semana` para enviar os blocos dos proximos dias uteis ao Google Calendar/Tasks.
9. Use `Concluir`, `Nao rolou`, `Proxima semana` ou `Trazer pra semana` para replanejar.

Os dados ficam salvos localmente em `data/tasks.json`.
As credenciais e tokens do Google Calendar ficam locais em `data/google-oauth-client.json` e `data/google-calendar-token.json`, ambos ignorados pelo git.

Para a agenda funcionar completa, o projeto do Google Cloud precisa ter `Google Calendar API` e `Google Tasks API` ativadas. No OAuth, use os escopos:

```text
https://www.googleapis.com/auth/calendar.freebusy
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/tasks
```

Se a `Google Tasks API` ainda nao estiver ativa, o gestor cria os blocos no Calendar e marca as demandas como `Calendar ok`; depois de ativar a Tasks API, clique em `Criar semana` de novo para criar as tarefas pendentes.

## Auto-reagendamento

Se uma reuniao ou bloqueio externo aparecer em cima de um bloco criado pelo gestor, ele recalcula a semana e move a demanda para o proximo horario livre possivel no mesmo dia ou em outro dia util.

O modo mais inteligente usa notificacoes push do Google Calendar. Para isso, o gestor precisa estar acessivel por uma URL publica HTTPS. Configure uma destas variaveis antes de iniciar:

```bash
GOOGLE_CALENDAR_WEBHOOK_URL=https://seu-dominio.com/webhooks/google-calendar
```

ou:

```bash
PUBLIC_WEBHOOK_BASE_URL=https://seu-dominio.com
```

Depois, chame `POST /api/calendar/watch` uma vez para ativar/renovar o canal de notificacao. Quando o Google avisar que a agenda mudou, o gestor roda a verificacao na hora.

Como este MVP roda no computador local, ele tambem mantem uma checagem de backup a cada 30 minutos enquanto o servidor estiver aberto. Essa checagem e so uma protecao caso nao exista URL publica ou caso uma notificacao seja perdida.

Para mudar o intervalo, inicie com a variavel `AUTO_RESCHEDULE_INTERVAL_MS`. Para desligar temporariamente, use `AUTO_RESCHEDULE_DISABLED=true`.

## Gemini opcional

O gestor funciona sem Gemini usando o analisador local. Para ligar a melhoria real de texto com Gemini, crie o arquivo `data/gemini-config.json`:

```json
{
  "apiKey": "SUA_CHAVE_DO_GEMINI",
  "model": "gemini-3.7-flash",
  "fallbackModels": ["gemini-3.5-flash", "gemini-flash-lite-latest"],
  "enabled": true
}
```

Outra opcao e iniciar o app com a variavel `GEMINI_API_KEY` configurada. O arquivo `data/gemini-config.json` fica local e ignorado pelo git.

Com o Gemini ativo, toda demanda nova passa automaticamente por uma revisao de texto ao ser lancada, sem precisar clicar em outro botao. Ele melhora titulo, descricao, passos e palavras-chave. Se o modelo principal estiver sobrecarregado, o gestor tenta modelos de fallback antes de desistir. O Gemini nao decide urgencia, prazo, cliente, esforco ou agenda; essa parte continua sendo controlada pelo gestor local.

## O que ja faz

- Captura simples sem varios campos.
- Captura por voz quando o navegador suporta reconhecimento de fala.
- Separa demandas por conta/cliente.
- Infere urgencia quando voce deixa em `Auto`.
- Mantem a diferenca entre baixa prioridade e prioridade alta planejada para depois.
- Sugere prazo com base em palavras como `hoje`, `amanha`, `sexta`, `sem pressa`.
- Estima esforco por tipo de demanda.
- Gera uma versao mais clara da demanda com analisador local e, se configurado, com Gemini.
- Monta o plano do dia em blocos de foco respeitando 9h-19h, Bluma a partir das 10h e almoco 12h-14h.
- Monta uma semana util rolante, distribuindo demandas por urgencia, prazo, esforco e horarios livres.
- Permite bloquear horarios manualmente para reunioes ou compromissos.
- Conecta com Google Calendar via OAuth, le a agenda e usa eventos externos para travar horarios automaticamente.
- Envia demandas planejadas como blocos fechados no Google Calendar e cria uma tarefa equivalente no Google Tasks.
- Reagenda automaticamente blocos do gestor quando uma reuniao externa entra no mesmo horario.
- Ao concluir no gestor, marca a Google Task como concluida e atualiza o bloco do Calendar como concluido.
- Pergunta o que aconteceu quando a tarefa nao rolou e replaneja.

## Proximos passos naturais

- Enviar lembretes no celular.
- Plugar uma IA real para quebrar tarefas e negociar prazos.
- Criar rotina de fechamento do dia e planejamento do dia seguinte.
