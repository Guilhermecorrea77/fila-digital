/* sala.js — página do paciente: acompanha a senha pelo celular. */
import * as F from './fila.js';
import { conectar } from './sync.js';
import { $, esc, fmtDuracao, fmtMinutos, fmtHora, lerParametros, statusConexao, tocarAlerta, vibrar, falar, liberarAudio, textoChamada } from './ui.js';
import { escanear } from './scanner.js';

const app = $('#app');
const MIN = 60000;
const p = lerParametros();
const ler = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* nada */ } };

let estado = null;
let conexao = null;
let recebidoEm = 0;
let status = 'conectando';
let minha = null;               // { t, x }
let avisos = ler('fd-avisos') || { ativo: false, faltando: 3 };
let ultimaSituacao = null;      // para detectar mudanças e avisar
let jaAvisouPerto = false;
let wakeLock = null;
let erroSenha = '';
let enviouCaminho = false;

// ===================== sem sala: escanear QR =====================
function telaEscanear(msg = '') {
    $('#nome-sala').textContent = 'Fila Digital';
    app.innerHTML = `
        <section class="card" style="text-align:center">
            <h1>Escaneie o QR code da sala</h1>
            <p class="mini">Ele fica no cartaz da sala de espera ou no papel da sua senha.</p>
            ${msg ? `<p class="aviso-saude">${esc(msg)}</p>` : ''}
            <div id="area-camera" style="margin:1rem 0"></div>
            <button type="button" class="btn btn-pri btn-grande btn-bloco" id="btn-camera">📷 Abrir câmera</button>
            <p class="mini" style="margin-top:1rem">Dica: o app de câmera do próprio celular também lê o QR — é só apontar e tocar no link.</p>
        </section>`;
    $('#btn-camera').addEventListener('click', async (e) => {
        e.target.hidden = true;
        try {
            await escanear($('#area-camera'), (texto) => {
                try {
                    const u = new URL(texto);
                    if (u.searchParams.get('s') && u.searchParams.get('k')) { location.href = texto; return; }
                } catch (err) { /* não é link */ }
                telaEscanear('Esse QR code não é de uma fila digital. Tente o do cartaz da sala.');
            });
        } catch (err) {
            e.target.hidden = false;
            $('#area-camera').innerHTML = `<p class="aviso-saude">${esc(err.message || 'Não foi possível abrir a câmera.')}</p>`;
        }
    });
}

// ===================== com sala =====================
async function iniciar() {
    const chave = `fd-minha-${p.salaId}`;
    if (p.ticket) { minha = { t: p.ticket, x: p.token || null }; gravar(chave, minha); }
    else minha = ler(chave);
    render();
    conexao = await conectar({
        salaId: p.salaId, pub: p.pub, broker: p.broker,
        aoEstado: (e) => { estado = e; recebidoEm = Date.now(); render(); },
        aoStatus: (s) => { status = s; statusConexao($('#conexao'), s); },
    });
    setInterval(tick, 1000);
    setInterval(render, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); pedirWakeLock(); } });
}

const cat = (id) => estado?.categorias.find((c) => c.id === id) || { nome: id, cor: '#888' };
const chip = (id) => { const c = cat(id); return `<span class="cat-chip" style="--cor:${c.cor}">${esc(c.nome)}</span>`; };

function cartaoMinha(agora) {
    if (!minha) {
        return `<section class="card minha">
            <h2>Qual é a sua senha?</h2>
            <p class="mini">Está no papel que a recepção entregou (ex.: P 012).</p>
            <form id="form-senha" class="digitar-senha">
                <label for="inp-senha" class="sr-only">Sua senha</label>
                <input type="text" id="inp-senha" placeholder="P 012" autocomplete="off" autocapitalize="characters" maxlength="8" required>
                <button class="btn btn-pri" type="submit">Acompanhar</button>
            </form>
            ${erroSenha ? `<p class="mini" style="color:var(--perigo);margin-top:.5rem">${esc(erroSenha)}</p>` : ''}
        </section>`;
    }
    const codigo = esc(F.formatarCodigo(minha.t));
    if (!estado) return `<section class="card minha"><p class="rotulo">Sua senha</p><p class="meu-cod senha-cod">${codigo}</p><p class="mini">Buscando a fila…</p></section>`;
    const s = F.situacao(estado, minha.t, agora);
    const trocar = '<p style="margin-top:.75rem"><button type="button" class="btn btn-peq" id="btn-trocar">Trocar de senha</button></p>';
    if (!s.existe) {
        return `<section class="card minha ausente"><p class="rotulo">Sua senha</p><p class="meu-cod senha-cod">${codigo}</p>
            <p>Não encontramos esta senha na fila de hoje. Confira o papel ou fale com a recepção.</p>${trocar}</section>`;
    }
    if (s.status === F.STATUS.AGUARDANDO) {
        const total = F.ordem(estado, agora).length;
        const pct = total > 1 ? Math.round((1 - s.naFrente / (total - 1)) * 100) : 100;
        return `<section class="card minha" aria-live="polite">
            <p class="rotulo">Sua senha</p>
            <p class="meu-cod senha-cod">${codigo}</p>
            <p>${chip(s.ticket.cat)}</p>
            <div class="posicao">
                <div><b>${s.naFrente}</b><span>${s.naFrente === 1 ? 'pessoa na sua frente' : 'pessoas na sua frente'}</span></div>
                <div><b>${s.naFrente === 0 ? 'Você é o próximo!' : `${s.estimativa.min}–${s.estimativa.max}`}</b><span>${s.naFrente === 0 ? 'fique por perto' : 'minutos (estimativa)'}</span></div>
            </div>
            <div class="barra-prog" aria-hidden="true"><i style="width:${pct}%"></i></div>
            <p class="mini" style="margin-top:.75rem">A ordem pode mudar se chegarem casos urgentes ou prioritários.</p>
            ${trocar}
        </section>`;
    }
    if (s.status === F.STATUS.CHAMADO) {
        return `<section class="card minha chamado" role="alert">
            <p class="rotulo">Sua senha foi chamada!</p>
            <p class="meu-cod senha-cod">${codigo}</p>
            <p class="grande">Dirija-se ao ${esc(s.guiche)}</p>
            <p>Você tem <span class="contagem" data-limite="${agora + s.restanteMs}"></span> para se apresentar.</p>
            ${minha.x ? (s.aCaminho || enviouCaminho
                ? '<p class="alertas-ok">✓ A recepção sabe que você está a caminho.</p>'
                : '<button type="button" class="btn btn-pri btn-grande btn-bloco" id="btn-caminho">🚶 Estou a caminho</button><p class="mini" style="margin-top:.5rem">Avisa a recepção e dobra o seu tempo de tolerância.</p>') : ''}
        </section>`;
    }
    if (s.status === F.STATUS.AUSENTE) {
        return `<section class="card minha ausente" role="alert">
            <p class="rotulo">Sua senha</p><p class="meu-cod senha-cod">${codigo}</p>
            <p class="grande">Você foi chamado e não compareceu</p>
            ${s.restanteMs > 0
                ? `<p>Procure a recepção em até <b><span class="contagem" data-limite="${agora + s.restanteMs}"></span></b> para voltar à fila.</p>`
                : '<p>O prazo para voltar acabou. Procure a recepção.</p>'}
        </section>`;
    }
    if (s.status === F.STATUS.CONCLUIDO) {
        return `<section class="card minha concluido"><p class="rotulo">Sua senha</p><p class="meu-cod senha-cod">${codigo}</p>
            <p class="grande">Atendimento iniciado ✓</p><p class="mini">Obrigado por usar a fila digital.</p>${trocar}</section>`;
    }
    return `<section class="card minha"><p class="rotulo">Sua senha</p><p class="meu-cod senha-cod">${codigo}</p><p>Esta senha foi cancelada. Fale com a recepção.</p>${trocar}</section>`;
}

function render() {
    const agora = Date.now();
    if (estado) {
        $('#nome-sala').textContent = estado.sala.nome;
        document.title = `${estado.sala.nome} — Fila Digital`;
    }
    avisarSeMudou(agora);
    const r = estado ? F.resumo(estado, agora) : null;
    const semSinal = estado && status === 'online' && agora - Math.max(recebidoEm, estado.ts) > 3 * MIN;

    // preserva o que a pessoa está digitando (a tela é redesenhada a cada atualização)
    const inp = $('#inp-senha');
    const digitando = inp ? { v: inp.value, foco: document.activeElement === inp } : null;

    app.innerHTML = `
        ${cartaoMinha(agora)}
        ${semSinal ? '<p class="aviso-saude">⚠️ A recepção não atualiza a fila há alguns minutos. Se estiver em dúvida, confira com a recepção.</p>' : ''}

        <section class="card chamando" aria-labelledby="t-cham">
            <h2 id="t-cham">Chamando agora</h2>
            ${estado?.chamadas.length ? `<div class="chamando-lista">${estado.chamadas.slice(0, 4).map((c, i) => `
                <div class="chamada ${i === 0 ? 'primeira' : ''}"><span class="senha-cod">${esc(F.formatarCodigo(c.id))}</span><span>${esc(c.guiche)} · ${fmtHora(c.ts)}</span></div>`).join('')}</div>`
            : `<p class="vazio">${estado ? 'Nenhuma senha chamada ainda.' : 'Conectando à fila…'}</p>`}
        </section>

        ${r ? `<section class="card" aria-labelledby="t-fila">
            <h2 id="t-fila">Fila agora</h2>
            <p><b>${r.aguardando}</b> ${r.aguardando === 1 ? 'pessoa aguardando' : 'pessoas aguardando'} · cerca de ${fmtMinutos(r.minutosPorAtendimento)} entre chamadas</p>
            <p class="mini">${estado.categorias.map((c) => `${chip(c.id)} ${r.porCat[c.id] || 0}`).join(' &nbsp; ')}</p>
        </section>` : ''}

        <section class="card" aria-labelledby="t-av">
            <h2 id="t-av">🔔 Avisos</h2>
            ${avisos.ativo
                ? `<p class="alertas-ok">✓ Avisos ligados: som e vibração quando você for chamado${avisos.faltando ? ` e quando faltarem ${avisos.faltando}` : ''}.</p>
                   <div class="linha-btns"><button type="button" class="btn btn-peq" id="btn-testar">Testar som</button>
                   <label class="btn btn-peq" style="margin:0;font-weight:600"><input type="checkbox" id="chk-tela" ${wakeLock ? 'checked' : ''}> Manter tela ligada</label></div>`
                : `<p class="mini">Ative para o celular tocar e vibrar quando for a sua vez.</p>
                   <button type="button" class="btn btn-pri btn-bloco" id="btn-avisos">Ativar avisos</button>`}
            <p class="mini" style="margin-top:.75rem">Deixe esta página aberta. Se o celular bloquear a tela, alguns aparelhos param de avisar — confira de vez em quando.</p>
        </section>

        <p class="aviso-saude">Se os seus sintomas piorarem enquanto espera, <b>avise a recepção imediatamente</b>.</p>
        <p class="mini" style="text-align:center;margin-top:1rem">${estado ? `Atualizado às ${fmtHora(Math.max(recebidoEm, estado.ts))}` : ''} · <a href="sala.html">Escanear outra sala</a></p>`;
    if (digitando && $('#inp-senha')) {
        $('#inp-senha').value = digitando.v;
        if (digitando.foco) $('#inp-senha').focus();
    }
    ligar();
    tick();
}

function tick() {
    const agora = Date.now();
    app.querySelectorAll('[data-limite]').forEach((el) => {
        const rest = Number(el.dataset.limite) - agora;
        el.textContent = rest > 0 ? fmtDuracao(rest) : '0:00';
    });
}

function ligar() {
    $('#form-senha')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const t = $('#inp-senha').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const m = t.match(/^([A-Z]+)(\d{1,4})$/);
        if (!m) { erroSenha = 'Digite a letra e o número, como no papel (ex.: P 012).'; render(); return; }
        const id = F.codigo(m[1], Number(m[2]));
        if (estado && !estado.tickets.some((x) => x.id === id)) { erroSenha = `Não achamos a senha ${F.formatarCodigo(id)} na fila de hoje. Confira o papel.`; render(); return; }
        erroSenha = '';
        minha = { t: id, x: null };
        gravar(`fd-minha-${p.salaId}`, minha);
        ultimaSituacao = null; jaAvisouPerto = false;
        render();
    });
    $('#btn-trocar')?.addEventListener('click', () => {
        minha = null; localStorage.removeItem(`fd-minha-${p.salaId}`);
        history.replaceState(null, '', `sala.html?${new URLSearchParams({ s: p.salaId, k: p.pub, ...(p.broker && location.search.includes('b=') ? { b: p.broker } : {}) })}`);
        render();
    });
    $('#btn-caminho')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        try { await conexao.enviarSinal({ tipo: 'a-caminho', id: minha.t, tok: minha.x }); enviouCaminho = true; } catch (err) { e.target.disabled = false; }
        render();
    });
    $('#btn-avisos')?.addEventListener('click', ativarAvisos);
    $('#btn-testar')?.addEventListener('click', () => { tocarAlerta(1); vibrar([200]); });
    $('#chk-tela')?.addEventListener('change', async (e) => {
        if (e.target.checked) await pedirWakeLock(true); else { await wakeLock?.release(); wakeLock = null; }
        render();
    });
}

async function ativarAvisos() {
    liberarAudio();
    tocarAlerta(1);
    vibrar([200]);
    try { if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); } catch (e) { /* nada */ }
    avisos = { ativo: true, faltando: 3 };
    gravar('fd-avisos', avisos);
    await pedirWakeLock(true);
    render();
}

async function pedirWakeLock(forcar = false) {
    if (!('wakeLock' in navigator) || (!forcar && !wakeLock)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch (e) { wakeLock = null; }
}

function notificar(titulo, corpo) {
    try {
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(titulo, { body: corpo, tag: 'fila-digital', renotify: true });
    } catch (e) { /* nada */ }
}

let piscaTitulo = null;
function piscar(texto) {
    clearInterval(piscaTitulo);
    const original = document.title;
    let n = 0;
    piscaTitulo = setInterval(() => {
        document.title = n++ % 2 ? original : texto;
        if (n > 20 || !document.hidden) { clearInterval(piscaTitulo); document.title = original; }
    }, 1000);
}

/** Compara a situação atual com a anterior e dispara os avisos. */
function avisarSeMudou(agora) {
    if (!estado || !minha) return;
    const s = F.situacao(estado, minha.t, agora);
    const antes = ultimaSituacao;
    ultimaSituacao = { status: s.status, chamadas: s.ticket?.chamadas || 0, naFrente: s.naFrente };
    if (!antes) return; // primeira leitura: não toca
    const chamouAgora = s.status === F.STATUS.CHAMADO && (antes.status !== F.STATUS.CHAMADO || ultimaSituacao.chamadas > antes.chamadas);
    if (chamouAgora) {
        enviouCaminho = false;
        tocarAlerta(3);
        vibrar();
        falar(`Sua senha foi chamada. ${textoChamada(minha.t, s.guiche)}`);
        notificar(`É a sua vez! ${F.formatarCodigo(minha.t)}`, `Dirija-se ao ${s.guiche}.`);
        piscar(`🔔 ${s.guiche}!`);
        return;
    }
    if (s.status === F.STATUS.AGUARDANDO && avisos.faltando && s.naFrente <= avisos.faltando && !jaAvisouPerto
        && (antes.naFrente === undefined || antes.naFrente > s.naFrente)) {
        jaAvisouPerto = true;
        tocarAlerta(1);
        vibrar([250, 100, 250]);
        notificar('Está chegando a sua vez', s.naFrente === 0 ? 'Você é o próximo!' : `Faltam ${s.naFrente} pessoas.`);
    }
}

if (p.salaId && p.pub) iniciar(); else telaEscanear();
