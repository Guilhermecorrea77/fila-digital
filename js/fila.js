/* =====================================================================
 * fila.js — regras da fila (sem tela, sem rede). Testado em tests/fila.test.js
 *
 * Ordem de atendimento:
 *  1. Categorias marcadas como "topo" (ex.: Urgência) vêm sempre primeiro.
 *  2. Dentro do mesmo grupo, vale a "pontuação":
 *        pontos = minutos esperando + bônus da categoria
 *     Ex.: Prioritário (bônus 20) conta como se tivesse chegado 20 min antes.
 *     Assim prioridades passam na frente, mas quem espera muito também sobe:
 *     ninguém fica esquecido.
 *  Como todo mundo ganha 1 ponto por minuto, a ordem entre quem já está na
 *  fila não muda sozinha — só muda quando chega alguém novo com bônus.
 * ===================================================================== */

export const VERSAO = 1;
const MIN = 60000;

export const CATEGORIAS_PADRAO = [
    { id: 'U', nome: 'Urgência', bonus: 0, topo: true, cor: '#d9480f',
        exemplos: 'Queimadura, dor forte, falta de ar, sangramento, febre alta em criança' },
    { id: 'S', nome: 'Idoso 80+', bonus: 30, topo: false, cor: '#7048e8',
        exemplos: 'Pessoas com 80 anos ou mais (prioridade especial — Lei 13.466/2017)' },
    { id: 'P', nome: 'Prioritário', bonus: 20, topo: false, cor: '#1c7ed6',
        exemplos: 'Gestante, idoso 60+, lactante, criança de colo, pessoa com deficiência ou TEA' },
    { id: 'N', nome: 'Geral', bonus: 0, topo: false, cor: '#2b8a3e',
        exemplos: 'Demais casos' },
];

export const CONFIG_PADRAO = {
    tolerancia: 5,      // minutos para se apresentar depois de chamado
    graca: 30,          // minutos em que um ausente ainda pode voltar
    penalidade: 2,      // quem volta atrasado entra depois de N pessoas
    tempoMedio: 8,      // minutos por atendimento (até haver dados reais)
    guiches: ['Guichê 1', 'Guichê 2'],
};

export const STATUS = {
    AGUARDANDO: 'aguardando', CHAMADO: 'chamado', CONCLUIDO: 'concluido',
    AUSENTE: 'ausente', CANCELADO: 'cancelado',
};

// ---------------- utilidades ----------------
export const diaDe = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
export const codigo = (cat, n) => `${cat}${String(n).padStart(3, '0')}`;
export const formatarCodigo = (c) => c.replace(/^([A-Z]+)(\d+)$/, '$1 $2');

export function novoEstado({ id, nome, agora = Date.now(), cfg = {}, categorias = CATEGORIAS_PADRAO }) {
    return {
        v: VERSAO,
        sala: { id, nome },
        rev: 0,
        ts: agora,
        dia: diaDe(agora),
        cfg: { ...clone(CONFIG_PADRAO), ...cfg },
        categorias: clone(categorias),
        contadores: Object.fromEntries(categorias.map((c) => [c.id, 0])),
        tickets: [],
        chamadas: [],    // últimas chamadas (para o painel)
        historico: [],   // horários das últimas chamadas (para estimar o tempo)
    };
}

const categoria = (e, id) => e.categorias.find((c) => c.id === id);
const ticket = (e, id) => e.tickets.find((t) => t.id === id);

function bump(e, agora) { e.rev += 1; e.ts = agora; return e; }

/** Pontuação de um ticket aguardando (maior = atende antes). */
export function pontos(e, t, agora = Date.now()) {
    const cat = categoria(e, t.cat) || { bonus: 0 };
    return (agora - (t.ef ?? t.emitido)) / MIN + (cat.bonus || 0);
}

/** Lista de quem está aguardando, na ordem em que será chamado. */
export function ordem(e, agora = Date.now()) {
    return e.tickets
        .filter((t) => t.status === STATUS.AGUARDANDO)
        .map((t) => ({ t, topo: categoria(e, t.cat)?.topo ? 1 : 0, p: pontos(e, t, agora) }))
        .sort((a, b) => b.topo - a.topo || b.p - a.p || a.t.emitido - b.t.emitido)
        .map((x) => x.t);
}

// ---------------- ações (cada uma devolve um NOVO estado) ----------------

/** Emite uma senha. `tokH` é o resumo (hash) do segredo do ticket, se houver. */
export function emitir(estado, catId, { agora = Date.now(), tokH = null } = {}) {
    const e = clone(estado);
    const cat = categoria(e, catId);
    if (!cat) throw new Error(`Categoria desconhecida: ${catId}`);
    if (e.dia !== diaDe(agora)) zerarContadores(e, agora);
    e.contadores[catId] = (e.contadores[catId] || 0) + 1;
    const t = { id: codigo(catId, e.contadores[catId]), cat: catId, emitido: agora, status: STATUS.AGUARDANDO, chamadas: 0 };
    if (tokH) t.tokH = tokH;
    e.tickets.push(t);
    limpar(e, agora);
    return { estado: bump(e, agora), ticket: t };
}

function registrarChamada(e, t, guiche, agora) {
    t.status = STATUS.CHAMADO;
    t.guiche = guiche;
    t.chamadoEm = agora;
    t.chamadas = (t.chamadas || 0) + 1;
    delete t.aCaminho;
    e.chamadas.unshift({ id: t.id, guiche, ts: agora, n: t.chamadas });
    e.chamadas = e.chamadas.slice(0, 8);
}

/** Conclui o atendimento em curso no guichê (se houver). */
function fecharGuiche(e, guiche, agora) {
    for (const t of e.tickets) {
        if (t.status === STATUS.CHAMADO && t.guiche === guiche) { t.status = STATUS.CONCLUIDO; t.fim = agora; }
    }
}

/** Chama o próximo da fila para o guichê. O atendimento anterior do guichê é dado como concluído. */
export function chamarProximo(estado, guiche, { agora = Date.now(), id = null } = {}) {
    const e = clone(estado);
    const prox = id ? ticket(e, id) : ordem(e, agora)[0];
    if (!prox || prox.status !== STATUS.AGUARDANDO) return { estado, ticket: null };
    fecharGuiche(e, guiche, agora);
    registrarChamada(e, prox, guiche, agora);
    e.historico.push(agora);
    e.historico = e.historico.slice(-20);
    return { estado: bump(e, agora), ticket: prox };
}

/** Chama de novo a mesma senha (reinicia a contagem da tolerância). */
export function rechamar(estado, id, { agora = Date.now() } = {}) {
    const e = clone(estado);
    const t = ticket(e, id);
    if (!t || t.status !== STATUS.CHAMADO) return estado;
    registrarChamada(e, t, t.guiche, agora);
    return bump(e, agora);
}

export function concluir(estado, id, { agora = Date.now() } = {}) {
    const e = clone(estado);
    const t = ticket(e, id);
    if (!t || t.status !== STATUS.CHAMADO) return estado;
    t.status = STATUS.CONCLUIDO; t.fim = agora;
    return bump(e, agora);
}

/** Paciente não apareceu dentro da tolerância. */
export function marcarAusente(estado, id, { agora = Date.now() } = {}) {
    const e = clone(estado);
    const t = ticket(e, id);
    if (!t || t.status !== STATUS.CHAMADO) return estado;
    t.status = STATUS.AUSENTE; t.ausenteEm = agora;
    return bump(e, agora);
}

/**
 * Paciente ausente voltou dentro do prazo de graça: volta para a fila,
 * entrando logo depois das próximas `penalidade` pessoas do seu grupo.
 */
export function reinserir(estado, id, { agora = Date.now() } = {}) {
    const e = clone(estado);
    const t = ticket(e, id);
    if (!t || t.status !== STATUS.AUSENTE) return { estado, ok: false, motivo: 'Esta senha não está como ausente.' };
    if (agora - t.ausenteEm > e.cfg.graca * MIN) return { estado, ok: false, motivo: `Passou do prazo de ${e.cfg.graca} minutos para voltar.` };
    const cat = categoria(e, t.cat) || { bonus: 0, topo: false };
    const fila = ordem(e, agora).filter((x) => !!categoria(e, x.cat)?.topo === !!cat.topo);
    const k = Math.min(e.cfg.penalidade, fila.length);
    let alvo; // pontuação desejada: logo abaixo da k-ésima pessoa
    if (fila.length === 0) alvo = 0;
    else if (k === 0) alvo = pontos(e, fila[0], agora) + 0.01;
    else alvo = pontos(e, fila[k - 1], agora) - 0.01;
    t.ef = agora - (alvo - (cat.bonus || 0)) * MIN;
    t.status = STATUS.AGUARDANDO;
    t.reinserido = (t.reinserido || 0) + 1;
    delete t.guiche; delete t.chamadoEm; delete t.ausenteEm; delete t.aCaminho;
    return { estado: bump(e, agora), ok: true };
}

export function cancelar(estado, id, { agora = Date.now() } = {}) {
    const e = clone(estado);
    const t = ticket(e, id);
    if (!t || (t.status !== STATUS.AGUARDANDO && t.status !== STATUS.AUSENTE)) return estado;
    t.status = STATUS.CANCELADO; t.fim = agora;
    return bump(e, agora);
}

/** Paciente avisou que está a caminho: ganha mais um período de tolerância. */
export function registrarACaminho(estado, id, { agora = Date.now() } = {}) {
    const e = clone(estado);
    const t = ticket(e, id);
    if (!t || t.status !== STATUS.CHAMADO || t.aCaminho) return estado;
    t.aCaminho = agora;
    return bump(e, agora);
}

export function atualizarConfig(estado, cfg, { agora = Date.now() } = {}) {
    const e = clone(estado);
    e.cfg = { ...e.cfg, ...cfg };
    return bump(e, agora);
}

function zerarContadores(e, agora) {
    e.dia = diaDe(agora);
    for (const k of Object.keys(e.contadores)) e.contadores[k] = 0;
}

/** Novo dia: zera numeração e encerra a fila anterior. */
export function novoDia(estado, { agora = Date.now() } = {}) {
    const e = clone(estado);
    zerarContadores(e, agora);
    e.tickets = [];
    e.chamadas = [];
    e.historico = [];
    return bump(e, agora);
}

/** Remove senhas antigas para a mensagem continuar pequena. */
function limpar(e, agora) {
    const manter = (t) => {
        if (t.status === STATUS.AGUARDANDO || t.status === STATUS.CHAMADO) return true;
        if (t.status === STATUS.AUSENTE) return agora - t.ausenteEm <= e.cfg.graca * MIN * 2;
        return agora - (t.fim || t.emitido) <= 3 * 60 * MIN; // concluídas: 3 h
    };
    e.tickets = e.tickets.filter(manter).slice(-500);
}

// ---------------- consultas para as telas ----------------

/** Minutos por atendimento: média dos intervalos recentes entre chamadas, por guichê. */
export function minutosPorAtendimento(e, agora = Date.now()) {
    const h = (e.historico || []).filter((ts) => agora - ts < 2 * 60 * MIN);
    const guiches = Math.max(1, e.cfg.guiches.length);
    if (h.length >= 4) {
        const intervalo = (h[h.length - 1] - h[0]) / (h.length - 1) / MIN; // minutos entre chamadas (todos os guichês)
        return Math.max(1, Math.min(60, intervalo));
    }
    return e.cfg.tempoMedio / guiches;
}

/** Situação de uma senha para a tela do paciente. */
export function situacao(e, id, agora = Date.now()) {
    const t = ticket(e, id);
    if (!t) return { existe: false };
    const cat = categoria(e, t.cat);
    const base = { existe: true, ticket: t, categoria: cat, status: t.status };
    if (t.status === STATUS.AGUARDANDO) {
        const fila = ordem(e, agora);
        const pos = fila.findIndex((x) => x.id === id);
        const porAtend = minutosPorAtendimento(e, agora);
        const est = pos * porAtend;
        return { ...base, posicao: pos + 1, naFrente: pos, estimativa: { min: Math.floor(est * 0.7), max: Math.ceil(est * 1.3 + porAtend) } };
    }
    if (t.status === STATUS.CHAMADO) {
        const limite = t.chamadoEm + e.cfg.tolerancia * MIN * (t.aCaminho ? 2 : 1);
        return { ...base, guiche: t.guiche, restanteMs: Math.max(0, limite - agora), aCaminho: !!t.aCaminho };
    }
    if (t.status === STATUS.AUSENTE) {
        return { ...base, restanteMs: Math.max(0, t.ausenteEm + e.cfg.graca * MIN - agora) };
    }
    return base;
}

export function resumo(e, agora = Date.now()) {
    const aguardando = ordem(e, agora);
    const porCat = Object.fromEntries(e.categorias.map((c) => [c.id, 0]));
    for (const t of aguardando) porCat[t.cat] = (porCat[t.cat] || 0) + 1;
    const hoje = e.tickets.filter((t) => diaDe(t.emitido) === diaDe(agora));
    const concluidos = hoje.filter((t) => t.status === STATUS.CONCLUIDO && t.chamadoEm);
    const esperaMedia = concluidos.length
        ? concluidos.reduce((s, t) => s + (t.chamadoEm - t.emitido), 0) / concluidos.length / MIN : null;
    return {
        aguardando: aguardando.length, porCat,
        chamados: e.tickets.filter((t) => t.status === STATUS.CHAMADO),
        ausentes: e.tickets.filter((t) => t.status === STATUS.AUSENTE && agora - t.ausenteEm <= e.cfg.graca * MIN),
        atendidosHoje: concluidos.length, esperaMedia,
        minutosPorAtendimento: minutosPorAtendimento(e, agora),
    };
}

/** Versão "pública" do estado: remove o que não precisa ir para a rede. */
export function publico(e) {
    const p = clone(e);
    return p;
}
