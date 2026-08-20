import http from 'node:http';
import { readFile, writeFile, mkdir, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'tasks.json');
const googleCredentialFile = path.join(dataDir, 'google-oauth-client.json');
const googleTokenFile = path.join(dataDir, 'google-calendar-token.json');
const geminiConfigFile = path.join(dataDir, 'gemini-config.json');
const port = Number(process.env.PORT || 8788);
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'gestor-abner';
let mongoDbPromise = null;

async function getMongoDb() {
  if (!MONGODB_URI) return null;
  if (!mongoDbPromise) {
    const client = new MongoClient(MONGODB_URI);
    mongoDbPromise = client.connect().then((connected) => connected.db(MONGODB_DB_NAME));
  }
  return mongoDbPromise;
}
const ANALYSIS_VERSION = 2;
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const DEFAULT_GEMINI_FALLBACK_MODELS = ['gemini-3.5-flash', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'];
const AUTO_RESCHEDULE_INTERVAL_MS = Math.max(60000, Number(process.env.AUTO_RESCHEDULE_INTERVAL_MS || 30 * 60 * 1000));
const GOOGLE_CALENDAR_WEBHOOK_PATH = '/webhooks/google-calendar';
const GOOGLE_CALENDAR_WATCH_TTL_MS = Math.max(60 * 60 * 1000, Number(process.env.GOOGLE_CALENDAR_WATCH_TTL_MS || 6 * 24 * 60 * 60 * 1000));
const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks'
];
const CALENDAR_CACHE_MS = 90 * 1000;
const GOOGLE_TASK_LIST_TITLE = 'Gestor Abner';
const GOOGLE_SOURCE = 'gestor-abner';
const googleEventColorByUrgency = {
  fire: '11',
  high: '5',
  later: '3',
  normal: '9',
  low: '10'
};
const calendarCache = new Map();
const pendingGoogleStates = new Map();
let autoRescheduleInFlight = false;

const urgencyConfig = {
  auto: { label: 'Auto', weight: 48, dueDays: 3 },
  fire: { label: 'Muito urgente', weight: 95, dueDays: 0 },
  high: { label: 'Alta', weight: 76, dueDays: 1 },
  later: { label: 'Alta depois', weight: 58, dueDays: 10 },
  normal: { label: 'Normal', weight: 48, dueDays: 4 },
  low: { label: 'Baixa', weight: 22, dueDays: 14 }
};

const accountConfig = [
  { id: 'bluma', label: 'Bluma', type: 'company', earliest: '10:00', latest: '19:00', weight: 1.15 },
  { id: 'luzem-joias', label: 'Luzem Joias', type: 'client', earliest: '09:00', latest: '19:00', weight: 1 },
  { id: 'chloe-brand', label: 'Chloe Brand', type: 'client', earliest: '09:00', latest: '19:00', weight: 1 },
  { id: 'nicolas-iphone', label: 'Nicolas iPhone', type: 'client', earliest: '09:00', latest: '19:00', weight: 1 },
  { id: 'egovest', label: 'Egovest', type: 'client', earliest: '09:00', latest: '19:00', weight: 1 },
  { id: 'geral', label: 'Geral', type: 'general', earliest: '09:00', latest: '19:00', weight: 0.92 }
];

const accountMap = new Map(accountConfig.map((account) => [account.id, account]));

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

async function ensureStore() {
  if (MONGODB_URI) {
    await getMongoDb();
    return;
  }
  await mkdir(dataDir, { recursive: true });
  try {
    await stat(dataFile);
  } catch {
    await writeFile(dataFile, JSON.stringify({ tasks: [], settings: defaultSettings() }, null, 2));
  }
}

function defaultSettings() {
  return {
    workdayStart: '09:00',
    blumaStart: '10:00',
    lunchStart: '12:00',
    lunchEnd: '14:00',
    workdayEnd: '19:00',
    focusBlockMinutes: 75,
    quickBlockMinutes: 30,
    busyBlocks: []
  };
}

async function readStore() {
  await ensureStore();
  let parsed = {};
  if (MONGODB_URI) {
    const db = await getMongoDb();
    parsed = (await db.collection('store').findOne({ _id: 'tasks' })) || {};
  } else {
    const raw = await readFile(dataFile, 'utf8');
    parsed = JSON.parse(raw || '{}');
  }
  return {
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    settings: normalizeSettings(parsed.settings)
  };
}

function normalizeSettings(settings = {}) {
  const merged = { ...defaultSettings(), ...settings };
  if (!settings.blumaStart) merged.blumaStart = '10:00';
  if (settings.workdayEnd === '18:00') merged.workdayEnd = '19:00';
  if (settings.lunchEnd === '13:30') merged.lunchEnd = '14:00';
  merged.busyBlocks = Array.isArray(merged.busyBlocks) ? merged.busyBlocks : [];
  return merged;
}

async function writeStore(store) {
  await ensureStore();
  if (MONGODB_URI) {
    const db = await getMongoDb();
    await db.collection('store').replaceOne({ _id: 'tasks' }, { _id: 'tasks', ...store }, { upsert: true });
    return;
  }
  await writeFile(dataFile, JSON.stringify(store, null, 2));
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2));
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function html(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function todayISO(base = new Date()) {
  return formatISODate(base);
}

function formatISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDaysISO(isoDate, days) {
  const date = parseISODate(isoDate);
  date.setDate(date.getDate() + days);
  return formatISODate(date);
}

function nextWeekStartISO(baseISO = todayISO()) {
  const base = parseISODate(baseISO);
  const current = base.getDay();
  const delta = current === 0 ? 1 : 8 - current;
  base.setDate(base.getDate() + delta);
  return formatISODate(base);
}

function parseISODate(isoDate) {
  const [year, month, day] = String(isoDate).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function minutesFromTime(time) {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + m;
}

function timeFromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function daysBetween(aISO, bISO) {
  const a = parseISODate(aISO);
  const b = parseISODate(bISO);
  return Math.round((parseISODate(formatISODate(a)) - parseISODate(formatISODate(b))) / 86400000);
}

function nextWeekdayISO(baseISO, weekday) {
  const base = parseISODate(baseISO);
  const current = base.getDay();
  let delta = (weekday - current + 7) % 7;
  if (delta === 0) delta = 7;
  base.setDate(base.getDate() + delta);
  return formatISODate(base);
}

function inferUrgency(raw, selectedUrgency = 'auto') {
  if (selectedUrgency && selectedUrgency !== 'auto' && urgencyConfig[selectedUrgency]) {
    return {
      urgency: selectedUrgency,
      confidence: 'manual',
      reason: `urgencia marcada como ${urgencyConfig[selectedUrgency].label.toLowerCase()}`
    };
  }

  const text = normalizeText(raw);
  if (/\b(agora|hoje|urgente|pra ontem|imediato|critico|critica|travou|bloqueia|bloqueando)\b/.test(text)) {
    return { urgency: 'fire', confidence: 'detected', reason: 'texto indica impacto imediato' };
  }
  if (/\b(nao da essa semana|nao cabe essa semana|semana que vem|proxima semana|alta mas depois|importante mas nao agora|mais pra frente)\b/.test(text)) {
    return { urgency: 'later', confidence: 'detected', reason: 'texto indica prioridade alta fora da semana atual' };
  }
  if (/\b(amanha|essa semana|esta semana|importante|prioridade|preciso entregar|ate sexta|ate amanha)\b/.test(text)) {
    return { urgency: 'high', confidence: 'detected', reason: 'texto indica entrega proxima' };
  }
  if (/\b(sem pressa|quando der|baixa prioridade|algum dia|ideia|backlog)\b/.test(text)) {
    return { urgency: 'low', confidence: 'detected', reason: 'texto indica baixa pressao' };
  }
  return { urgency: 'normal', confidence: 'assumed', reason: 'sem prazo claro, entrou como normal' };
}

function inferDueDate(raw, urgency, baseISO = todayISO()) {
  const text = normalizeText(raw);
  const weekdayMap = [
    ['domingo', 0],
    ['segunda', 1],
    ['terca', 2],
    ['quarta', 3],
    ['quinta', 4],
    ['sexta', 5],
    ['sabado', 6]
  ];

  if (/\b(hoje|agora|pra ontem)\b/.test(text)) {
    return { dueDate: baseISO, reason: 'prazo citado para hoje' };
  }
  if (/\b(amanha|amanhã)\b/.test(raw.toLowerCase())) {
    return { dueDate: addDaysISO(baseISO, 1), reason: 'prazo citado para amanha' };
  }
  if (/\b(fim da semana|final da semana)\b/.test(text)) {
    return { dueDate: nextWeekdayISO(baseISO, 5), reason: 'prazo citado para o fim da semana' };
  }
  if (/\b(semana que vem|proxima semana|próxima semana)\b/.test(raw.toLowerCase())) {
    return { dueDate: nextWeekStartISO(baseISO), reason: 'prazo citado para proxima semana' };
  }

  for (const [word, weekday] of weekdayMap) {
    if (new RegExp(`\\b(ate|para|pra|na|no)?\\s*${word}\\b`).test(text)) {
      return { dueDate: nextWeekdayISO(baseISO, weekday), reason: `prazo citado para ${word}` };
    }
  }

  const days = urgencyConfig[urgency]?.dueDays ?? urgencyConfig.normal.dueDays;
  if (urgency === 'later') {
    return {
      dueDate: addDaysISO(baseISO, days),
      reason: 'prazo sugerido para prioridade alta fora da semana atual'
    };
  }
  return {
    dueDate: addDaysISO(baseISO, days),
    reason: `prazo sugerido pela urgencia ${urgencyConfig[urgency]?.label.toLowerCase() || 'normal'}`
  };
}

function inferEffort(raw) {
  const text = normalizeText(raw);
  const hourMatch = text.match(/\b(\d{1,2})\s*(h|hora|horas)\b/);
  if (hourMatch) {
    return {
      minutes: Math.max(20, Math.min(300, Number(hourMatch[1]) * 60)),
      reason: 'tempo citado na demanda'
    };
  }
  const minuteMatch = text.match(/\b(\d{2,3})\s*(min|minuto|minutos)\b/);
  if (minuteMatch) {
    return {
      minutes: Math.max(15, Math.min(240, Number(minuteMatch[1]))),
      reason: 'tempo citado na demanda'
    };
  }

  const rules = [
    [/\b(briefing|criativo|criativos|roteiro|copy|copys|anuncio|anuncios)\b/, 90, 'criativos normalmente pedem bloco de foco'],
    [/\b(relatorio|dashboard|analise|analisar|diagnostico|kpi|metricas|dados)\b/, 120, 'analise costuma exigir bloco maior'],
    [/\b(implementar|desenvolver|construir|criar|montar|configurar|integrar)\b/, 120, 'construcao costuma exigir bloco maior'],
    [/\b(revisar|ajustar|corrigir|alterar|subir|publicar)\b/, 60, 'ajuste costuma caber em bloco medio'],
    [/\b(reuniao|call|alinhamento|responder|mensagem|email|whatsapp)\b/, 30, 'comunicacao costuma caber em bloco curto']
  ];

  for (const [pattern, minutes, reason] of rules) {
    if (pattern.test(text)) return { minutes, reason };
  }

  if (raw.length > 180) return { minutes: 90, reason: 'demanda longa, reservado bloco de foco' };
  if (raw.length < 70) return { minutes: 45, reason: 'demanda curta, reservado bloco medio' };
  return { minutes: 75, reason: 'estimativa padrao para demanda sem escopo claro' };
}

function inferProject(raw) {
  const original = String(raw || '').trim();
  const text = normalizeText(original);
  const patterns = [
    /\bcliente\s+([a-z0-9][a-z0-9\s.-]{1,32})/i,
    /\bpara\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ0-9 .-]{1,32})/,
    /#([\wÀ-ÿ0-9_-]{2,32})/
  ];

  for (const pattern of patterns) {
    const match = original.match(pattern);
    if (match?.[1]) {
      return cleanupTitle(match[1]).slice(0, 36);
    }
  }

  if (/\b(empresa principal|trabalho|operacao|time interno|interno)\b/.test(text)) return 'Empresa principal';
  return 'Geral';
}

function inferAccount(raw, selectedAccountId = 'auto') {
  if (selectedAccountId && selectedAccountId !== 'auto' && accountMap.has(selectedAccountId)) {
    const account = accountMap.get(selectedAccountId);
    return {
      id: account.id,
      label: account.label,
      type: account.type,
      source: 'manual',
      reason: `conta marcada como ${account.label}`
    };
  }

  const text = normalizeText(raw);
  const matches = [
    ['bluma', /\b(bluma|empresa principal|time interno|operacao interna)\b/],
    ['luzem-joias', /\b(luzem|luzem joias|luzem joias)\b/],
    ['chloe-brand', /\b(chloe|chloe brand)\b/],
    ['nicolas-iphone', /\b(nicolas iphone|nicolas|cliente nicolas)\b/],
    ['egovest', /\b(egovest)\b/]
  ];

  for (const [id, pattern] of matches) {
    if (pattern.test(text)) {
      const account = accountMap.get(id);
      return {
        id: account.id,
        label: account.label,
        type: account.type,
        source: 'detected',
        reason: `texto indica conta ${account.label}`
      };
    }
  }

  const project = inferProject(raw);
  if (project && project !== 'Geral' && project !== 'Empresa principal') {
    return {
      id: 'geral',
      label: project,
      type: 'client',
      source: 'detected',
      reason: `texto indica cliente ${project}`
    };
  }

  const account = accountMap.get('geral');
  return {
    id: account.id,
    label: account.label,
    type: account.type,
    source: 'assumed',
    reason: 'sem conta clara, entrou como Geral'
  };
}

function resolveAccount(task) {
  if (task.accountId && accountMap.has(task.accountId)) {
    const account = accountMap.get(task.accountId);
    return { ...account, label: task.accountLabel || account.label, source: task.accountSource || 'saved' };
  }
  if (task.accountId && task.accountLabel) {
    return {
      id: task.accountId,
      label: task.accountLabel,
      type: task.accountType || 'client',
      earliest: '09:00',
      latest: '19:00',
      weight: 1,
      source: task.accountSource || 'saved'
    };
  }
  return {
    ...inferAccount(`${task.raw || ''} ${task.project || ''}`),
    earliest: undefined,
    latest: undefined,
    weight: undefined
  };
}

function accountRules(account, settings) {
  const known = accountMap.get(account.id);
  const earliest = known?.earliest || account.earliest || settings.workdayStart;
  const latest = known?.latest || account.latest || settings.workdayEnd;
  return {
    earliest: account.id === 'bluma' ? settings.blumaStart || earliest : earliest,
    latest
  };
}

function inferTitle(raw) {
  const clean = cleanupTitle(String(raw || ''));
  const firstSentence = clean.split(/[.!?]/)[0]?.trim() || clean;
  const title = firstSentence
    .replace(/^(preciso|tenho que|tenho de|fazer|criar|montar|desenvolver)\s+/i, '')
    .trim();
  if (title.length <= 86) return title || 'Demanda sem titulo';
  return `${title.slice(0, 83).trim()}...`;
}

function cleanupTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .trim();
}

function enhanceDemand(raw) {
  const clean = cleanupTitle(raw);
  const text = normalizeText(clean);
  const baseTitle = inferTitle(clean);
  const keywords = inferKeywords(text);

  if (isPaidMediaCampaign(text)) {
    return enhancePaidMediaCampaign(clean, text, keywords);
  }

  if (/\b(concorrente|concorrentes|biblioteca de anuncios|biblioteca|criativos de concorrentes)\b/.test(text)) {
    const market = inferCompetitorMarket(clean);
    return {
      title: 'Analisar biblioteca de anuncios de concorrentes',
      summary: market
        ? `Mapear anuncios de concorrentes no mercado de ${market}, separar padroes de oferta, criativo, copy e oportunidade para novos briefings.`
        : 'Mapear anuncios de concorrentes, separar padroes de oferta, criativo, copy e oportunidade para novos briefings.',
      steps: [
        'Listar concorrentes diretos e similares para pesquisar.',
        'Buscar anuncios ativos e recentes na biblioteca de anuncios.',
        'Separar referencias por gancho, oferta, formato, CTA e promessa.',
        'Transformar os achados em hipoteses para novos criativos.'
      ],
      keywords: unique(['concorrentes', 'biblioteca de anuncios', 'criativos', 'copy', 'oferta', ...keywords])
    };
  }

  if (/\b(briefing|briefings|criativo|criativos|designer|freela|copy|cta|lp|lps|landing)\b/.test(text)) {
    const isLp = /\b(lp|lps|landing|pagina)\b/.test(text);
    return {
      title: isLp ? 'Desenvolver briefing de LP com copy e CTA' : 'Desenvolver briefings de novos criativos',
      summary: isLp
        ? 'Criar briefing de landing page com estrutura, promessa principal, copy persuasiva, CTA claro e criterios de revisao.'
        : 'Criar briefings de criativos com objetivo, publico, angulo de comunicacao, copy, referencia visual e entregaveis por etapa do funil.',
      steps: isLp
        ? [
            'Definir objetivo da LP e oferta principal.',
            'Escrever promessa, secoes, provas e objecoes a responder.',
            'Definir CTA principal e CTAs secundarios.',
            'Listar referencias e criterios de aprovacao.'
          ]
        : [
            'Separar pecas por topo, meio e fundo de funil.',
            'Definir angulo, promessa e CTA de cada peca.',
            'Adicionar referencias visuais e observacoes para o designer.',
            'Fechar lista de entregaveis e ordem de producao.'
          ],
      keywords: unique(['briefing', 'copy', 'cta', 'referencias', 'funil', ...keywords])
    };
  }

  if (/\b(quiz|qualificacao|qualificacao de usuarios)\b/.test(text) || /\b(lancar|publicar)\b.*\b(backend|layout)\b.*\bsite\b/.test(text)) {
    return {
      title: 'Lancar quiz de qualificacao de usuarios',
      summary: 'Finalizar layout, fluxo, backend e publicacao do quiz para capturar e qualificar usuarios no site.',
      steps: [
        'Fechar perguntas e criterios de qualificacao.',
        'Finalizar layout e estados do quiz.',
        'Implementar backend, envio e armazenamento das respostas.',
        'Publicar no site e validar o fluxo completo.'
      ],
      keywords: unique(['quiz', 'qualificacao', 'layout', 'backend', 'site', ...keywords])
    };
  }

  if (/\b(seo|organico|rankear|ranking|palavra-chave|palavras-chave)\b/.test(text)) {
    return {
      title: 'Auditar SEO do site e priorizar melhorias',
      summary: 'Analisar estrutura, conteudo, palavras-chave e pontos tecnicos do site para montar uma lista priorizada de melhorias.',
      steps: [
        'Levantar paginas principais e termos de busca relevantes.',
        'Checar titulos, descricoes, headings, links internos e velocidade.',
        'Comparar oportunidades de conteudo e intencao de busca.',
        'Criar plano de ajustes por impacto e esforco.'
      ],
      keywords: unique(['seo', 'site', 'palavras-chave', 'conteudo', 'tecnico', ...keywords])
    };
  }

  if (isPaidMediaSpreadsheet(text)) {
    return {
      title: 'Preencher planilha de projecoes de midia paga',
      summary: 'Completar a planilha com calculos de projecao e comparacao de cadastros, pedidos e instalacoes vindos de midia paga, conferindo formulas e coerencia dos numeros.',
      steps: [
        'Abrir a planilha e identificar as abas ou campos pendentes.',
        'Preencher calculos de projecao para cadastros, pedidos e instalacoes.',
        'Comparar os cenarios e conferir se as formulas estao puxando os dados certos.',
        'Revisar os resultados finais e marcar pontos que precisam de validacao.'
      ],
      keywords: unique(['planilha', 'projecoes', 'cadastros', 'pedidos', 'instalacoes', 'midia paga', ...keywords])
    };
  }

  if (isPaidMediaPlanning(text)) {
    return {
      title: 'Construir plano de investimento de Ads',
      summary: 'Montar simulacao de investimento, metas de retorno, premissas de performance e cenarios de crescimento para tomada de decisao.',
      steps: [
        'Definir premissas de verba, CAC, ticket, margem e ROAS.',
        'Montar cenarios conservador, base e agressivo.',
        'Projetar investimento, receita esperada e payback.',
        'Separar riscos, dependencias e proximas decisoes.'
      ],
      keywords: unique(['ads', 'investimento', 'roas', 'retorno', 'cenarios', ...keywords])
    };
  }

  if (/\b(relatorio|dashboard|analise|analisar|kpi|metricas|dados|performance)\b/.test(text)) {
    return {
      title: baseTitle.startsWith('analisar') ? capitalizeFirst(baseTitle) : `Analisar ${baseTitle}`,
      summary: 'Revisar dados, identificar principais movimentos, apontar causas provaveis e transformar a analise em proximas acoes.',
      steps: [
        'Separar periodo, fontes e metricas principais.',
        'Comparar resultado atual contra meta ou periodo anterior.',
        'Identificar quedas, ganhos, gargalos e oportunidades.',
        'Registrar conclusoes e proximas acoes.'
      ],
      keywords: unique(['analise', 'performance', 'metricas', 'acoes', ...keywords])
    };
  }

  return {
    title: capitalizeFirst(baseTitle),
    summary: `Transformar a demanda "${baseTitle}" em uma proxima acao clara, com criterio de pronto e bloco de foco definido.`,
    steps: [
      'Definir o resultado esperado.',
      'Separar informacoes ou arquivos necessarios.',
      'Executar a primeira versao da entrega.',
      'Revisar e marcar como concluida.'
    ],
    keywords
  };
}

function isPaidMediaCampaign(text) {
  const hasCampaignObject = /\b(campanha|campanhas|conjunto|adset|anuncio|anuncios|ads|meta ads|facebook ads|google ads|pmax|search|display)\b/.test(text);
  const hasExecutionAction = /\b(subir|lancar|ativar|publicar|configurar|criar|duplicar|pausar|revisar|ajustar|corrigir|otimizar)\b/.test(text);
  const hasOffer = /\b(voucher|cupom|desconto|primeira compra|oferta|promocao|promo)\b/.test(text);
  return hasCampaignObject && (hasExecutionAction || hasOffer);
}

function isPaidMediaPlanning(text) {
  const hasPlanning = /\b(plano|planejamento|projecao|projetar|simulacao|simular|investimento|orcamento|verba|retorno|roas|cac|pedidos|receita|2027|2028)\b/.test(text);
  const hasMedia = /\b(ads|midia|trafego|meta|google|campanha|campanhas)\b/.test(text);
  return hasPlanning && hasMedia;
}

function isPaidMediaSpreadsheet(text) {
  const hasSpreadsheet = /\b(planilha|calculo|calculos|calcular|preencher|comparacao|comparar)\b/.test(text);
  const hasProjection = /\b(projecao|projecoes|pedidos|cadastros|instalacoes|instalacao)\b/.test(text);
  const hasMedia = /\b(midia paga|ads|trafego|campanha|campanhas|meta|google)\b/.test(text);
  return hasSpreadsheet && hasProjection && hasMedia;
}

function enhancePaidMediaCampaign(clean, text, keywords) {
  const action = inferCampaignAction(text);
  const platform = inferAdPlatform(text);
  const offer = inferOffer(text);
  const titleObject = offer ? `campanha de ${offer}` : inferCampaignObject(text);
  const platformSuffix = platform ? ` no ${platform}` : '';
  const title = `${action.title} ${titleObject}${platformSuffix}`;
  const actionVerb = action.summaryVerb;
  const channel = platform || 'gerenciador de anuncios';
  const setupStep = action.kind === 'review'
    ? `Abrir a campanha no ${channel} e conferir objetivo, publico, posicionamentos, orcamento e status.`
    : `Configurar campanha, conjunto e anuncio no ${channel} com objetivo, publico, posicionamentos e orcamento.`;
  const creativeStep = action.kind === 'review'
    ? 'Conferir criativos, copy, CTA, URL final e UTMs antes de ativar ou manter a campanha rodando.'
    : 'Inserir criativos, copy, CTA, URL final e UTMs corretas.';

  return {
    title,
    summary: `${actionVerb} ${titleObject}${platformSuffix}, garantindo objetivo, publico, verba, criativos/copy, rastreamento e regra da oferta antes de deixar ativo.`,
    steps: [
      offer ? `Confirmar regra da oferta: ${offer}, validade, elegibilidade e pagina de destino.` : 'Confirmar objetivo da campanha, oferta, pagina de destino e criterio de sucesso.',
      setupStep,
      creativeStep,
      'Validar pixel/evento de conversao, preview do anuncio e ausencia de conflito com campanhas ativas.',
      action.finalStep
    ],
    keywords: unique(['campanha', platform || 'ads', offer, 'criativos', 'rastreamento', ...keywords])
  };
}

function inferCampaignAction(text) {
  if (/\b(revisar|auditar|validar)\b/.test(text)) {
    return {
      kind: 'review',
      title: 'Revisar',
      summaryVerb: 'Revisar',
      finalStep: 'Registrar ajustes encontrados e decidir se a campanha pode seguir ativa.'
    };
  }
  if (/\b(otimizar|melhorar)\b/.test(text)) {
    return {
      kind: 'optimize',
      title: 'Otimizar',
      summaryVerb: 'Otimizar',
      finalStep: 'Aplicar ajustes e anotar o que deve ser monitorado nas proximas 24-48h.'
    };
  }
  if (/\b(corrigir|ajustar|alterar)\b/.test(text)) {
    return {
      kind: 'adjust',
      title: 'Ajustar',
      summaryVerb: 'Ajustar',
      finalStep: 'Salvar alteracoes e conferir se a campanha ficou pronta para rodar sem erro.'
    };
  }
  if (/\b(criar|configurar|montar)\b/.test(text)) {
    return {
      kind: 'setup',
      title: 'Configurar',
      summaryVerb: 'Configurar',
      finalStep: 'Publicar somente depois do checklist de configuracao e tracking.'
    };
  }
  return {
    kind: 'launch',
    title: 'Subir',
    summaryVerb: 'Configurar e publicar',
    finalStep: 'Publicar a campanha e conferir se ficou em revisao/ativa sem erro.'
  };
}

function inferAdPlatform(text) {
  if (/\b(meta ads|facebook ads|facebook|instagram|ig|fb)\b/.test(text)) return 'Meta Ads';
  if (/\b(google ads|pmax|performance max|search|display|youtube ads)\b/.test(text)) return 'Google Ads';
  if (/\b(tiktok|tik tok)\b/.test(text)) return 'TikTok Ads';
  if (/\b(linkedin ads|linkedin)\b/.test(text)) return 'LinkedIn Ads';
  return '';
}

function inferOffer(text) {
  if (/\b(voucher)\b/.test(text) && /\b(primeira compra)\b/.test(text)) return 'voucher de primeira compra';
  if (/\b(cupom)\b/.test(text) && /\b(primeira compra)\b/.test(text)) return 'cupom de primeira compra';
  if (/\b(desconto)\b/.test(text) && /\b(primeira compra)\b/.test(text)) return 'desconto de primeira compra';
  if (/\b(primeira compra)\b/.test(text)) return 'oferta de primeira compra';
  if (/\b(voucher)\b/.test(text)) return 'voucher';
  if (/\b(cupom)\b/.test(text)) return 'cupom';
  if (/\b(desconto)\b/.test(text)) return 'desconto';
  if (/\b(black friday)\b/.test(text)) return 'Black Friday';
  if (/\b(promocao|promo)\b/.test(text)) return 'promocao';
  return '';
}

function inferCampaignObject(text) {
  if (/\b(anuncio|anuncios)\b/.test(text)) return 'anuncio de midia paga';
  if (/\b(conjunto|adset)\b/.test(text)) return 'conjunto de anuncios';
  return 'campanha de Ads';
}

function inferKeywords(text) {
  const words = text
    .split(/[^a-z0-9-]+/i)
    .filter((word) => word.length > 3)
    .filter((word) => !['preciso', 'tenho', 'fazer', 'para', 'como', 'tambem', 'isso', 'esse', 'essa', 'onde', 'aonde'].includes(word));
  return unique(words).slice(0, 6);
}

function inferCompetitorMarket(raw) {
  const clean = cleanupTitle(raw);
  const match = clean.match(/\bmercado de ([^.]+)/i) || clean.match(/\bservicos semelhantes aos nossos \(([^)]+)\)/i);
  if (!match?.[1]) return '';
  return cleanupTitle(match[1])
    .replace(/\s+e de servi\S+ semelhantes aos nossos.*$/i, '')
    .replace(/\s*\([^)]*$/i, '')
    .replace(/\betc.*$/i, '')
    .replace(/[,;:]\s*$/i, '')
    .slice(0, 80);
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function capitalizeFirst(value) {
  const clean = cleanupTitle(value);
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'Demanda sem titulo';
}

async function readGeminiConfig() {
  const fileConfig = (await readJsonIfExists(geminiConfigFile)) || {};
  const apiKey = process.env.GEMINI_API_KEY || fileConfig.apiKey || fileConfig.key || '';
  const model = process.env.GEMINI_MODEL || fileConfig.model || DEFAULT_GEMINI_MODEL;
  const envFallbacks = String(process.env.GEMINI_FALLBACK_MODELS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const fileFallbacks = Array.isArray(fileConfig.fallbackModels) ? fileConfig.fallbackModels : [];
  const fallbackModels = unique([...envFallbacks, ...fileFallbacks, ...DEFAULT_GEMINI_FALLBACK_MODELS]).map(normalizeGeminiModel);
  return {
    configured: Boolean(apiKey),
    enabled: fileConfig.enabled !== false,
    apiKey,
    model: normalizeGeminiModel(model),
    fallbackModels
  };
}

async function geminiStatus() {
  const config = await readGeminiConfig();
  return {
    configured: config.configured,
    enabled: config.enabled && config.configured,
    model: config.model,
    fallbackModels: config.fallbackModels
  };
}

function normalizeGeminiModel(model) {
  return String(model || '').trim().replace(/^models\//, '') || DEFAULT_GEMINI_MODEL;
}

function geminiModelCandidates(config) {
  return unique([config.model, ...(config.fallbackModels || [])]).map(normalizeGeminiModel);
}

function shouldTryNextGeminiModel(status, message = '') {
  return [404, 429, 500, 502, 503, 504].includes(Number(status))
    || /\b(high demand|overloaded|unavailable|temporar|try again|no longer available)\b/i.test(message);
}

function geminiPrompt(raw, localAnalysis, context = {}) {
  return [
    'Voce e um gestor operacional para demandas de marketing, midia paga, criativos, SEO, produto e clientes.',
    'Sua tarefa e transformar uma demanda falada ou escrita de forma solta em texto claro para execucao.',
    '',
    'Regras:',
    '- Nao invente cliente, prazo, verba, plataforma, concorrente ou entrega que nao esteja no texto.',
    '- Preserve a intencao original.',
    '- Se o rascunho local contradizer ou for mais generico que a demanda original, ignore o rascunho local.',
    '- Nao reaproveite frases genericas de outras demandas; cite os objetos concretos presentes na demanda original.',
    '- Nao mude urgencia, prazo, conta/cliente ou esforco. Isso sera decidido pelo sistema local.',
    '- Escreva em portugues brasileiro, direto, sem tom corporativo exagerado.',
    '- O titulo deve ser uma acao objetiva com no maximo 90 caracteres.',
    '- O resumo deve explicar o que precisa ser feito e o criterio de pronto.',
    '- Os passos devem ser praticos e acionaveis.',
    '- Retorne somente JSON valido.',
    '',
    `Demanda original: ${raw}`,
    `Conta detectada: ${context.accountLabel || 'Geral'}`,
    `Urgencia local: ${context.urgencyLabel || 'Auto'}`,
    '',
    'Rascunho local atual, que pode estar errado:',
    JSON.stringify(
      {
        title: localAnalysis.title,
        summary: localAnalysis.summary,
        steps: localAnalysis.steps,
        keywords: localAnalysis.keywords
      },
      null,
      2
    ),
    '',
    'Formato exato:',
    '{"title":"...","summary":"...","steps":["..."],"keywords":["..."]}'
  ].join('\n');
}

function parseJsonFromText(text) {
  const clean = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error('Gemini nao retornou JSON valido.');
  }
}

function sanitizeGeminiAnalysis(payload, fallback) {
  const title = cleanupTitle(payload?.title || fallback.title).slice(0, 90) || fallback.title;
  const summary = cleanupTitle(payload?.summary || fallback.summary).slice(0, 520) || fallback.summary;
  const steps = Array.isArray(payload?.steps)
    ? payload.steps.map((step) => cleanupTitle(step).slice(0, 180)).filter(Boolean).slice(0, 6)
    : [];
  const keywords = Array.isArray(payload?.keywords)
    ? payload.keywords.map((keyword) => cleanupTitle(keyword).slice(0, 36)).filter(Boolean).slice(0, 10)
    : [];
  return {
    title,
    summary,
    steps: steps.length ? steps : fallback.steps,
    keywords: keywords.length ? unique(keywords) : fallback.keywords
  };
}

const geminiResponseSchema = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    summary: { type: 'STRING' },
    steps: {
      type: 'ARRAY',
      items: { type: 'STRING' }
    },
    keywords: {
      type: 'ARRAY',
      items: { type: 'STRING' }
    }
  },
  required: ['title', 'summary', 'steps', 'keywords']
};

async function askGeminiForDemand(raw, localAnalysis, context = {}) {
  const config = await readGeminiConfig();
  if (!config.configured || !config.enabled) return null;

  const errors = [];
  for (const model of geminiModelCandidates(config)) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: geminiPrompt(raw, localAnalysis, context) }]
          }
        ],
        generationConfig: {
          temperature: 0.25,
          responseMimeType: 'application/json',
          responseSchema: geminiResponseSchema
        }
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || 'Falha ao chamar Gemini.';
      errors.push(`${model}: ${message}`);
      if (shouldTryNextGeminiModel(response.status, message)) continue;
      throw new Error(message);
    }
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n') || '';
    return {
      analysis: sanitizeGeminiAnalysis(parseJsonFromText(text), localAnalysis),
      model
    };
  }
  throw new Error(errors[0] || 'Gemini indisponivel no momento.');
}

function applyGeminiToTask(task, analysis, model) {
  const now = new Date().toISOString();
  task.title = analysis.title;
  task.enhancedText = analysis.summary;
  task.steps = analysis.steps;
  task.keywords = analysis.keywords;
  task.aiProvider = 'gemini';
  task.aiModel = model;
  task.aiEnhancedAt = now;
  task.aiStatus = 'enhanced';
  task.googleSyncStatus = task.googleSyncStatus === 'synced' ? 'needs-sync' : task.googleSyncStatus;
  task.decision = { ...(task.decision || {}), ai: `texto melhorado com Gemini (${model})` };
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({ at: now, type: 'ai-enhance', note: `texto melhorado com Gemini (${model})` });
  task.updatedAt = now;
}

async function enhanceTaskWithGemini(task) {
  const localAnalysis = enhanceDemand(task.raw || task.title || '');
  const config = await readGeminiConfig();
  if (!config.configured || !config.enabled) {
    task.aiStatus = 'local';
    return { enhanced: false, error: null, missingConfig: true };
  }

  try {
    const result = await askGeminiForDemand(task.raw || task.title || '', localAnalysis, {
      accountLabel: task.accountLabel || task.project,
      urgencyLabel: urgencyConfig[task.urgency]?.label || task.urgency
    });
    if (result?.analysis) applyGeminiToTask(task, result.analysis, result.model || config.model);
    task.aiError = null;
    return { enhanced: Boolean(result?.analysis), error: null };
  } catch (error) {
    task.aiStatus = 'error';
    task.aiError = error.message || 'Falha ao melhorar com Gemini.';
    task.history = Array.isArray(task.history) ? task.history : [];
    task.history.push({ at: new Date().toISOString(), type: 'ai-error', note: task.aiError });
    return { enhanced: false, error: task.aiError };
  }
}

function createTask({ rawText, urgency: selectedUrgency, accountId: selectedAccountId }) {
  const raw = cleanupTitle(rawText);
  const now = new Date();
  const baseISO = todayISO(now);
  const urgency = inferUrgency(raw, selectedUrgency);
  const due = inferDueDate(raw, urgency.urgency, baseISO);
  const effort = inferEffort(raw);
  const analysis = enhanceDemand(raw);
  const account = inferAccount(raw, selectedAccountId);

  return {
    id: crypto.randomUUID(),
    raw,
    title: analysis.title,
    enhancedText: analysis.summary,
    steps: analysis.steps,
    keywords: analysis.keywords,
    analysisVersion: ANALYSIS_VERSION,
    project: account.label,
    accountId: account.id,
    accountLabel: account.label,
    accountType: account.type,
    accountSource: account.source,
    urgency: urgency.urgency,
    urgencySource: urgency.confidence,
    status: 'active',
    plannedFor: urgency.urgency === 'later' ? nextWeekStartISO(baseISO) : null,
    effortMinutes: effort.minutes,
    dueDate: due.dueDate,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
    postponedCount: 0,
    blockedCount: 0,
    decision: {
      account: account.reason,
      urgency: urgency.reason,
      due: due.reason,
      effort: effort.reason
    },
    history: [
      {
        at: now.toISOString(),
        type: 'created',
        note: 'demanda capturada'
      }
    ]
  };
}

async function createEnhancedTask(body) {
  const task = createTask(body);
  await enhanceTaskWithGemini(task);
  return task;
}

function scoreTask(task, targetISO = todayISO()) {
  const urgencyWeight = urgencyConfig[task.urgency]?.weight ?? urgencyConfig.normal.weight;
  const account = resolveAccount(task);
  const knownAccount = accountMap.get(account.id);
  const accountWeight = knownAccount?.weight ?? account.weight ?? 1;
  const dueDelta = daysBetween(task.dueDate, targetISO);
  const dueScore = dueDelta < 0 ? 70 + Math.abs(dueDelta) * 8 : Math.max(0, 40 - dueDelta * 8);
  const createdDelta = Math.max(0, daysBetween(targetISO, todayISO(new Date(task.createdAt))));
  const ageScore = Math.min(18, createdDelta * 2);
  const frictionPenalty = Math.min(18, (task.postponedCount || 0) * 5 + (task.blockedCount || 0) * 4);
  return Math.round((urgencyWeight + dueScore + ageScore - frictionPenalty) * accountWeight);
}

function statusForDue(task, targetISO = todayISO()) {
  const delta = daysBetween(task.dueDate, targetISO);
  if (task.urgency === 'later' && delta > 6) return 'proxima semana';
  if (delta < 0) return 'atrasada';
  if (delta === 0) return 'vence hoje';
  if (delta === 1) return 'vence amanha';
  return `vence em ${delta} dias`;
}

function activeTasks(tasks) {
  return tasks.filter((task) => task.status === 'active');
}

function isLaterTask(task, targetISO = todayISO()) {
  if (task.plannedFor && daysBetween(task.plannedFor, targetISO) > 0) return true;
  if (task.urgency === 'later' && daysBetween(task.dueDate, targetISO) > 0) return true;
  return false;
}

function isReadyForPlan(task, targetISO = todayISO()) {
  if (task.status !== 'active') return false;
  if (isLaterTask(task, targetISO)) return false;
  const dueDelta = daysBetween(task.dueDate, targetISO);
  if (dueDelta > 7 && !['fire', 'high'].includes(task.urgency)) return false;
  return true;
}

function buildPlan(tasks, settings, targetISO = todayISO()) {
  const focusBlock = Number(settings.focusBlockMinutes || 75);
  const quickBlock = Number(settings.quickBlockMinutes || 30);
  const now = new Date();
  let cursor = minutesFromTime(settings.workdayStart);
  if (targetISO === todayISO(now)) {
    const current = now.getHours() * 60 + now.getMinutes();
    cursor = Math.ceil(Math.max(current, cursor) / 15) * 15;
  }

  const ready = activeTasks(tasks).filter((task) => isReadyForPlan(task, targetISO));
  const candidates = ready
    .map((task) => ({
      ...enrichedTask(task),
      score: scoreTask(task, targetISO),
      dueStatus: statusForDue(task, targetISO)
    }))
    .sort((a, b) => b.score - a.score || new Date(a.createdAt) - new Date(b.createdAt));

  const blocks = [];
  const backlog = [];
  let lastAccountId = '';

  while (candidates.length) {
    const choice = chooseNextPlanTask(candidates, settings, targetISO, cursor, focusBlock, quickBlock, lastAccountId);
    if (!choice) {
      backlog.push(...candidates.splice(0));
      break;
    }
    const { task, placed, duration, index } = choice;
    candidates.splice(index, 1);
    blocks.push({
      id: `${task.id}-${blocks.length}`,
      taskId: task.id,
      title: task.title,
      enhancedText: task.enhancedText,
      steps: task.steps,
      project: task.project,
      accountId: task.accountId,
      accountLabel: task.accountLabel,
      accountType: task.accountType,
      urgency: task.urgency,
      score: task.score,
      dueDate: task.dueDate,
      dueStatus: task.dueStatus,
      effortMinutes: task.effortMinutes,
      duration,
      start: timeFromMinutes(placed.start),
      end: timeFromMinutes(placed.end),
      decision: task.decision
    });
    cursor = placed.end + 10;
    lastAccountId = task.accountId;
  }

  return {
    targetDate: targetISO,
    blocks,
    busy: busyBlocksForDate(settings, targetISO),
    overflow: backlog.length,
    next: blocks[0] || null,
    backlog,
    later: activeTasks(tasks)
      .filter((task) => isLaterTask(task, targetISO))
      .map((task) => taskView(task, targetISO))
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate)),
    stats: summarize(tasks, targetISO)
  };
}

function planningWeekDates(startISO = todayISO(), count = 5) {
  const dates = [];
  const cursor = parseISODate(startISO);
  while (dates.length < count) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) dates.push(formatISODate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function cloneSettings(settings) {
  const normalized = normalizeSettings(settings);
  return {
    ...normalized,
    busyBlocks: [...(normalized.busyBlocks || [])]
  };
}

function hasExplicitDue(task) {
  return Boolean(task.dueDate && task.decision?.due && !String(task.decision.due).includes('sugerido'));
}

function weekDateIndex(dates, targetISO) {
  const exact = dates.indexOf(targetISO);
  if (exact >= 0) return exact;
  const next = dates.findIndex((date) => daysBetween(date, targetISO) >= 0);
  return next >= 0 ? next : dates.length - 1;
}

function weekTaskBounds(task, dates) {
  const startISO = dates[0];
  const endISO = dates[dates.length - 1];
  const plannedFor = task.plannedFor && daysBetween(task.plannedFor, startISO) > 0 ? task.plannedFor : startISO;
  const earliestIndex = Math.max(0, weekDateIndex(dates, plannedFor));
  const dueIndex = task.dueDate && daysBetween(task.dueDate, endISO) <= 0 ? weekDateIndex(dates, task.dueDate) : dates.length - 1;
  return {
    earliestIndex,
    dueIndex: Math.max(earliestIndex, dueIndex)
  };
}

function preferredWeekIndex(task, dates) {
  const { earliestIndex, dueIndex } = weekTaskBounds(task, dates);
  if (task.urgency === 'fire') return earliestIndex;
  if (task.urgency === 'high') return Math.min(dueIndex, earliestIndex + 1);
  if (task.urgency === 'later') return Math.max(earliestIndex, Math.min(dueIndex, weekDateIndex(dates, task.plannedFor || dates[dueIndex])));
  if (task.urgency === 'low') return dueIndex;
  if (hasExplicitDue(task)) return Math.max(earliestIndex, dueIndex - 1);
  const span = Math.max(0, dueIndex - earliestIndex);
  return Math.max(earliestIndex, Math.min(dueIndex, earliestIndex + Math.max(1, Math.round(span * 0.55))));
}

function orderedWeekIndexes(task, dates) {
  const { earliestIndex, dueIndex } = weekTaskBounds(task, dates);
  if (task.urgency === 'fire' || task.urgency === 'high') {
    return dates.map((_, index) => index).filter((index) => index >= earliestIndex && index <= dueIndex);
  }
  const preferred = preferredWeekIndex(task, dates);
  return dates
    .map((_, index) => index)
    .filter((index) => index >= earliestIndex && index <= dueIndex)
    .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || b - a);
}

function baseCursorForDate(targetISO, settings) {
  let cursor = minutesFromTime(settings.workdayStart);
  const now = new Date();
  if (targetISO === todayISO(now)) {
    const current = now.getHours() * 60 + now.getMinutes();
    cursor = Math.ceil(Math.max(current, cursor) / 15) * 15;
  }
  return cursor;
}

function preferredCursorForTask(task, targetISO, settings) {
  const base = baseCursorForDate(targetISO, settings);
  if (task.urgency === 'fire' || task.urgency === 'high') return base;
  const afterLunch = minutesFromTime(settings.lunchEnd || '14:00');
  return Math.max(base, afterLunch);
}

function weekBlockDuration(task, settings) {
  const focusBlock = Number(settings.focusBlockMinutes || 75);
  const quickBlock = Number(settings.quickBlockMinutes || 30);
  return Math.min(Math.max(quickBlock, task.effortMinutes || focusBlock), focusBlock);
}

function isWeekCandidate(task, dates) {
  if (task.status !== 'active') return false;
  const endISO = dates[dates.length - 1];
  if (task.plannedFor && daysBetween(task.plannedFor, endISO) > 0) return false;
  return true;
}

function addPlannedBusyBlock(settings, date, block) {
  settings.busyBlocks.push({
    id: `planned-${block.id}`,
    date,
    title: block.title,
    start: block.start,
    end: block.end,
    source: 'planned'
  });
}

function buildWeekPlan(tasks, settingsByDate, dates, startISO = todayISO()) {
  const daySettings = new Map(dates.map((date) => [date, cloneSettings(settingsByDate.get(date) || defaultSettings())]));
  const days = dates.map((date) => ({
    date,
    blocks: [],
    busy: busyBlocksForDate(daySettings.get(date), date)
  }));
  const backlog = [];
  const candidates = activeTasks(tasks)
    .filter((task) => isWeekCandidate(task, dates))
    .map((task) => ({
      ...enrichedTask(task),
      score: scoreTask(task, startISO),
      dueStatus: statusForDue(task, startISO)
    }))
    .sort((a, b) => {
      const aPreferred = preferredWeekIndex(a, dates);
      const bPreferred = preferredWeekIndex(b, dates);
      return b.score - a.score || aPreferred - bPreferred || new Date(a.createdAt) - new Date(b.createdAt);
    });

  for (const task of candidates) {
    let scheduled = false;
    for (const dateIndex of orderedWeekIndexes(task, dates)) {
      const date = dates[dateIndex];
      const settings = daySettings.get(date);
      const duration = weekBlockDuration(task, settings);
      const windows = buildTaskWindows(settings, task, date);
      const preferredCursor = preferredCursorForTask(task, date, settings);
      const baseCursor = baseCursorForDate(date, settings);
      const placed = placeBlock(windows, preferredCursor, duration) || placeBlock(windows, baseCursor, duration);
      if (!placed) continue;

      const block = {
        id: `${task.id}-${date}-${days[dateIndex].blocks.length}`,
        taskId: task.id,
        date,
        title: task.title,
        enhancedText: task.enhancedText,
        steps: task.steps,
        project: task.project,
        accountId: task.accountId,
        accountLabel: task.accountLabel,
        accountType: task.accountType,
        urgency: task.urgency,
        score: task.score,
        dueDate: task.dueDate,
        dueStatus: statusForDue(task, date),
        effortMinutes: task.effortMinutes,
        duration,
        start: timeFromMinutes(placed.start),
        end: timeFromMinutes(placed.end),
        decision: {
          ...(task.decision || {}),
          schedule: `alocada em ${date} por prioridade, prazo e agenda livre`
        }
      };
      days[dateIndex].blocks.push(block);
      addPlannedBusyBlock(settings, date, block);
      scheduled = true;
      break;
    }
    if (!scheduled) backlog.push(task);
  }

  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    dates,
    days: days.map((day) => ({
      ...day,
      blocks: day.blocks.sort((a, b) => minutesFromTime(a.start) - minutesFromTime(b.start)),
      busy: busyBlocksForDate(daySettings.get(day.date), day.date).filter((block) => block.source !== 'planned')
    })),
    blocks: days.flatMap((day) => day.blocks).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start)),
    backlog,
    stats: {
      scheduled: days.reduce((sum, day) => sum + day.blocks.length, 0),
      backlog: backlog.length,
      totalFocusMinutes: days.reduce((sum, day) => sum + day.blocks.reduce((daySum, block) => daySum + block.duration, 0), 0)
    }
  };
}

function chooseNextPlanTask(candidates, settings, targetISO, cursor, focusBlock, quickBlock, lastAccountId) {
  const options = candidates
    .map((task, index) => {
      const duration = Math.min(
        Math.max(quickBlock, task.effortMinutes || focusBlock),
        task.effortMinutes > focusBlock ? focusBlock : focusBlock
      );
      const windows = buildTaskWindows(settings, task, targetISO);
      const placed = placeBlock(windows, cursor, duration);
      if (!placed) return null;
      const sameAccountPenalty = task.accountId === lastAccountId ? 8 : 0;
      return { task, index, duration, placed, rank: placed.start * 2 - task.score + sameAccountPenalty };
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank || b.task.score - a.task.score);

  return options[0] || null;
}

function buildTaskWindows(settings, task, targetISO) {
  const account = resolveAccount(task);
  const rules = accountRules(account, settings);
  const start = minutesFromTime(rules.earliest);
  const end = minutesFromTime(rules.latest || settings.workdayEnd);
  const blockers = [
    { start: settings.lunchStart, end: settings.lunchEnd },
    ...busyBlocksForDate(settings, targetISO)
  ].map((block) => [minutesFromTime(block.start), minutesFromTime(block.end)]);

  return subtractBlockedRanges([[start, end]], blockers);
}

function busyBlocksForDate(settings, targetISO) {
  return (settings.busyBlocks || [])
    .filter((block) => block.date === targetISO)
    .map((block) => ({
      id: block.id,
      date: block.date,
      title: block.title || 'Horario bloqueado',
      start: block.start,
      end: block.end,
      source: block.source || 'manual',
      googleEventId: block.googleEventId || null
    }))
    .sort((a, b) => minutesFromTime(a.start) - minutesFromTime(b.start));
}

function timeRangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function subtractBlockedRanges(windows, blockers) {
  return blockers.reduce((available, [blockedStart, blockedEnd]) => {
    return available.flatMap(([start, end]) => {
      if (blockedEnd <= start || blockedStart >= end) return [[start, end]];
      const ranges = [];
      if (blockedStart > start) ranges.push([start, blockedStart]);
      if (blockedEnd < end) ranges.push([blockedEnd, end]);
      return ranges;
    });
  }, windows).filter(([start, end]) => end - start >= 15);
}

function placeBlock(windows, cursor, duration) {
  for (let i = 0; i < windows.length; i += 1) {
    const [windowStart, windowEnd] = windows[i];
    const start = Math.max(cursor, windowStart);
    if (start + duration <= windowEnd) {
      return { start, end: start + duration, windowIndex: i };
    }
  }
  return null;
}

function summarize(tasks, targetISO) {
  const active = activeTasks(tasks);
  const ready = active.filter((task) => isReadyForPlan(task, targetISO));
  const doneToday = tasks.filter((task) => task.completedAt?.slice(0, 10) === targetISO).length;
  const overdue = active.filter((task) => daysBetween(task.dueDate, targetISO) < 0).length;
  const dueToday = ready.filter((task) => daysBetween(task.dueDate, targetISO) === 0).length;
  const later = active.filter((task) => isLaterTask(task, targetISO)).length;
  return {
    active: active.length,
    ready: ready.length,
    later,
    overdue,
    dueToday,
    doneToday,
    totalFocusMinutes: ready.reduce((sum, task) => sum + Number(task.effortMinutes || 0), 0),
    accounts: summarizeAccounts(tasks, targetISO)
  };
}

function summarizeAccounts(tasks, targetISO) {
  const summary = new Map(
    accountConfig.map((account) => [
      account.id,
      { id: account.id, label: account.label, type: account.type, active: 0, ready: 0, later: 0, doneToday: 0 }
    ])
  );

  for (const task of tasks) {
    const view = enrichedTask(task);
    if (!summary.has(view.accountId)) {
      summary.set(view.accountId, {
        id: view.accountId,
        label: view.accountLabel,
        type: view.accountType || 'client',
        active: 0,
        ready: 0,
        later: 0,
        doneToday: 0
      });
    }
    const row = summary.get(view.accountId);
    if (view.status === 'active') row.active += 1;
    if (isReadyForPlan(view, targetISO)) row.ready += 1;
    if (view.status === 'active' && isLaterTask(view, targetISO)) row.later += 1;
    if (view.completedAt?.slice(0, 10) === targetISO) row.doneToday += 1;
  }

  return [...summary.values()].filter((row) => row.active || row.ready || row.later || row.doneToday || row.id !== 'geral');
}

function taskView(task, targetISO = todayISO()) {
  const enriched = enrichedTask(task);
  return {
    ...enriched,
    score: task.status === 'active' ? scoreTask(task, targetISO) : 0,
    dueStatus: task.status === 'active' ? statusForDue(task, targetISO) : 'concluida'
  };
}

function enrichedTask(task) {
  const analysis = enhanceDemand(task.raw || task.title || '');
  const account = resolveAccount(task);
  const refreshAnalysis = task.analysisVersion !== ANALYSIS_VERSION;
  return {
    ...task,
    title: refreshAnalysis ? analysis.title : task.title || analysis.title,
    enhancedText: refreshAnalysis ? analysis.summary : task.enhancedText || analysis.summary,
    steps: refreshAnalysis ? analysis.steps : Array.isArray(task.steps) && task.steps.length ? task.steps : analysis.steps,
    keywords: refreshAnalysis ? analysis.keywords : Array.isArray(task.keywords) && task.keywords.length ? task.keywords : analysis.keywords,
    analysisVersion: ANALYSIS_VERSION,
    project: task.project && !['Geral', 'Empresa principal'].includes(task.project) ? task.project : account.label,
    accountId: account.id,
    accountLabel: account.label,
    accountType: account.type,
    accountSource: task.accountSource || account.source || 'inferred',
    decision: { ...(task.decision || {}), account: task.decision?.account || `conta definida como ${account.label}` },
    plannedFor: task.plannedFor ?? null
  };
}

function createBusyBlock(body, fallbackDate = todayISO()) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : fallbackDate;
  const start = validTime(body.start) ? body.start : '12:00';
  const end = validTime(body.end) ? body.end : '14:00';
  const startMinutes = minutesFromTime(start);
  const endMinutes = minutesFromTime(end);

  return {
    id: crypto.randomUUID(),
    date,
    title: cleanupTitle(body.title || 'Reuniao / agenda ocupada'),
    start: timeFromMinutes(Math.min(startMinutes, endMinutes - 15)),
    end: timeFromMinutes(Math.max(endMinutes, startMinutes + 15)),
    source: body.source || 'manual'
  };
}

function validTime(value) {
  return /^\d{2}:\d{2}$/.test(String(value || ''));
}

function extractGoogleCredentials(raw = {}) {
  const source = raw.web || raw.installed || raw;
  const redirectUris = Array.isArray(source.redirect_uris) ? source.redirect_uris : [];
  const redirectFromFile = redirectUris.find((item) => String(item).includes('/auth/google/callback')) || redirectUris[0];
  const clientId = process.env.GOOGLE_CLIENT_ID || source.client_id || source.clientId;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || source.client_secret || source.clientSecret;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ||
    source.redirect_uri ||
    source.redirectUri ||
    redirectFromFile ||
    `http://localhost:${port}/auth/google/callback`;

  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri };
}

async function readGoogleCredentials() {
  const envCredentials = extractGoogleCredentials({});
  if (envCredentials) return envCredentials;
  return extractGoogleCredentials((await readJsonIfExists(googleCredentialFile)) || {});
}

async function readGoogleToken() {
  if (MONGODB_URI) {
    const db = await getMongoDb();
    const doc = await db.collection('store').findOne({ _id: 'google-token' });
    if (!doc) return null;
    const { _id, ...token } = doc;
    return token;
  }
  return readJsonIfExists(googleTokenFile);
}

async function saveGoogleToken(nextToken) {
  const existing = (await readGoogleToken()) || {};
  const expiresIn = Number(nextToken.expires_in || 0);
  const nextScopes = mergeGoogleScopes(existing.scope, nextToken.scope);
  const saved = {
    accessToken: nextToken.access_token || nextToken.accessToken || existing.accessToken || '',
    refreshToken: nextToken.refresh_token || nextToken.refreshToken || existing.refreshToken || '',
    tokenType: nextToken.token_type || nextToken.tokenType || existing.tokenType || 'Bearer',
    scope: nextScopes || GOOGLE_CALENDAR_SCOPES.join(' '),
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : nextToken.expiresAt || existing.expiresAt || 0,
    connectedAt: existing.connectedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (MONGODB_URI) {
    const db = await getMongoDb();
    await db.collection('store').replaceOne({ _id: 'google-token' }, { _id: 'google-token', ...saved }, { upsert: true });
  } else {
    await writeJsonFile(googleTokenFile, saved);
  }
  return saved;
}

async function deleteGoogleToken() {
  if (MONGODB_URI) {
    const db = await getMongoDb();
    await db.collection('store').deleteOne({ _id: 'google-token' });
    return;
  }
  await rm(googleTokenFile, { force: true });
}

function mergeGoogleScopes(...scopeValues) {
  const scopes = new Set();
  for (const value of scopeValues) {
    String(value || '')
      .split(/\s+/)
      .filter(Boolean)
      .forEach((scope) => scopes.add(scope));
  }
  return [...scopes].join(' ');
}

function missingGoogleScopes(token) {
  const scopes = new Set(String(token?.scope || '').split(/\s+/).filter(Boolean));
  return GOOGLE_CALENDAR_SCOPES.filter((scope) => !scopes.has(scope));
}

function googleTokenRequestBody(credentials, extra) {
  const body = {
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    ...extra
  };
  if (extra.grant_type !== 'refresh_token') body.redirect_uri = credentials.redirectUri;
  return new URLSearchParams(body);
}

async function postGoogleToken(body) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || 'Falha na autorizacao do Google.');
  }
  return payload;
}

async function exchangeGoogleCode(code) {
  const credentials = await readGoogleCredentials();
  if (!credentials) throw new Error('Credenciais do Google Calendar nao configuradas.');
  return postGoogleToken(
    googleTokenRequestBody(credentials, {
      code,
      grant_type: 'authorization_code'
    })
  );
}

async function refreshGoogleToken(refreshToken) {
  const credentials = await readGoogleCredentials();
  if (!credentials) throw new Error('Credenciais do Google Calendar nao configuradas.');
  return postGoogleToken(
    googleTokenRequestBody(credentials, {
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  );
}

async function getValidGoogleAccessToken() {
  const token = await readGoogleToken();
  if (!token?.accessToken && !token?.refreshToken) throw new Error('Google Calendar ainda nao conectado.');
  if (token.accessToken && Number(token.expiresAt || 0) > Date.now() + 60000) return token.accessToken;
  if (!token.refreshToken) throw new Error('Autorizacao expirada. Conecte o Google Calendar de novo.');
  const refreshed = await refreshGoogleToken(token.refreshToken);
  const saved = await saveGoogleToken(refreshed);
  return saved.accessToken;
}

async function calendarStatus() {
  const credentials = await readGoogleCredentials();
  const token = await readGoogleToken();
  const tokenExists = Boolean(token?.refreshToken || token?.accessToken);
  const missingScopes = tokenExists ? missingGoogleScopes(token) : [];
  return {
    configured: Boolean(credentials),
    connected: Boolean(credentials && tokenExists && missingScopes.length === 0),
    needsReconnect: Boolean(credentials && tokenExists && missingScopes.length > 0),
    scopes: GOOGLE_CALENDAR_SCOPES,
    missingScopes,
    updatedAt: token?.updatedAt || null
  };
}

async function requireGoogleConnected() {
  const status = await calendarStatus();
  if (!status.configured) throw new Error('Credenciais do Google nao configuradas.');
  if (status.needsReconnect) throw new Error('Reconecte o Google Calendar para liberar eventos e tarefas.');
  if (!status.connected) throw new Error('Google Calendar ainda nao conectado.');
  return getValidGoogleAccessToken();
}

function googleDayBoundary(targetISO, time) {
  return `${targetISO}T${time}:00-03:00`;
}

function googleBusyBlock(slot, targetISO, index, details = {}) {
  const dayStart = new Date(googleDayBoundary(targetISO, '00:00')).getTime();
  const dayEnd = new Date(googleDayBoundary(targetISO, '23:59')).getTime() + 60000;
  const slotStart = new Date(slot.start).getTime();
  const slotEnd = new Date(slot.end).getTime();
  if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd)) return null;
  const startMs = Math.max(slotStart, dayStart);
  const endMs = Math.min(slotEnd, dayEnd);
  if (endMs <= startMs) return null;
  const start = Math.max(0, Math.min(24 * 60, Math.round((startMs - dayStart) / 60000)));
  const end = Math.max(start + 1, Math.min(24 * 60, Math.round((endMs - dayStart) / 60000)));
  return {
    id: `google-${targetISO}-${index}-${start}-${end}`,
    date: targetISO,
    title: details.title || 'Agenda Google ocupada',
    start: timeFromMinutes(start),
    end: timeFromMinutes(end),
    source: 'google',
    googleEventId: details.eventId || null
  };
}

async function googleApi(url, options = {}) {
  const accessToken = await requireGoogleConnected();
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || options.errorMessage || 'Falha ao chamar API do Google.');
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

function isGestorGoogleEvent(event) {
  return event?.extendedProperties?.private?.source === GOOGLE_SOURCE;
}

function googleEventToBusyBlock(event, targetISO, index) {
  if (!event || event.status === 'cancelled' || event.transparency === 'transparent') return null;
  if (isGestorGoogleEvent(event)) return null;
  const start = event.start?.dateTime || (event.start?.date ? `${event.start.date}T00:00:00-03:00` : '');
  const end = event.end?.dateTime || (event.end?.date ? `${event.end.date}T00:00:00-03:00` : '');
  return googleBusyBlock({ start, end }, targetISO, index, {
    title: event.summary || 'Agenda Google ocupada',
    eventId: event.id || null
  });
}

async function fetchGoogleBusyBlocks(targetISO) {
  const params = new URLSearchParams({
    timeMin: googleDayBoundary(targetISO, '00:00'),
    timeMax: googleDayBoundary(targetISO, '23:59'),
    timeZone: 'America/Sao_Paulo',
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500'
  });
  const payload = await googleApi(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    errorMessage: 'Nao consegui ler os eventos do Google Calendar.'
  });
  return (payload.calendars?.primary?.busy || [])
    .map((slot, index) => googleBusyBlock(slot, targetISO, index))
    .filter(Boolean)
    .concat((payload.items || []).map((event, index) => googleEventToBusyBlock(event, targetISO, index)).filter(Boolean))
    .sort((a, b) => minutesFromTime(a.start) - minutesFromTime(b.start));
}

async function calendarOverlay(targetISO, options = {}) {
  const status = await calendarStatus();
  if (!status.configured || !status.connected) {
    return {
      ...status,
      busyBlocks: [],
      busyCount: 0,
      syncedAt: null,
      error: status.needsReconnect ? 'Reconecte para autorizar criacao de blocos e tarefas.' : null,
      fromCache: false
    };
  }

  const cached = calendarCache.get(targetISO);
  if (!options.force && cached && Date.now() - cached.createdAt < CALENDAR_CACHE_MS) {
    return { ...status, ...cached.payload, fromCache: true };
  }

  try {
    const busyBlocks = await fetchGoogleBusyBlocks(targetISO);
    const payload = {
      busyBlocks,
      busyCount: busyBlocks.length,
      syncedAt: new Date().toISOString(),
      error: null,
      fromCache: false
    };
    calendarCache.set(targetISO, { createdAt: Date.now(), payload });
    return { ...status, ...payload };
  } catch (error) {
    return {
      ...status,
      busyBlocks: [],
      busyCount: 0,
      syncedAt: null,
      error: error.message || 'Falha ao sincronizar Google Calendar.',
      fromCache: false
    };
  }
}

function settingsWithCalendar(settings, googleBusyBlocks) {
  const normalized = normalizeSettings(settings);
  return {
    ...normalized,
    busyBlocks: [...(normalized.busyBlocks || []), ...(googleBusyBlocks || [])]
  };
}

async function calendarOverlaysForDates(dates, options = {}) {
  const entries = await Promise.all(
    dates.map(async (date) => [date, await calendarOverlay(date, { force: options.force })])
  );
  return new Map(entries);
}

function settingsByDateFromOverlays(settings, overlays) {
  const map = new Map();
  for (const [date, overlay] of overlays.entries()) {
    map.set(date, settingsWithCalendar(settings, overlay.busyBlocks));
  }
  return map;
}

function googleDateTime(targetISO, time) {
  return `${targetISO}T${time}:00-03:00`;
}

function googleCalendarWebhookAddress() {
  const explicit = process.env.GOOGLE_CALENDAR_WEBHOOK_URL || '';
  if (explicit) return explicit.trim();
  const base = process.env.PUBLIC_WEBHOOK_BASE_URL || process.env.PUBLIC_BASE_URL || '';
  if (!base) return '';
  return `${base.replace(/\/+$/, '')}${GOOGLE_CALENDAR_WEBHOOK_PATH}`;
}

function googleCalendarWatchView(settings) {
  const watch = normalizeSettings(settings).googleCalendarWatch || null;
  const address = googleCalendarWebhookAddress();
  const expiration = Number(watch?.expiration || 0);
  return {
    configured: Boolean(address),
    active: Boolean(watch?.channelId && watch?.resourceId && expiration > Date.now() + 60000),
    expiresAt: expiration ? new Date(expiration).toISOString() : null,
    updatedAt: watch?.updatedAt || null
  };
}

function googleTaskDueDate(targetISO) {
  return `${targetISO}T00:00:00.000Z`;
}

function googleTaskNotes(task, block) {
  const steps = Array.isArray(block.steps) ? block.steps : [];
  return [
    `Bloco no calendario: ${block.start} - ${block.end}`,
    `Conta: ${block.accountLabel || block.project || task.accountLabel || 'Geral'}`,
    '',
    block.enhancedText || task.enhancedText || '',
    steps.length ? `\nPassos:\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}` : '',
    '',
    'Criado pelo Gestor Abner. Concluir pelo gestor marca esta tarefa como concluida.'
  ]
    .filter((part) => String(part).trim())
    .join('\n');
}

function googleEventDescription(task, block, completed = false) {
  const steps = Array.isArray(block.steps) ? block.steps : [];
  return [
    completed ? 'Status: concluida pelo Gestor Abner.' : 'Status: planejada pelo Gestor Abner.',
    `Demanda local: ${task.id}`,
    `Conta: ${block.accountLabel || block.project || task.accountLabel || 'Geral'}`,
    `Urgencia: ${urgencyConfig[block.urgency]?.label || block.urgency || 'Normal'}`,
    '',
    block.enhancedText || task.enhancedText || '',
    steps.length ? `\nPassos:\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}` : '',
    '',
    `Original: ${task.raw || ''}`
  ]
    .filter((part) => String(part).trim())
    .join('\n');
}

function googleEventBody(task, block, targetDate, completed = false) {
  const title = completed ? `Concluido - ${block.title || task.title}` : `Foco - ${block.title || task.title}`;
  return {
    status: 'confirmed',
    summary: title,
    description: googleEventDescription(task, block, completed),
    start: {
      dateTime: googleDateTime(targetDate, block.start),
      timeZone: 'America/Sao_Paulo'
    },
    end: {
      dateTime: googleDateTime(targetDate, block.end),
      timeZone: 'America/Sao_Paulo'
    },
    transparency: completed ? 'transparent' : 'opaque',
    colorId: completed ? '10' : googleEventColorByUrgency[block.urgency] || googleEventColorByUrgency.normal,
    extendedProperties: {
      private: {
        source: GOOGLE_SOURCE,
        taskId: task.id,
        targetDate
      }
    }
  };
}

async function getCalendarEvent(eventId) {
  return googleApi(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    errorMessage: 'Nao consegui verificar o bloco no Google Calendar.'
  });
}

async function findCalendarEventForTask(taskId, dates) {
  const startDate = dates[0];
  const endDate = addDaysISO(dates[dates.length - 1], 1);
  const params = new URLSearchParams({
    timeMin: googleDayBoundary(startDate, '00:00'),
    timeMax: googleDayBoundary(endDate, '00:00'),
    singleEvents: 'true',
    showDeleted: 'false',
    maxResults: '20'
  });
  params.append('privateExtendedProperty', `${encodeURIComponent('source')}=${encodeURIComponent(GOOGLE_SOURCE)}`);
  params.append('privateExtendedProperty', `${encodeURIComponent('taskId')}=${encodeURIComponent(taskId)}`);
  const payload = await googleApi(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    errorMessage: 'Nao consegui procurar blocos existentes no Google Calendar.'
  });
  return (payload.items || []).find((event) => event.status !== 'cancelled') || null;
}

async function createCalendarEvent(task, block, targetDate, completed = false) {
  return googleApi('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    body: googleEventBody(task, block, targetDate, completed),
    errorMessage: 'Nao consegui criar o bloco no Google Calendar.'
  });
}

async function updateCalendarEvent(eventId, task, block, targetDate, completed = false) {
  return googleApi(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: googleEventBody(task, block, targetDate, completed),
    errorMessage: 'Nao consegui atualizar o bloco no Google Calendar.'
  });
}

async function upsertCalendarEvent(task, block, targetDate, dates = [targetDate]) {
  if (task.googleCalendarEventId) {
    try {
      const existing = await getCalendarEvent(task.googleCalendarEventId);
      if (existing.status === 'cancelled') throw Object.assign(new Error('Evento apagado no Google Calendar.'), { statusCode: 410 });
      const event = await updateCalendarEvent(task.googleCalendarEventId, task, block, targetDate, false);
      if (event.status === 'cancelled') throw Object.assign(new Error('Evento cancelado no Google Calendar.'), { statusCode: 410 });
      return { event, action: 'updated' };
    } catch (error) {
      if (error.statusCode !== 404 && error.statusCode !== 410) throw error;
    }
  }

  const existing = await findCalendarEventForTask(task.id, dates);
  if (existing?.id) {
    const event = await updateCalendarEvent(existing.id, task, block, targetDate, false);
    if (event.status !== 'cancelled') return { event, action: 'updated' };
  }

  const event = await createCalendarEvent(task, block, targetDate, false);
  return { event, action: 'created' };
}

async function stopGoogleCalendarWatch(watch) {
  if (!watch?.channelId || !watch?.resourceId) return false;
  try {
    await googleApi('https://www.googleapis.com/calendar/v3/channels/stop', {
      method: 'POST',
      body: {
        id: watch.channelId,
        resourceId: watch.resourceId
      },
      errorMessage: 'Nao consegui encerrar a notificacao antiga do Calendar.'
    });
    return true;
  } catch {
    return false;
  }
}

async function registerGoogleCalendarWatch(store, options = {}) {
  const address = googleCalendarWebhookAddress();
  if (!address) {
    throw new Error('Configure GOOGLE_CALENDAR_WEBHOOK_URL ou PUBLIC_WEBHOOK_BASE_URL para ativar notificacoes do Calendar.');
  }

  const settings = normalizeSettings(store.settings);
  const current = googleCalendarWatchView(settings);
  if (!options.force && current.active) {
    return { ...current, reused: true };
  }

  await requireGoogleConnected();
  if (settings.googleCalendarWatch?.resourceId) {
    await stopGoogleCalendarWatch(settings.googleCalendarWatch);
  }

  const channelId = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  const ttlSeconds = String(Math.max(3600, Math.floor(GOOGLE_CALENDAR_WATCH_TTL_MS / 1000)));
  const requestedExpiration = Date.now() + Number(ttlSeconds) * 1000;
  const response = await googleApi('https://www.googleapis.com/calendar/v3/calendars/primary/events/watch', {
    method: 'POST',
    body: {
      id: channelId,
      type: 'web_hook',
      address,
      token,
      params: {
        ttl: ttlSeconds
      }
    },
    errorMessage: 'Nao consegui ativar notificacoes do Google Calendar.'
  });

  const expiration = Number(response.expiration || requestedExpiration);
  store.settings = {
    ...settings,
    googleCalendarWatch: {
      channelId,
      resourceId: response.resourceId,
      resourceUri: response.resourceUri || null,
      token,
      address,
      expiration,
      updatedAt: new Date().toISOString()
    }
  };

  return {
    configured: true,
    active: true,
    expiresAt: new Date(expiration).toISOString(),
    updatedAt: store.settings.googleCalendarWatch.updatedAt,
    reused: false
  };
}

async function resolveGoogleTaskListId(store) {
  if (store.settings?.googleTaskListId) return store.settings.googleTaskListId;
  const lists = await googleApi('https://tasks.googleapis.com/tasks/v1/users/@me/lists', {
    errorMessage: 'Nao consegui acessar suas listas do Google Tasks.'
  });
  const existing = (lists.items || []).find((list) => list.title === GOOGLE_TASK_LIST_TITLE);
  const fallback = existing || (lists.items || [])[0];
  if (fallback?.id) {
    store.settings = { ...normalizeSettings(store.settings), googleTaskListId: fallback.id };
    return fallback.id;
  }
  const created = await googleApi('https://tasks.googleapis.com/tasks/v1/users/@me/lists', {
    method: 'POST',
    body: { title: GOOGLE_TASK_LIST_TITLE },
    errorMessage: 'Nao consegui criar uma lista no Google Tasks.'
  });
  store.settings = { ...normalizeSettings(store.settings), googleTaskListId: created.id };
  return created.id;
}

async function createGoogleTask(taskListId, task, block, targetDate) {
  return googleApi(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(taskListId)}/tasks`, {
    method: 'POST',
    body: {
      title: block.title || task.title,
      notes: googleTaskNotes(task, block),
      due: googleTaskDueDate(targetDate),
      status: 'needsAction'
    },
    errorMessage: 'Nao consegui criar a tarefa no Google Tasks.'
  });
}

async function updateGoogleTask(taskListId, googleTaskId, task, block, targetDate) {
  return googleApi(
    `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(googleTaskId)}`,
    {
      method: 'PATCH',
      body: {
        title: block.title || task.title,
        notes: googleTaskNotes(task, block),
        due: googleTaskDueDate(targetDate),
        status: 'needsAction'
      },
      errorMessage: 'Nao consegui atualizar a tarefa no Google Tasks.'
    }
  );
}

async function upsertGoogleTask(taskListId, task, block, targetDate) {
  if (task.googleTaskId) {
    try {
      const googleTask = await updateGoogleTask(task.googleTaskListId || taskListId, task.googleTaskId, task, block, targetDate);
      return { googleTask, action: 'updated', taskListId: task.googleTaskListId || taskListId };
    } catch (error) {
      if (error.statusCode !== 404 && error.statusCode !== 410) throw error;
    }
  }
  const googleTask = await createGoogleTask(taskListId, task, block, targetDate);
  return { googleTask, action: 'created', taskListId };
}

function friendlyGoogleTasksError(error) {
  const message = String(error?.message || '');
  if (/tasks\.googleapis\.com/i.test(message) && /\b(disabled|not been used|enable it)\b/i.test(message)) {
    return 'Google Tasks API esta desativada nesse projeto. Ative a API no Google Cloud; os blocos do Calendar podem ser criados mesmo assim.';
  }
  return message || 'Nao consegui criar a tarefa no Google Tasks.';
}

function taskGoogleBlock(task, targetDate) {
  if (!task.googleCalendarStart || !task.googleCalendarEnd) return null;
  return {
    ...enrichedTask(task),
    taskId: task.id,
    title: task.title,
    start: task.googleCalendarStart,
    end: task.googleCalendarEnd,
    urgency: task.urgency,
    accountLabel: task.accountLabel || task.project,
    project: task.project,
    enhancedText: task.enhancedText,
    steps: task.steps,
    targetDate
  };
}

async function syncPlanToGoogle(store, targetDate) {
  const status = await calendarStatus();
  if (!status.connected) throw new Error(status.needsReconnect ? 'Reconecte o Google Calendar.' : 'Conecte o Google Calendar antes de enviar o plano.');
  const dates = planningWeekDates(targetDate);
  const overlays = await calendarOverlaysForDates(dates, { force: true });
  const failedOverlay = [...overlays.entries()].find(([, overlay]) => overlay.error);
  if (failedOverlay) throw new Error(failedOverlay[1].error || 'Nao consegui ler sua agenda da semana.');
  const plan = buildWeekPlan(store.tasks, settingsByDateFromOverlays(store.settings, overlays), dates, targetDate);
  const result = {
    createdEvents: 0,
    updatedEvents: 0,
    createdTasks: 0,
    updatedTasks: 0,
    taskErrors: 0,
    skipped: 0,
    days: dates.length,
    warning: null
  };
  let taskListId = null;

  try {
    taskListId = await resolveGoogleTaskListId(store);
  } catch (error) {
    result.warning = friendlyGoogleTasksError(error);
    result.taskErrors += 1;
  }

  for (const block of plan.blocks) {
    const task = store.tasks.find((item) => item.id === block.taskId);
    if (!task || task.status !== 'active') {
      result.skipped += 1;
      continue;
    }
    const eventResult = await upsertCalendarEvent(task, block, block.date, dates);
    if (eventResult.action === 'created') result.createdEvents += 1;
    else result.updatedEvents += 1;

    const now = new Date().toISOString();
    task.googleCalendarEventId = eventResult.event.id;
    task.googleCalendarEventHtmlLink = eventResult.event.htmlLink || task.googleCalendarEventHtmlLink || null;
    task.googleCalendarDate = block.date;
    task.googleCalendarStart = block.start;
    task.googleCalendarEnd = block.end;
    task.googleSyncedAt = now;
    task.history = Array.isArray(task.history) ? task.history : [];

    if (taskListId) {
      try {
        const taskResult = await upsertGoogleTask(taskListId, task, block, block.date);
        if (taskResult.action === 'created') result.createdTasks += 1;
        else result.updatedTasks += 1;
        task.googleTaskId = taskResult.googleTask.id;
        task.googleTaskListId = taskResult.taskListId;
        task.googleSyncStatus = 'synced';
        task.googleSyncError = null;
        task.history.push({ at: now, type: 'google-sync', note: `${block.start}-${block.end} enviado para Google Calendar/Tasks` });
      } catch (error) {
        const warning = friendlyGoogleTasksError(error);
        result.warning = result.warning || warning;
        result.taskErrors += 1;
        task.googleSyncStatus = 'calendar-only';
        task.googleSyncError = warning;
        task.history.push({ at: now, type: 'google-sync', note: `${block.start}-${block.end} enviado para Calendar; Tasks pendente` });
      }
    } else {
      task.googleSyncStatus = 'calendar-only';
      task.googleSyncError = result.warning || 'Google Tasks indisponivel.';
      task.history.push({ at: now, type: 'google-sync', note: `${block.start}-${block.end} enviado para Calendar; Tasks pendente` });
    }

    task.updatedAt = now;
  }

  dates.forEach((date) => calendarCache.delete(date));
  return result;
}

function autoRescheduleEnabled() {
  return String(process.env.AUTO_RESCHEDULE_DISABLED || '').toLowerCase() !== 'true';
}

function findGoogleScheduleConflicts(store, overlays, dates) {
  const settingsByDate = settingsByDateFromOverlays(store.settings, overlays);
  const dateSet = new Set(dates);
  const conflicts = [];

  for (const task of store.tasks) {
    if (task.status !== 'active') continue;
    if (!task.googleCalendarEventId || !task.googleCalendarDate || !task.googleCalendarStart || !task.googleCalendarEnd) continue;
    if (!dateSet.has(task.googleCalendarDate)) continue;

    const settings = settingsByDate.get(task.googleCalendarDate) || normalizeSettings(store.settings);
    const taskStart = minutesFromTime(task.googleCalendarStart);
    const taskEnd = minutesFromTime(task.googleCalendarEnd);
    const blocker = busyBlocksForDate(settings, task.googleCalendarDate)
      .filter((block) => block.source !== 'planned')
      .find((block) => {
        if (block.googleEventId && block.googleEventId === task.googleCalendarEventId) return false;
        return timeRangesOverlap(taskStart, taskEnd, minutesFromTime(block.start), minutesFromTime(block.end));
      });

    if (!blocker) continue;
    conflicts.push({
      taskId: task.id,
      title: task.title,
      date: task.googleCalendarDate,
      start: task.googleCalendarStart,
      end: task.googleCalendarEnd,
      blockedBy: blocker.title || 'Agenda Google ocupada',
      blockedStart: blocker.start,
      blockedEnd: blocker.end
    });
  }

  return conflicts;
}

function rememberAutoReschedule(store, result) {
  store.settings = {
    ...normalizeSettings(store.settings),
    lastAutoReschedule: {
      checkedAt: result.checkedAt,
      reason: result.reason || 'manual',
      moved: result.moved || 0,
      conflicts: result.conflicts || [],
      error: result.error || null
    }
  };
}

async function autoRescheduleGoogleConflicts(store, targetDate = todayISO()) {
  const checkedAt = new Date().toISOString();
  const status = await calendarStatus();
  if (!status.connected) {
    return {
      checkedAt,
      checked: false,
      moved: 0,
      conflicts: [],
      error: status.needsReconnect ? 'Reconecte o Google Calendar.' : 'Google Calendar nao conectado.'
    };
  }

  const dates = planningWeekDates(targetDate);
  const overlays = await calendarOverlaysForDates(dates, { force: true });
  const failedOverlay = [...overlays.values()].find((overlay) => overlay.error);
  if (failedOverlay) {
    return {
      checkedAt,
      checked: true,
      moved: 0,
      conflicts: [],
      error: failedOverlay.error || 'Nao consegui ler sua agenda da semana.'
    };
  }

  const conflicts = findGoogleScheduleConflicts(store, overlays, dates);
  if (!conflicts.length) {
    return { checkedAt, checked: true, moved: 0, conflicts: [], error: null };
  }

  const now = new Date().toISOString();
  for (const conflict of conflicts) {
    const task = store.tasks.find((item) => item.id === conflict.taskId);
    if (!task) continue;
    task.history = Array.isArray(task.history) ? task.history : [];
    task.history.push({
      at: now,
      type: 'auto-reschedule-conflict',
      note: `conflito com ${conflict.blockedBy} (${conflict.blockedStart}-${conflict.blockedEnd}); reagendando`
    });
    task.updatedAt = now;
  }

  const sync = await syncPlanToGoogle(store, targetDate);
  return {
    checkedAt,
    checked: true,
    moved: conflicts.length,
    conflicts,
    sync,
    error: null
  };
}

async function completeGoogleArtifacts(task) {
  if (!task.googleTaskId && !task.googleCalendarEventId) return null;
  const status = await calendarStatus();
  if (!status.connected) {
    task.googleSyncStatus = status.needsReconnect ? 'needs-reconnect' : 'not-connected';
    return null;
  }

  const completedAt = new Date().toISOString();
  const result = { taskCompleted: false, eventUpdated: false };

  if (task.googleTaskId && task.googleTaskListId) {
    try {
      await googleApi(
        `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(task.googleTaskListId)}/tasks/${encodeURIComponent(task.googleTaskId)}`,
        {
          method: 'PATCH',
          body: { status: 'completed', completed: completedAt },
          errorMessage: 'Nao consegui concluir a tarefa no Google Tasks.'
        }
      );
      result.taskCompleted = true;
    } catch (error) {
      task.googleSyncError = friendlyGoogleTasksError(error);
    }
  }

  if (task.googleCalendarEventId) {
    const block = taskGoogleBlock(task, task.googleCalendarDate || todayISO());
    if (block) {
      await updateCalendarEvent(task.googleCalendarEventId, task, block, task.googleCalendarDate || todayISO(), true);
      result.eventUpdated = true;
    }
  }

  task.googleSyncStatus = result.taskCompleted || result.eventUpdated ? 'completed' : 'error';
  task.googleCompletedAt = completedAt;
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({
    at: completedAt,
    type: 'google-complete',
    note: result.taskCompleted ? 'Google Tasks/Calendar marcado como concluido' : 'Calendar marcado como concluido; Tasks pendente'
  });
  calendarCache.delete(task.googleCalendarDate || todayISO());
  return result;
}

async function buildStatePayload(store, targetDate, options = {}) {
  const weekDates = planningWeekDates(targetDate);
  const overlayDates = unique([targetDate, ...weekDates]);
  const overlays = await calendarOverlaysForDates(overlayDates, { force: options.forceCalendar });
  const calendar = overlays.get(targetDate) || (await calendarOverlay(targetDate, { force: options.forceCalendar }));
  const settingsByDate = settingsByDateFromOverlays(store.settings, overlays);
  const settingsForPlan = settingsByDate.get(targetDate) || settingsWithCalendar(store.settings, calendar.busyBlocks);
  return {
    tasks: store.tasks.map((task) => taskView(task, targetDate)),
    plan: buildPlan(store.tasks, settingsForPlan, targetDate),
    weekPlan: buildWeekPlan(store.tasks, settingsByDate, weekDates, targetDate),
    accounts: accountConfig,
    busyBlocks: busyBlocksForDate(settingsForPlan, targetDate),
    settings: store.settings,
    gemini: await geminiStatus(),
    calendar: {
      configured: calendar.configured,
      connected: calendar.connected,
      needsReconnect: calendar.needsReconnect,
      busyCount: calendar.busyCount,
      syncedAt: calendar.syncedAt,
      updatedAt: calendar.updatedAt,
      error: calendar.error,
      fromCache: calendar.fromCache,
      autoReschedule: {
        enabled: autoRescheduleEnabled(),
        intervalMs: AUTO_RESCHEDULE_INTERVAL_MS,
        last: store.settings.lastAutoReschedule || null
      },
      watch: googleCalendarWatchView(store.settings)
    }
  };
}

function pruneGoogleStates() {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [state, createdAt] of pendingGoogleStates.entries()) {
    if (createdAt < tenMinutesAgo) pendingGoogleStates.delete(state);
  }
}

function googleAuthUrl(credentials, state) {
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: credentials.redirectUri,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  })}`;
}

async function handleGoogleAuth(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/auth/google') {
    const credentials = await readGoogleCredentials();
    if (!credentials) {
      return html(res, 500, '<p>Credenciais do Google Calendar nao configuradas.</p><p><a href="/">Voltar</a></p>');
    }
    pruneGoogleStates();
    const state = crypto.randomBytes(18).toString('hex');
    pendingGoogleStates.set(state, Date.now());
    return redirect(res, googleAuthUrl(credentials, state));
  }

  if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    if (!state || !pendingGoogleStates.has(state)) {
      return html(res, 400, '<p>Autorizacao invalida ou expirada.</p><p><a href="/">Voltar</a></p>');
    }
    pendingGoogleStates.delete(state);
    if (url.searchParams.get('error')) {
      return html(res, 400, '<p>O Google recusou a autorizacao.</p><p><a href="/">Voltar</a></p>');
    }
    if (!code) return html(res, 400, '<p>Codigo de autorizacao ausente.</p><p><a href="/">Voltar</a></p>');
    try {
      const token = await exchangeGoogleCode(code);
      await saveGoogleToken(token);
      calendarCache.clear();
      return html(
        res,
        200,
        '<p>Google Calendar conectado. Voltando para o Gestor Abner...</p><script>location.replace("/?calendar=connected")</script>'
      );
    } catch (error) {
      return html(
        res,
        500,
        `<p>Nao consegui concluir a conexao com o Google Calendar.</p><p>${escapeHtml(error.message)}</p><p><a href="/">Voltar</a></p>`
      );
    }
  }

  return html(res, 404, '<p>Rota nao encontrada.</p><p><a href="/">Voltar</a></p>');
}

async function handleApi(req, res, url) {
  const store = await readStore();
  const targetDate = url.searchParams.get('date') || todayISO();

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, await buildStatePayload(store, targetDate));
  }

  if (req.method === 'GET' && url.pathname === '/api/calendar/status') {
    return json(res, 200, await calendarOverlay(targetDate));
  }

  if (req.method === 'GET' && url.pathname === '/api/gemini/status') {
    return json(res, 200, await geminiStatus());
  }

  if (req.method === 'POST' && url.pathname === '/api/calendar/sync') {
    return json(res, 200, await buildStatePayload(store, targetDate, { forceCalendar: true }));
  }

  if (req.method === 'POST' && url.pathname === '/api/calendar/auto-reschedule') {
    try {
      const autoReschedule = await autoRescheduleGoogleConflicts(store, targetDate);
      autoReschedule.reason = 'manual';
      rememberAutoReschedule(store, autoReschedule);
      await writeStore(store);
      const payload = await buildStatePayload(store, targetDate, { forceCalendar: true });
      return json(res, 200, { ...payload, autoReschedule });
    } catch (error) {
      return json(res, 409, { error: error.message || 'Nao consegui reagendar conflitos da agenda.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/calendar/watch') {
    try {
      const watch = await registerGoogleCalendarWatch(store, { force: url.searchParams.get('force') === 'true' });
      await writeStore(store);
      const payload = await buildStatePayload(store, targetDate, { forceCalendar: true });
      return json(res, 200, { ...payload, watch });
    } catch (error) {
      return json(res, 409, { error: error.message || 'Nao consegui ativar notificacoes do Calendar.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/calendar/plan') {
    try {
      const sync = await syncPlanToGoogle(store, targetDate);
      await writeStore(store);
      const payload = await buildStatePayload(store, targetDate, { forceCalendar: true });
      return json(res, 200, { ...payload, calendarPlanSync: sync });
    } catch (error) {
      return json(res, 409, { error: error.message || 'Nao consegui criar os blocos no Google.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/calendar/disconnect') {
    if (store.settings?.googleCalendarWatch?.resourceId) {
      await stopGoogleCalendarWatch(store.settings.googleCalendarWatch);
    }
    await deleteGoogleToken();
    store.settings = { ...normalizeSettings(store.settings), googleCalendarWatch: null };
    await writeStore(store);
    calendarCache.clear();
    return json(res, 200, await buildStatePayload(store, targetDate));
  }

  if (req.method === 'POST' && url.pathname === '/api/busy-blocks') {
    const body = await readBody(req);
    const busyBlock = createBusyBlock(body, targetDate);
    const nextSettings = normalizeSettings(store.settings);
    nextSettings.busyBlocks.push(busyBlock);
    store.settings = nextSettings;
    await writeStore(store);
    return json(res, 201, {
      busyBlock,
      plan: buildPlan(store.tasks, store.settings, targetDate),
      busyBlocks: busyBlocksForDate(store.settings, targetDate)
    });
  }

  const busyMatch = url.pathname.match(/^\/api\/busy-blocks\/([^/]+)$/);
  if (busyMatch && req.method === 'DELETE') {
    const id = busyMatch[1];
    const nextSettings = normalizeSettings(store.settings);
    nextSettings.busyBlocks = nextSettings.busyBlocks.filter((block) => block.id !== id);
    store.settings = nextSettings;
    await writeStore(store);
    return json(res, 200, {
      plan: buildPlan(store.tasks, store.settings, targetDate),
      busyBlocks: busyBlocksForDate(store.settings, targetDate)
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readBody(req);
    if (!String(body.rawText || '').trim()) {
      return json(res, 422, { error: 'Descreva a demanda antes de lancar.' });
    }
    const task = await createEnhancedTask(body);
    store.tasks.unshift(task);
    await writeStore(store);
    return json(res, 201, { task: taskView(task, targetDate), plan: buildPlan(store.tasks, store.settings, targetDate) });
  }

  const enhanceMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/enhance$/);
  if (enhanceMatch && req.method === 'POST') {
    const id = enhanceMatch[1];
    const task = store.tasks.find((item) => item.id === id);
    if (!task) return json(res, 404, { error: 'Demanda nao encontrada.' });
    const result = await enhanceTaskWithGemini(task);
    if (result.missingConfig) return json(res, 409, { error: 'Gemini nao configurado.' });
    await writeStore(store);
    return json(res, 200, await buildStatePayload(store, targetDate));
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === 'PATCH') {
    const id = taskMatch[1];
    const body = await readBody(req);
    const task = store.tasks.find((item) => item.id === id);
    if (!task) return json(res, 404, { error: 'Demanda nao encontrada.' });
    applyTaskPatch(task, body);
    if (body.status === 'done') {
      try {
        await completeGoogleArtifacts(task);
      } catch (error) {
        const now = new Date().toISOString();
        task.googleSyncStatus = 'error';
        task.googleSyncError = error.message || 'Falha ao concluir no Google.';
        task.history = Array.isArray(task.history) ? task.history : [];
        task.history.push({ at: now, type: 'google-error', note: task.googleSyncError });
      }
    }
    await writeStore(store);
    return json(res, 200, await buildStatePayload(store, targetDate));
  }

  const checkinMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/checkin$/);
  if (checkinMatch && req.method === 'POST') {
    const id = checkinMatch[1];
    const body = await readBody(req);
    const task = store.tasks.find((item) => item.id === id);
    if (!task) return json(res, 404, { error: 'Demanda nao encontrada.' });
    const created = applyCheckin(store, task, body);
    await writeStore(store);
    return json(res, 200, {
      task: taskView(task, targetDate),
      created: created ? taskView(created, targetDate) : null,
      plan: buildPlan(store.tasks, store.settings, targetDate)
    });
  }

  return json(res, 404, { error: 'Rota nao encontrada.' });
}

function applyTaskPatch(task, body) {
  const now = new Date().toISOString();
  if (body.status === 'done') {
    task.status = 'done';
    task.completedAt = now;
    task.history.push({ at: now, type: 'done', note: 'demanda concluida' });
  }
  if (body.status === 'active') {
    task.status = 'active';
    task.completedAt = null;
    task.history.push({ at: now, type: 'active', note: 'demanda reaberta' });
  }
  if (body.status === 'archived') {
    task.status = 'archived';
    task.history.push({ at: now, type: 'archived', note: 'demanda arquivada' });
  }
  if (body.plan === 'next-week') {
    task.status = 'active';
    task.urgency = 'later';
    task.plannedFor = nextWeekStartISO();
    task.dueDate = addDaysISO(nextWeekStartISO(), 4);
    task.postponedCount = (task.postponedCount || 0) + 1;
    task.history.push({ at: now, type: 'plan', note: 'movida para proxima semana mantendo prioridade alta' });
  }
  if (body.plan === 'this-week') {
    task.status = 'active';
    task.urgency = task.urgency === 'later' ? 'high' : task.urgency;
    task.plannedFor = null;
    task.dueDate = todayISO();
    task.history.push({ at: now, type: 'plan', note: 'trazida para a semana atual' });
  }
  if (body.urgency && urgencyConfig[body.urgency]) {
    task.urgency = body.urgency;
    task.plannedFor = body.urgency === 'later' ? nextWeekStartISO() : null;
    task.history.push({ at: now, type: 'urgency', note: `urgencia alterada para ${urgencyConfig[body.urgency].label}` });
  }
  if (body.accountId && accountMap.has(body.accountId)) {
    const account = accountMap.get(body.accountId);
    task.accountId = account.id;
    task.accountLabel = account.label;
    task.accountType = account.type;
    task.accountSource = 'manual';
    task.project = account.label;
    task.decision = { ...(task.decision || {}), account: `conta marcada como ${account.label}` };
    task.history.push({ at: now, type: 'account', note: `conta alterada para ${account.label}` });
  }
  if (body.dueDate) {
    task.dueDate = body.dueDate;
    task.history.push({ at: now, type: 'due-date', note: `prazo alterado para ${body.dueDate}` });
  }
  task.updatedAt = now;
}

function applyCheckin(store, task, body) {
  const now = new Date().toISOString();
  const reason = cleanupTitle(body.reason || 'sem motivo informado');
  const action = body.action || 'tomorrow';
  task.history.push({ at: now, type: 'checkin', note: reason });

  if (action === 'today') {
    task.dueDate = todayISO();
    task.plannedFor = null;
    task.postponedCount = (task.postponedCount || 0) + 1;
    task.history.push({ at: now, type: 'reschedule', note: 'replanejada para hoje' });
  }
  if (action === 'tomorrow') {
    task.dueDate = addDaysISO(todayISO(), 1);
    task.plannedFor = null;
    task.postponedCount = (task.postponedCount || 0) + 1;
    task.history.push({ at: now, type: 'reschedule', note: 'replanejada para amanha' });
  }
  if (action === 'next-week') {
    task.urgency = 'later';
    task.plannedFor = nextWeekStartISO();
    task.dueDate = addDaysISO(nextWeekStartISO(), 4);
    task.postponedCount = (task.postponedCount || 0) + 1;
    task.history.push({ at: now, type: 'reschedule', note: 'movida para proxima semana mantendo prioridade alta' });
  }
  if (action === 'low') {
    task.urgency = 'low';
    task.plannedFor = null;
    task.dueDate = addDaysISO(todayISO(), 14);
    task.postponedCount = (task.postponedCount || 0) + 1;
    task.history.push({ at: now, type: 'reschedule', note: 'movida para baixa prioridade' });
  }
  if (action === 'blocked') {
    task.blockedCount = (task.blockedCount || 0) + 1;
    task.history.push({ at: now, type: 'blocked', note: 'marcada como travada' });
  }
  if (action === 'split') {
    task.blockedCount = (task.blockedCount || 0) + 1;
    const firstStep = createTask({
      rawText: `Primeiro passo de "${task.title}": ${reason}`,
      urgency: task.urgency === 'low' ? 'normal' : task.urgency,
      accountId: task.accountId
    });
    firstStep.project = task.project;
    firstStep.accountId = task.accountId;
    firstStep.accountLabel = task.accountLabel;
    firstStep.accountType = task.accountType;
    firstStep.accountSource = task.accountSource;
    firstStep.dueDate = todayISO();
    firstStep.effortMinutes = 30;
    firstStep.history.push({ at: now, type: 'split-from', note: task.id });
    store.tasks.unshift(firstStep);
    task.history.push({ at: now, type: 'split', note: `primeiro passo criado: ${firstStep.title}` });
    task.updatedAt = now;
    return firstStep;
  }

  task.updatedAt = now;
  return null;
}

async function serveStatic(req, res, url) {
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/') filePath = '/index.html';
  const safePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const finalPath = path.join(publicDir, safePath);

  if (!finalPath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const fileStat = await stat(finalPath);
    if (!fileStat.isFile()) throw new Error('not a file');
    const ext = path.extname(finalPath);
    res.writeHead(200, { 'content-type': contentTypes[ext] || 'application/octet-stream' });
    createReadStream(finalPath).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

async function handleGoogleCalendarWebhook(req, res) {
  const store = await readStore();
  const watch = normalizeSettings(store.settings).googleCalendarWatch || {};
  const channelId = req.headers['x-goog-channel-id'];
  const channelToken = req.headers['x-goog-channel-token'];
  const resourceState = req.headers['x-goog-resource-state'];
  const valid = watch.channelId && watch.token && channelId === watch.channelId && channelToken === watch.token;

  res.writeHead(valid ? 204 : 401);
  res.end();

  if (!valid || resourceState === 'sync') return;
  setTimeout(() => {
    autoRescheduleTick('webhook');
  }, 1000);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === GOOGLE_CALENDAR_WEBHOOK_PATH) {
      await handleGoogleCalendarWebhook(req, res);
      return;
    }
    if (url.pathname.startsWith('/auth/google')) {
      await handleGoogleAuth(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'Erro interno.' });
  }
});

async function autoRescheduleTick(reason = 'interval') {
  if (!autoRescheduleEnabled() || autoRescheduleInFlight) return;
  autoRescheduleInFlight = true;
  try {
    const store = await readStore();
    const result = await autoRescheduleGoogleConflicts(store, todayISO());
    result.reason = reason;
    if (result.moved || result.error || reason === 'webhook') {
      rememberAutoReschedule(store, result);
      await writeStore(store);
    }
    if (result.moved) {
      console.log(`Auto-reagendamento moveu ${result.moved} demanda(s) por conflito no Google Calendar.`);
    }
  } catch (error) {
    console.error('Falha no auto-reagendamento:', error.message || error);
  } finally {
    autoRescheduleInFlight = false;
  }
}

function startAutoRescheduler() {
  if (!autoRescheduleEnabled()) return;
  setTimeout(() => {
    autoRescheduleTick('startup');
  }, 15000);
  setInterval(() => {
    autoRescheduleTick('interval');
  }, AUTO_RESCHEDULE_INTERVAL_MS);
}

await ensureStore();

server.listen(port, () => {
  console.log(`Gestor Abner rodando em http://localhost:${port}`);
  startAutoRescheduler();
});
